import mongoose, { type Types } from "mongoose";

import type { GoogleVerifiedIdentity } from "../../common/oauth/google-identity.js";
import { logger } from "../../config/logger.js";
import { createOpaqueToken, normalizeEmail, safeCompare } from "../auth/auth.utils.js";
import { type AuthResult, issueAuthSession, type RequestContext } from "../auth/auth-session.js";
import type { TokenService } from "../auth/token.service.js";
import type { LinkedAccountRepository } from "../linked-account/linked-account.repository.js";
import type { UserRepository } from "../user/user.repository.js";
import {
  buildCustomerGoogleAuthUrl,
  resolveCustomerGoogleIdentity,
} from "./customer-google-auth.client.js";
import {
  signCustomerGoogleState,
  verifyCustomerGoogleState,
} from "./customer-google-auth.state.js";

const GOOGLE_PROVIDER = "GOOGLE" as const;

export type CustomerGoogleAuthorization = {
  url: string;
  nonce: string;
};

export type CustomerGoogleCallbackResult =
  | { type: "SESSION"; auth: AuthResult; requiresPhoneCompletion: boolean }
  | { type: "ACCOUNT_EXISTS" }
  | { type: "ERROR" };

type GoogleSignupName = { firstName: string; lastName: string };

/**
 * Splits a Google identity into non-empty first/last names (UserProfile requires both). Prefers
 * the dedicated `given_name` / `family_name`; for a single-token display name, duplicates it into
 * both fields — the same "no invented placeholder" approach as staff.utils.splitStaffName. The
 * Customer can edit either field afterwards from Profile.
 */
export const splitGoogleName = (identity: {
  firstName?: string;
  lastName?: string;
  displayName?: string;
}): GoogleSignupName => {
  const given = identity.firstName?.trim();
  const family = identity.lastName?.trim();

  if (given && family) {
    return { firstName: given, lastName: family };
  }

  const display = (identity.displayName ?? "").trim().replace(/\s+/g, " ");
  const firstSpace = display.indexOf(" ");
  const displayFirst = firstSpace === -1 ? display : display.slice(0, firstSpace);
  const displayLast = firstSpace === -1 ? display : display.slice(firstSpace + 1);

  if (given || family) {
    return {
      firstName: given || displayFirst || (family as string),
      lastName: family || displayLast || (given as string),
    };
  }

  if (!display) {
    return { firstName: "Google", lastName: "User" };
  }

  return { firstName: displayFirst, lastName: displayLast || displayFirst };
};

/**
 * Customer "Continue with Google" — sign-up and sign-in in one callback. HOLDS NO HTTP concerns:
 * the controller owns cookies and redirects. Security rules enforced here:
 *  - the browser is bound to the flow by a signed `state` nonce that must equal a cookie nonce;
 *  - the Google identity is verified (id_token) before anything is read or written;
 *  - an account is resolved ONLY by LinkedAccount(provider, providerAccountId=sub) — never email;
 *  - a Google email that already belongs to a Bookly account is NEVER silently linked or merged;
 *  - a brand-new Customer + its UserProfile + LinkedAccount + session are created atomically;
 *  - suspended / deleted / non-Customer linked accounts get a coarse error, no session.
 */
export class CustomerGoogleAuthService {
  public constructor(
    private readonly userRepository: UserRepository,
    private readonly linkedAccountRepository: LinkedAccountRepository,
    private readonly tokenService: TokenService,
  ) {}

  public async buildAuthorization(): Promise<CustomerGoogleAuthorization> {
    const nonce = createOpaqueToken();
    const state = await signCustomerGoogleState({ nonce });
    return { url: buildCustomerGoogleAuthUrl(state), nonce };
  }

  public async completeCallback(
    input: { code: string; state: string; nonceCookie: string | undefined },
    context: RequestContext,
  ): Promise<CustomerGoogleCallbackResult> {
    // 1. Signed + unexpired state, whose nonce must match the browser's cookie (CSRF / fixation).
    let nonce: string;
    try {
      ({ nonce } = await verifyCustomerGoogleState(input.state));
    } catch {
      return { type: "ERROR" };
    }

    if (!input.nonceCookie || !safeCompare(nonce, input.nonceCookie)) {
      return { type: "ERROR" };
    }

    // 2. Verify the Google identity. Nothing before this point is trusted.
    let identity: GoogleVerifiedIdentity;
    try {
      identity = await resolveCustomerGoogleIdentity(input.code);
    } catch {
      return { type: "ERROR" };
    }

    if (!identity.emailVerified) {
      return { type: "ERROR" };
    }

    const normalizedEmail = normalizeEmail(identity.email);

    // 3. CASE 1 — a LinkedAccount for this Google `sub` already exists → log that user in.
    const existingLink = await this.linkedAccountRepository.findByProviderAccount(
      GOOGLE_PROVIDER,
      identity.providerAccountId,
    );

    if (existingLink) {
      return this.loginLinkedUser(existingLink.userId, context);
    }

    // 4. CASE 2 — no link. NEVER auto-link by email: if the address already belongs to an
    //    account, stop with a safe "use your existing sign-in method" outcome. No writes.
    if (await this.userRepository.findByEmail(normalizedEmail)) {
      return { type: "ACCOUNT_EXISTS" };
    }

    // 5. Brand-new Customer — User + UserProfile + LinkedAccount + session, atomically.
    return this.provisionNewCustomer(identity, normalizedEmail, context);
  }

  private async loginLinkedUser(
    userId: Types.ObjectId,
    context: RequestContext,
  ): Promise<CustomerGoogleCallbackResult> {
    const user = await this.userRepository.findById(userId);

    if (!user) {
      return { type: "ERROR" };
    }

    if (user.role !== "CUSTOMER" || user.status === "SUSPENDED" || user.status === "DELETED") {
      return { type: "ERROR" };
    }

    const auth = await issueAuthSession(
      this.tokenService,
      { userId: user._id, email: user.normalizedEmail, role: user.role, status: user.status },
      context,
    );

    return { type: "SESSION", auth, requiresPhoneCompletion: !user.phoneVerifiedAt };
  }

  private async provisionNewCustomer(
    identity: GoogleVerifiedIdentity,
    normalizedEmail: string,
    context: RequestContext,
  ): Promise<CustomerGoogleCallbackResult> {
    const { firstName, lastName } = splitGoogleName(identity);
    const now = new Date();

    const dbSession = await mongoose.startSession();
    let auth: AuthResult | undefined;

    try {
      await dbSession.withTransaction(async () => {
        const user = await this.userRepository.create(
          {
            normalizedEmail,
            role: "CUSTOMER",
            status: "ACTIVE",
            emailVerifiedAt: now,
            authProviders: [GOOGLE_PROVIDER],
          },
          dbSession,
        );

        await this.userRepository.createProfile(
          {
            userId: user._id,
            firstName,
            lastName,
            // Google OIDC never provides gender; "other" is the enum's genuine "unspecified"
            // value (same precedent as staff creation) and is editable from Profile. Not fake data.
            gender: "other",
            // "Continue with Google" carries the same Terms agreement the email-signup checkbox does.
            termsAcceptedAt: now,
          },
          dbSession,
        );

        await this.linkedAccountRepository.create(
          {
            userId: user._id,
            provider: GOOGLE_PROVIDER,
            providerAccountId: identity.providerAccountId,
            email: normalizedEmail,
            emailVerified: identity.emailVerified,
            ...(identity.displayName ? { displayName: identity.displayName } : {}),
            linkedAt: now,
          },
          dbSession,
        );

        auth = await issueAuthSession(
          this.tokenService,
          { userId: user._id, email: user.normalizedEmail, role: user.role, status: user.status },
          context,
          dbSession,
        );
      });
    } catch (error) {
      if (this.isTransactionUnsupported(error)) {
        logger.error({ err: error }, "Customer Google signup failed — transactions unavailable");
        return { type: "ERROR" };
      }

      if (this.isDuplicateKeyError(error)) {
        // Lost a race: a concurrent request created the account / link first. Re-resolve safely.
        return this.resolveAfterRace(identity.providerAccountId, normalizedEmail, context);
      }

      logger.error({ err: error }, "Customer Google signup failed");
      return { type: "ERROR" };
    } finally {
      await dbSession.endSession();
    }

    if (!auth) {
      return { type: "ERROR" };
    }

    // Brand-new account: email is Google-verified, but there is still no verified phone.
    return { type: "SESSION", auth, requiresPhoneCompletion: true };
  }

  private async resolveAfterRace(
    providerAccountId: string,
    normalizedEmail: string,
    context: RequestContext,
  ): Promise<CustomerGoogleCallbackResult> {
    const link = await this.linkedAccountRepository.findByProviderAccount(
      GOOGLE_PROVIDER,
      providerAccountId,
    );

    if (link) {
      return this.loginLinkedUser(link.userId, context);
    }

    if (await this.userRepository.findByEmail(normalizedEmail)) {
      return { type: "ACCOUNT_EXISTS" };
    }

    return { type: "ERROR" };
  }

  private isTransactionUnsupported(error: unknown): boolean {
    return (
      error instanceof Error &&
      /transaction numbers are only allowed|replica set member/i.test(error.message)
    );
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}
