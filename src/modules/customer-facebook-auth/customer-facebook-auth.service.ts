import mongoose, { type Types } from "mongoose";

import {
  type FacebookVerifiedIdentity,
  splitFacebookName,
} from "../../common/oauth/facebook-identity.js";
import { logger } from "../../config/logger.js";
import { createOpaqueToken, normalizeEmail, safeCompare } from "../auth/auth.utils.js";
import { type AuthResult, issueAuthSession, type RequestContext } from "../auth/auth-session.js";
import type { TokenService } from "../auth/token.service.js";
import type { LinkedAccountRepository } from "../linked-account/linked-account.repository.js";
import type { UserRepository } from "../user/user.repository.js";
import {
  buildCustomerFacebookAuthUrl,
  resolveCustomerFacebookIdentity,
} from "./customer-facebook-auth.client.js";
import {
  signCustomerFacebookState,
  verifyCustomerFacebookState,
} from "./customer-facebook-auth.state.js";

const FACEBOOK_PROVIDER = "FACEBOOK" as const;

export type CustomerFacebookAuthorization = {
  url: string;
  nonce: string;
};

export type CustomerFacebookCallbackResult =
  | { type: "SESSION"; auth: AuthResult; requiresPhoneCompletion: boolean }
  | { type: "ACCOUNT_EXISTS" }
  | { type: "ERROR" };

/**
 * Customer "Continue with Facebook" — sign-in and (email permitting) sign-up in one callback.
 * HOLDS NO HTTP concerns: the controller owns cookies and redirects. This is LOGIN — it is a
 * completely separate flow from Settings → Link Facebook (which is authenticated and binds the
 * identity to the acting user). Security / product rules enforced here, mirroring
 * CustomerGoogleAuthService:
 *  - the browser is bound to the flow by a signed `state` nonce that must equal a cookie nonce;
 *  - the Facebook identity is verified (token introspection + app-id pin + `/me`) before anything
 *    is read or written;
 *  - an account is resolved ONLY by LinkedAccount(FACEBOOK, providerAccountId) — never by email;
 *  - a Facebook email that already belongs to a Bookly account is NEVER silently linked or merged;
 *  - a brand-new Customer + its UserProfile + LinkedAccount + session are created atomically,
 *    but ONLY when Facebook returned a usable email that is not already in use;
 *  - suspended / deleted / non-Customer linked accounts get a coarse error, no session.
 */
export class CustomerFacebookAuthService {
  public constructor(
    private readonly userRepository: UserRepository,
    private readonly linkedAccountRepository: LinkedAccountRepository,
    private readonly tokenService: TokenService,
  ) {}

  public async buildAuthorization(): Promise<CustomerFacebookAuthorization> {
    const nonce = createOpaqueToken();
    const state = await signCustomerFacebookState({ nonce });
    return { url: buildCustomerFacebookAuthUrl(state), nonce };
  }

  public async completeCallback(
    input: { code: string; state: string; nonceCookie: string | undefined },
    context: RequestContext,
  ): Promise<CustomerFacebookCallbackResult> {
    // 1. Signed + unexpired state, whose nonce must match the browser's cookie (CSRF / fixation).
    let nonce: string;
    try {
      ({ nonce } = await verifyCustomerFacebookState(input.state));
    } catch {
      return { type: "ERROR" };
    }

    if (!input.nonceCookie || !safeCompare(nonce, input.nonceCookie)) {
      return { type: "ERROR" };
    }

    // 2. Verify the Facebook identity. Nothing before this point is trusted.
    let identity: FacebookVerifiedIdentity;
    try {
      identity = await resolveCustomerFacebookIdentity(input.code);
    } catch {
      return { type: "ERROR" };
    }

    // 3. CASE A — a LinkedAccount for this Facebook id already exists → log that user in.
    //    Resolution is by providerAccountId ONLY; a missing fresh `/me` email does NOT block it.
    const existingLink = await this.linkedAccountRepository.findByProviderAccount(
      FACEBOOK_PROVIDER,
      identity.providerAccountId,
    );

    if (existingLink) {
      return this.loginLinkedUser(existingLink.userId, context);
    }

    // 4. CASE B — no link, Facebook returned no usable email → cannot create an account.
    if (!identity.email) {
      return { type: "ERROR" };
    }

    const normalizedEmail = normalizeEmail(identity.email);

    // 5. CASE C — no link. NEVER auto-link by email: if the address already belongs to an
    //    account, stop with a safe "use your existing sign-in method" outcome. No writes.
    if (await this.userRepository.findByEmail(normalizedEmail)) {
      return { type: "ACCOUNT_EXISTS" };
    }

    // 6. CASE D — brand-new Customer: User + UserProfile + LinkedAccount + session, atomically.
    return this.provisionNewCustomer(identity, normalizedEmail, context);
  }

  private async loginLinkedUser(
    userId: Types.ObjectId,
    context: RequestContext,
  ): Promise<CustomerFacebookCallbackResult> {
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
    identity: FacebookVerifiedIdentity,
    normalizedEmail: string,
    context: RequestContext,
  ): Promise<CustomerFacebookCallbackResult> {
    const { firstName, lastName } = splitFacebookName(identity);
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
            authProviders: [FACEBOOK_PROVIDER],
          },
          dbSession,
        );

        await this.userRepository.createProfile(
          {
            userId: user._id,
            firstName,
            lastName,
            // Facebook `public_profile` never provides gender; "other" is the enum's genuine
            // "unspecified" value (same precedent as the Google customer flow). Editable in Profile.
            gender: "other",
            // "Continue with Facebook" carries the same Terms agreement the email-signup checkbox does.
            termsAcceptedAt: now,
          },
          dbSession,
        );

        await this.linkedAccountRepository.create(
          {
            userId: user._id,
            provider: FACEBOOK_PROVIDER,
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
        logger.error({ err: error }, "Customer Facebook signup failed — transactions unavailable");
        return { type: "ERROR" };
      }

      if (this.isDuplicateKeyError(error)) {
        // Lost a race: a concurrent request created the account / link first. Re-resolve safely.
        return this.resolveAfterRace(identity.providerAccountId, normalizedEmail, context);
      }

      logger.error({ err: error }, "Customer Facebook signup failed");
      return { type: "ERROR" };
    } finally {
      await dbSession.endSession();
    }

    if (!auth) {
      return { type: "ERROR" };
    }

    // Brand-new account: email is Facebook-verified, but there is still no verified phone.
    return { type: "SESSION", auth, requiresPhoneCompletion: true };
  }

  private async resolveAfterRace(
    providerAccountId: string,
    normalizedEmail: string,
    context: RequestContext,
  ): Promise<CustomerFacebookCallbackResult> {
    const link = await this.linkedAccountRepository.findByProviderAccount(
      FACEBOOK_PROVIDER,
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
