import type { Types } from "mongoose";

import {
  type GoogleVerifiedIdentity,
  splitGoogleName,
} from "../../common/oauth/google-identity.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { createOpaqueToken, normalizeEmail, safeCompare } from "../auth/auth.utils.js";
import { type AuthResult, issueAuthSession, type RequestContext } from "../auth/auth-session.js";
import type { TokenService } from "../auth/token.service.js";
import type { BusinessVisitType } from "../business/business.types.js";
import type { BusinessOnboardingService } from "../business-onboarding/business-onboarding.service.js";
import type { LinkedAccountRepository } from "../linked-account/linked-account.repository.js";
import type { RegistrationSessionRepository } from "../registration-session/registration-session.repository.js";
import type { UserRepository } from "../user/user.repository.js";
import {
  buildProfessionalGoogleAuthUrl,
  resolveProfessionalGoogleIdentity,
} from "./professional-google-auth.client.js";
import {
  signProfessionalGoogleState,
  verifyProfessionalGoogleState,
} from "./professional-google-auth.state.js";

const GOOGLE_PROVIDER = "GOOGLE" as const;
const MS_PER_HOUR = 60 * 60 * 1000;

export type ProfessionalGoogleAuthorization = {
  url: string;
  nonce: string;
};

export type ProfessionalGoogleCallbackResult =
  /** CASE 2 — an existing linked professional-role user (BUSINESS_OWNER / SUPERVISOR / STAFF):
   * issue a session, go to their dashboard. */
  | { type: "SESSION"; auth: AuthResult }
  /** CASE 1 — brand-new owner: a PROFESSIONAL RegistrationSession was seeded; the frontend
   * resumes the existing multi-step onboarding. NO User is created here. `visitType` is echoed
   * back so the frontend can carry it through the remaining steps without another round trip. */
  | { type: "REGISTRATION"; sessionId: string; visitType: BusinessVisitType }
  /** CASE 3 — the Google email already belongs to a Bookly account with no Google link. */
  | { type: "ACCOUNT_EXISTS" }
  | { type: "ERROR" };

/**
 * Business Owner "Continue with Google" — sign-up and sign-in in one callback. HOLDS NO HTTP
 * concerns (the controller owns cookies + redirects). Architecture: Google verification NEVER
 * creates a User. A new owner only gets a PROFESSIONAL / BUSINESS_OWNER RegistrationSession
 * (Option B); the User + LinkedAccount + Business are created together, in one transaction, by
 * the existing `AuthService.completeBusinessOwner` at the end of onboarding.
 *
 * Security rules enforced here:
 *  - the browser is bound to the flow by a signed `state` nonce that must equal a cookie nonce;
 *  - `visitType` is read ONLY from the signed state, never a callback query param;
 *  - the Google identity is verified (id_token) with a verified email before anything is read/written;
 *  - an account is resolved ONLY by LinkedAccount(provider, providerAccountId=sub) — never email;
 *  - a Google email already on a Bookly account is NEVER silently linked or merged (ACCOUNT_EXISTS);
 *  - login (CASE 2) via an existing link works for any active professional-role user
 *    (BUSINESS_OWNER / SUPERVISOR / STAFF) — but the "no link" branch NEVER provisions a staff
 *    account: only the Business Owner registration path remains, and it is BUSINESS_OWNER-only.
 */
export class ProfessionalGoogleAuthService {
  public constructor(
    private readonly userRepository: UserRepository,
    private readonly linkedAccountRepository: LinkedAccountRepository,
    private readonly registrationSessionRepository: RegistrationSessionRepository,
    private readonly businessOnboardingService: BusinessOnboardingService,
    private readonly tokenService: TokenService,
  ) {}

  public async buildAuthorization(
    visitType: BusinessVisitType,
  ): Promise<ProfessionalGoogleAuthorization> {
    const nonce = createOpaqueToken();
    const state = await signProfessionalGoogleState({ nonce, visitType });
    return { url: buildProfessionalGoogleAuthUrl(state), nonce };
  }

  public async completeCallback(
    input: { code: string; state: string; nonceCookie: string | undefined },
    context: RequestContext,
  ): Promise<ProfessionalGoogleCallbackResult> {
    // 1. Signed + unexpired state, whose nonce must match the browser's cookie (CSRF / fixation).
    let nonce: string;
    let visitType: BusinessVisitType;
    try {
      ({ nonce, visitType } = await verifyProfessionalGoogleState(input.state));
    } catch {
      return { type: "ERROR" };
    }

    if (!input.nonceCookie || !safeCompare(nonce, input.nonceCookie)) {
      return { type: "ERROR" };
    }

    // 2. Verify the Google identity. Nothing before this point is trusted.
    let identity: GoogleVerifiedIdentity;
    try {
      identity = await resolveProfessionalGoogleIdentity(input.code);
    } catch {
      return { type: "ERROR" };
    }

    if (!identity.emailVerified) {
      return { type: "ERROR" };
    }

    const normalizedEmail = normalizeEmail(identity.email);

    // 3. CASE 2 — a LinkedAccount for this Google `sub` already exists → log that user in
    //    (BUSINESS_OWNER, SUPERVISOR or STAFF — a staff member who accepted their invitation
    //    with, or later linked, Google).
    const existingLink = await this.linkedAccountRepository.findByProviderAccount(
      GOOGLE_PROVIDER,
      identity.providerAccountId,
    );

    if (existingLink) {
      return this.loginLinkedProfessional(existingLink.userId, context);
    }

    // 4. CASE 3 — no link. NEVER auto-link by email: if the address already belongs to an
    //    account, stop with a safe "use your existing sign-in method" outcome. No writes.
    if (await this.userRepository.findByEmail(normalizedEmail)) {
      return { type: "ACCOUNT_EXISTS" };
    }

    // 5. CASE 1 — brand-new owner: seed a RegistrationSession only. No User.
    return this.startRegistration(identity, normalizedEmail, visitType);
  }

  private async loginLinkedProfessional(
    userId: Types.ObjectId,
    context: RequestContext,
  ): Promise<ProfessionalGoogleCallbackResult> {
    const user = await this.userRepository.findById(userId);

    if (!user) {
      return { type: "ERROR" };
    }

    // Login only — this never creates anything. A link resolves a session for any active
    // professional-role user; CUSTOMER / SUPER_ADMIN (or a suspended / deleted account) do not.
    const isProfessionalRole =
      user.role === "BUSINESS_OWNER" || user.role === "SUPERVISOR" || user.role === "STAFF";

    if (!isProfessionalRole || user.status === "SUSPENDED" || user.status === "DELETED") {
      return { type: "ERROR" };
    }

    const auth = await issueAuthSession(
      this.tokenService,
      { userId: user._id, email: user.normalizedEmail, role: user.role, status: user.status },
      context,
    );

    return { type: "SESSION", auth };
  }

  private async startRegistration(
    identity: GoogleVerifiedIdentity,
    normalizedEmail: string,
    visitType: BusinessVisitType,
  ): Promise<ProfessionalGoogleCallbackResult> {
    const { firstName, lastName } = splitGoogleName(identity);
    const now = new Date();

    try {
      const session = await this.registrationSessionRepository.createGoogleProfessionalSession({
        normalizedEmail,
        googleProviderAccountId: identity.providerAccountId,
        firstName,
        lastName,
        businessVisitType: visitType,
        emailVerifiedAt: now,
        expiresAt: new Date(now.getTime() + env.REGISTRATION_SESSION_TTL_HOURS * MS_PER_HOUR),
      });

      // Seed the BusinessOnboardingDraft with the visit type, exactly like
      // AuthService.saveProfessionalVisitType does for the password flow, and link its id.
      // `currentStep` stays "EMAIL_VERIFIED" (set by createGoogleProfessionalSession) — Google
      // has verified the email, and that is the step `submitProfile` requires next.
      const draft = await this.businessOnboardingService.saveVisitType(session._id, visitType);
      session.businessOnboardingDraftId = draft._id;
      await this.registrationSessionRepository.save(session);

      return { type: "REGISTRATION", sessionId: String(session._id), visitType };
    } catch (error) {
      logger.error({ err: error }, "Business Owner Google registration seeding failed");
      return { type: "ERROR" };
    }
  }
}
