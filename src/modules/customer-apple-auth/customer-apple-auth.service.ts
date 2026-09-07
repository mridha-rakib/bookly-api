import mongoose, { type Types } from "mongoose";

import {
  type AppleVerifiedIdentity,
  parseAppleUserJson,
  splitAppleName,
} from "../../common/oauth/apple-identity.js";
import { logger } from "../../config/logger.js";
import { createOpaqueToken, normalizeEmail } from "../auth/auth.utils.js";
import { type AuthResult, issueAuthSession, type RequestContext } from "../auth/auth-session.js";
import type { TokenService } from "../auth/token.service.js";
import type { LinkedAccountRepository } from "../linked-account/linked-account.repository.js";
import type { UserRepository } from "../user/user.repository.js";
import {
  buildCustomerAppleAuthUrl,
  resolveCustomerAppleIdentity,
} from "./customer-apple-auth.client.js";
import { signCustomerAppleState, verifyCustomerAppleState } from "./customer-apple-auth.state.js";

const APPLE_PROVIDER = "APPLE" as const;

export type CustomerAppleAuthorization = {
  url: string;
  nonce: string;
};

export type CustomerAppleCallbackInput = {
  code: string;
  idToken?: string | undefined;
  state: string;
  /** The raw first-authorization `user` JSON string (name only). Never trusted as identity. */
  appleUser?: string | undefined;
};

export type CustomerAppleCallbackResult =
  | { type: "SESSION"; auth: AuthResult; requiresPhoneCompletion: boolean }
  | { type: "ACCOUNT_EXISTS" }
  | { type: "ERROR" };

/**
 * Customer "Continue with Apple" — sign-in and (email permitting) sign-up in one callback. HOLDS
 * NO HTTP concerns. Separate from Settings → Link Apple. Rules (locked):
 *  - the browser is bound to the flow by the signed `state` nonce, which must equal the Apple
 *    id_token `nonce` claim (no cookie — Apple's callback is a cross-site POST);
 *  - the Apple identity is verified (JWKS id_token + code exchange) before any read/write;
 *  - an account is resolved ONLY by LinkedAccount(APPLE, sub) — never by email; a missing fresh
 *    Apple email does NOT block an already-linked identity;
 *  - an unknown identity signs up ONLY with a verified, unused email (relay addresses allowed);
 *    no email / unverified email → ERROR, no fake address;
 *  - an email already on a Bookly account → ACCOUNT_EXISTS, zero writes, no merge;
 *  - suspended / deleted / non-Customer linked accounts → coarse error, no session.
 */
export class CustomerAppleAuthService {
  public constructor(
    private readonly userRepository: UserRepository,
    private readonly linkedAccountRepository: LinkedAccountRepository,
    private readonly tokenService: TokenService,
  ) {}

  public async buildAuthorization(): Promise<CustomerAppleAuthorization> {
    const nonce = createOpaqueToken();
    const state = await signCustomerAppleState({ nonce });
    return { url: buildCustomerAppleAuthUrl(state, nonce), nonce };
  }

  public async completeCallback(
    input: CustomerAppleCallbackInput,
    context: RequestContext,
  ): Promise<CustomerAppleCallbackResult> {
    // 1. Signed + unexpired state → the OIDC nonce.
    let nonce: string;
    try {
      ({ nonce } = await verifyCustomerAppleState(input.state));
    } catch {
      return { type: "ERROR" };
    }

    // 2. Verify the Apple identity (JWKS + code exchange + id_token nonce === state nonce).
    let identity: AppleVerifiedIdentity;
    try {
      identity = await resolveCustomerAppleIdentity({
        code: input.code,
        idToken: input.idToken,
        nonce,
      });
    } catch {
      return { type: "ERROR" };
    }

    // 3. CASE A — a LinkedAccount for this Apple sub exists → log that user in. Resolution is by
    //    providerAccountId ONLY; a missing fresh Apple email does NOT block it.
    const existingLink = await this.linkedAccountRepository.findByProviderAccount(
      APPLE_PROVIDER,
      identity.providerAccountId,
    );

    if (existingLink) {
      return this.loginLinkedUser(existingLink.userId, context);
    }

    // 4. CASE B — no link, Apple returned no usable email → cannot create an account.
    if (!identity.email) {
      return { type: "ERROR" };
    }

    // 4b. CASE C — Apple returned an email but not marked verified → cannot create an account.
    if (!identity.emailVerified) {
      return { type: "ERROR" };
    }

    const normalizedEmail = normalizeEmail(identity.email);

    // 5. CASE D — no link. NEVER auto-link by email: an existing account → ACCOUNT_EXISTS, no writes.
    if (await this.userRepository.findByEmail(normalizedEmail)) {
      return { type: "ACCOUNT_EXISTS" };
    }

    // 6. CASE E — brand-new Customer, atomically.
    return this.provisionNewCustomer(identity, normalizedEmail, input.appleUser, context);
  }

  private async loginLinkedUser(
    userId: Types.ObjectId,
    context: RequestContext,
  ): Promise<CustomerAppleCallbackResult> {
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
    identity: AppleVerifiedIdentity,
    normalizedEmail: string,
    appleUser: string | undefined,
    context: RequestContext,
  ): Promise<CustomerAppleCallbackResult> {
    // Apple sends the name ONLY on the first authorization, in the POSTed `user` blob — never in
    // the id_token. Capture it now; fall back to "Apple" / "User" (editable in Profile).
    const { firstName, lastName } = splitAppleName(parseAppleUserJson(appleUser));
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
            authProviders: [APPLE_PROVIDER],
          },
          dbSession,
        );

        await this.userRepository.createProfile(
          {
            userId: user._id,
            firstName,
            lastName,
            // Apple never provides gender; "other" is the enum's genuine "unspecified" value
            // (same precedent as the Google / Facebook customer flows). Editable in Profile.
            gender: "other",
            // "Continue with Apple" carries the same Terms agreement the email-signup checkbox does.
            termsAcceptedAt: now,
          },
          dbSession,
        );

        await this.linkedAccountRepository.create(
          {
            userId: user._id,
            provider: APPLE_PROVIDER,
            providerAccountId: identity.providerAccountId,
            email: normalizedEmail,
            emailVerified: identity.emailVerified,
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
        logger.error({ err: error }, "Customer Apple signup failed — transactions unavailable");
        return { type: "ERROR" };
      }

      if (this.isDuplicateKeyError(error)) {
        return this.resolveAfterRace(identity.providerAccountId, normalizedEmail, context);
      }

      logger.error({ err: error }, "Customer Apple signup failed");
      return { type: "ERROR" };
    } finally {
      await dbSession.endSession();
    }

    if (!auth) {
      return { type: "ERROR" };
    }

    return { type: "SESSION", auth, requiresPhoneCompletion: true };
  }

  private async resolveAfterRace(
    providerAccountId: string,
    normalizedEmail: string,
    context: RequestContext,
  ): Promise<CustomerAppleCallbackResult> {
    const link = await this.linkedAccountRepository.findByProviderAccount(
      APPLE_PROVIDER,
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
