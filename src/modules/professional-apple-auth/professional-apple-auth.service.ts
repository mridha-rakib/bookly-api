import type { Types } from "mongoose";

import {
  type AppleVerifiedIdentity,
  parseAppleUserJson,
  splitAppleName,
} from "../../common/oauth/apple-identity.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { createOpaqueToken, normalizeEmail } from "../auth/auth.utils.js";
import { type AuthResult, issueAuthSession, type RequestContext } from "../auth/auth-session.js";
import type { TokenService } from "../auth/token.service.js";
import type { BusinessVisitType } from "../business/business.types.js";
import type { BusinessOnboardingService } from "../business-onboarding/business-onboarding.service.js";
import type { LinkedAccountRepository } from "../linked-account/linked-account.repository.js";
import type { RegistrationSessionRepository } from "../registration-session/registration-session.repository.js";
import type { UserRepository } from "../user/user.repository.js";
import {
  buildProfessionalAppleAuthUrl,
  resolveProfessionalAppleIdentity,
} from "./professional-apple-auth.client.js";
import {
  signProfessionalAppleState,
  verifyProfessionalAppleState,
} from "./professional-apple-auth.state.js";

const APPLE_PROVIDER = "APPLE" as const;
const MS_PER_HOUR = 60 * 60 * 1000;

export type ProfessionalAppleAuthorization = {
  url: string;
  nonce: string;
};

export type ProfessionalAppleCallbackInput = {
  code: string;
  idToken?: string | undefined;
  state: string;
  appleUser?: string | undefined;
};

export type ProfessionalAppleCallbackResult =
  | { type: "SESSION"; auth: AuthResult }
  | { type: "REGISTRATION"; sessionId: string; visitType: BusinessVisitType }
  | { type: "ACCOUNT_EXISTS" }
  | { type: "ERROR" };

/**
 * Business Owner "Continue with Apple". Mirrors ProfessionalFacebookAuthService: Apple
 * verification NEVER creates a User. A new owner only gets a PROFESSIONAL / BUSINESS_OWNER
 * RegistrationSession (Option B); the User + LinkedAccount + Business are created together, in one
 * transaction, by `AuthService.completeBusinessOwner` at the end of onboarding.
 *
 * Locked rules: `visitType` from the signed state only; account resolved by
 * LinkedAccount(APPLE, sub) only; email never merges; a "no link" signup needs a verified unused
 * email (no email / unverified → ERROR); the "no link" branch is BUSINESS_OWNER-only (never
 * Supervisor/Staff).
 */
export class ProfessionalAppleAuthService {
  public constructor(
    private readonly userRepository: UserRepository,
    private readonly linkedAccountRepository: LinkedAccountRepository,
    private readonly registrationSessionRepository: RegistrationSessionRepository,
    private readonly businessOnboardingService: BusinessOnboardingService,
    private readonly tokenService: TokenService,
  ) {}

  public async buildAuthorization(
    visitType: BusinessVisitType,
  ): Promise<ProfessionalAppleAuthorization> {
    const nonce = createOpaqueToken();
    const state = await signProfessionalAppleState({ nonce, visitType });
    return { url: buildProfessionalAppleAuthUrl(state, nonce), nonce };
  }

  public async completeCallback(
    input: ProfessionalAppleCallbackInput,
    context: RequestContext,
  ): Promise<ProfessionalAppleCallbackResult> {
    let nonce: string;
    let visitType: BusinessVisitType;
    try {
      ({ nonce, visitType } = await verifyProfessionalAppleState(input.state));
    } catch {
      return { type: "ERROR" };
    }

    let identity: AppleVerifiedIdentity;
    try {
      identity = await resolveProfessionalAppleIdentity({
        code: input.code,
        idToken: input.idToken,
        nonce,
      });
    } catch {
      return { type: "ERROR" };
    }

    // CASE 2 — existing link → log the professional-role user in (by sub only; no fresh email needed).
    const existingLink = await this.linkedAccountRepository.findByProviderAccount(
      APPLE_PROVIDER,
      identity.providerAccountId,
    );

    if (existingLink) {
      return this.loginLinkedProfessional(existingLink.userId, context);
    }

    // No link + no usable / unverified email → cannot start a registration.
    if (!identity.email || !identity.emailVerified) {
      return { type: "ERROR" };
    }

    const normalizedEmail = normalizeEmail(identity.email);

    // CASE 3 — email already on a Bookly account → ACCOUNT_EXISTS, no writes.
    if (await this.userRepository.findByEmail(normalizedEmail)) {
      return { type: "ACCOUNT_EXISTS" };
    }

    // CASE 1 — brand-new owner: seed a RegistrationSession only. No User.
    return this.startRegistration(identity, normalizedEmail, input.appleUser, visitType);
  }

  private async loginLinkedProfessional(
    userId: Types.ObjectId,
    context: RequestContext,
  ): Promise<ProfessionalAppleCallbackResult> {
    const user = await this.userRepository.findById(userId);

    if (!user) {
      return { type: "ERROR" };
    }

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
    identity: AppleVerifiedIdentity,
    normalizedEmail: string,
    appleUser: string | undefined,
    visitType: BusinessVisitType,
  ): Promise<ProfessionalAppleCallbackResult> {
    const { firstName, lastName } = splitAppleName(parseAppleUserJson(appleUser));
    const now = new Date();

    try {
      const session = await this.registrationSessionRepository.createAppleProfessionalSession({
        normalizedEmail,
        appleProviderAccountId: identity.providerAccountId,
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
      logger.error({ err: error }, "Business Owner Apple registration seeding failed");
      return { type: "ERROR" };
    }
  }
}
