import type { Types } from "mongoose";

import {
  type FacebookVerifiedIdentity,
  splitFacebookName,
} from "../../common/oauth/facebook-identity.js";
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
  buildProfessionalFacebookAuthUrl,
  resolveProfessionalFacebookIdentity,
} from "./professional-facebook-auth.client.js";
import {
  signProfessionalFacebookState,
  verifyProfessionalFacebookState,
} from "./professional-facebook-auth.state.js";

const FACEBOOK_PROVIDER = "FACEBOOK" as const;
const MS_PER_HOUR = 60 * 60 * 1000;

export type ProfessionalFacebookAuthorization = {
  url: string;
  nonce: string;
};

export type ProfessionalFacebookCallbackResult =
  /** CASE 2 — an existing linked professional-role user (BUSINESS_OWNER / SUPERVISOR / STAFF):
   * issue a session, go to their dashboard. */
  | { type: "SESSION"; auth: AuthResult }
  /** CASE 1 — brand-new owner: a PROFESSIONAL RegistrationSession was seeded; the frontend
   * resumes the existing multi-step onboarding. NO User is created here. */
  | { type: "REGISTRATION"; sessionId: string; visitType: BusinessVisitType }
  /** CASE 3 — the Facebook email already belongs to a Bookly account with no Facebook link. */
  | { type: "ACCOUNT_EXISTS" }
  | { type: "ERROR" };

/**
 * Business Owner "Continue with Facebook" — sign-in and (email permitting) sign-up in one
 * callback. HOLDS NO HTTP concerns. Mirrors ProfessionalGoogleAuthService exactly: Facebook
 * verification NEVER creates a User. A new owner only gets a PROFESSIONAL / BUSINESS_OWNER
 * RegistrationSession (Option B); the User + LinkedAccount + Business are created together, in one
 * transaction, by `AuthService.completeBusinessOwner` at the end of onboarding.
 *
 * Security / product rules enforced here:
 *  - the browser is bound to the flow by a signed `state` nonce that must equal a cookie nonce;
 *  - `visitType` is read ONLY from the signed state, never a callback query param;
 *  - the Facebook identity is verified (token introspection + app-id pin + `/me`) before any read/write;
 *  - an account is resolved ONLY by LinkedAccount(FACEBOOK, providerAccountId) — never by email;
 *  - a Facebook email already on a Bookly account is NEVER silently linked or merged (ACCOUNT_EXISTS);
 *  - login (CASE 2) via an existing link works for any active professional-role user
 *    (BUSINESS_OWNER / SUPERVISOR / STAFF) — but the "no link" branch NEVER provisions staff:
 *    only the Business Owner registration path remains, and it is BUSINESS_OWNER-only;
 *  - a "no link" signup requires a usable Facebook email (no email → ERROR, never a fake one).
 */
export class ProfessionalFacebookAuthService {
  public constructor(
    private readonly userRepository: UserRepository,
    private readonly linkedAccountRepository: LinkedAccountRepository,
    private readonly registrationSessionRepository: RegistrationSessionRepository,
    private readonly businessOnboardingService: BusinessOnboardingService,
    private readonly tokenService: TokenService,
  ) {}

  public async buildAuthorization(
    visitType: BusinessVisitType,
  ): Promise<ProfessionalFacebookAuthorization> {
    const nonce = createOpaqueToken();
    const state = await signProfessionalFacebookState({ nonce, visitType });
    return { url: buildProfessionalFacebookAuthUrl(state), nonce };
  }

  public async completeCallback(
    input: { code: string; state: string; nonceCookie: string | undefined },
    context: RequestContext,
  ): Promise<ProfessionalFacebookCallbackResult> {
    // 1. Signed + unexpired state, whose nonce must match the browser's cookie (CSRF / fixation).
    let nonce: string;
    let visitType: BusinessVisitType;
    try {
      ({ nonce, visitType } = await verifyProfessionalFacebookState(input.state));
    } catch {
      return { type: "ERROR" };
    }

    if (!input.nonceCookie || !safeCompare(nonce, input.nonceCookie)) {
      return { type: "ERROR" };
    }

    // 2. Verify the Facebook identity. Nothing before this point is trusted.
    let identity: FacebookVerifiedIdentity;
    try {
      identity = await resolveProfessionalFacebookIdentity(input.code);
    } catch {
      return { type: "ERROR" };
    }

    // 3. CASE 2 — a LinkedAccount for this Facebook id already exists → log that user in
    //    (BUSINESS_OWNER, SUPERVISOR or STAFF). Resolution is by providerAccountId ONLY; a missing
    //    fresh `/me` email does NOT block it.
    const existingLink = await this.linkedAccountRepository.findByProviderAccount(
      FACEBOOK_PROVIDER,
      identity.providerAccountId,
    );

    if (existingLink) {
      return this.loginLinkedProfessional(existingLink.userId, context);
    }

    // 4. CASE — no link, Facebook returned no usable email → cannot start a registration.
    if (!identity.email) {
      return { type: "ERROR" };
    }

    const normalizedEmail = normalizeEmail(identity.email);

    // 5. CASE 3 — no link. NEVER auto-link by email: if the address already belongs to an
    //    account, stop with a safe "use your existing sign-in method" outcome. No writes.
    if (await this.userRepository.findByEmail(normalizedEmail)) {
      return { type: "ACCOUNT_EXISTS" };
    }

    // 6. CASE 1 — brand-new owner: seed a RegistrationSession only. No User.
    return this.startRegistration(identity, normalizedEmail, visitType);
  }

  private async loginLinkedProfessional(
    userId: Types.ObjectId,
    context: RequestContext,
  ): Promise<ProfessionalFacebookCallbackResult> {
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
    identity: FacebookVerifiedIdentity,
    normalizedEmail: string,
    visitType: BusinessVisitType,
  ): Promise<ProfessionalFacebookCallbackResult> {
    const { firstName, lastName } = splitFacebookName(identity);
    const now = new Date();

    try {
      const session = await this.registrationSessionRepository.createFacebookProfessionalSession({
        normalizedEmail,
        facebookProviderAccountId: identity.providerAccountId,
        firstName,
        lastName,
        businessVisitType: visitType,
        emailVerifiedAt: now,
        expiresAt: new Date(now.getTime() + env.REGISTRATION_SESSION_TTL_HOURS * MS_PER_HOUR),
      });

      const draft = await this.businessOnboardingService.saveVisitType(session._id, visitType);
      session.businessOnboardingDraftId = draft._id;
      await this.registrationSessionRepository.save(session);

      return { type: "REGISTRATION", sessionId: String(session._id), visitType };
    } catch (error) {
      logger.error({ err: error }, "Business Owner Facebook registration seeding failed");
      return { type: "ERROR" };
    }
  }
}
