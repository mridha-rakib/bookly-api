import { Types } from "mongoose";
import { AuthError } from "../auth/auth.errors.js";
import { createOpaqueToken, normalizeEmail } from "../auth/auth.utils.js";
import type { PasswordHasher } from "../auth/password-hasher.js";
import type { UserDocument } from "../user/user.model.js";
import type { UserRepository } from "../user/user.repository.js";
import {
  buildAppleAccountLinkAuthUrl,
  isAppleAccountLinkConfigured,
  verifyAppleAccountLinkCallback,
} from "./apple-oauth.client.js";
import {
  buildFacebookAccountLinkAuthUrl,
  isFacebookAccountLinkConfigured,
  verifyFacebookAccountLinkCallback,
} from "./facebook-oauth.client.js";
import {
  buildGoogleAccountLinkAuthUrl,
  isGoogleAccountLinkConfigured,
  verifyGoogleAccountLinkCallback,
} from "./google-oauth.client.js";
import { LinkedAccountError } from "./linked-account.errors.js";
import type { LinkedAccountRepository } from "./linked-account.repository.js";
import type { UnlinkLinkedAccountBody } from "./linked-account.schema.js";
import {
  signAppleLinkState,
  signFacebookLinkState,
  signGoogleLinkState,
  verifyAppleLinkState,
  verifyFacebookLinkState,
  verifyGoogleLinkState,
} from "./linked-account.state.js";
import {
  type LinkedAccountProvider,
  type LinkedAccountSummary,
  linkedAccountProviderLabels,
} from "./linked-account.types.js";

const GOOGLE_PROVIDER = "GOOGLE" as const;
const FACEBOOK_PROVIDER = "FACEBOOK" as const;
const APPLE_PROVIDER = "APPLE" as const;

/** The Apple form_post callback body fields the link flow consumes. */
export type AppleLinkCallbackInput = {
  code: string;
  idToken?: string | undefined;
  state: string;
};

/** A verified external identity, provider-independent. */
type VerifiedIdentity = {
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  displayName?: string | undefined;
};

/**
 * Business logic for Settings → link an external identity to the authenticated account (Google:
 * Phase 1; Facebook: this change). Holds NO HTTP concerns and NO direct Mongo access.
 *
 * LINKING ≠ LOGIN. Every link is started only by an authenticated, linkable user (route gate);
 * the target user is carried in the signed OAuth state, NEVER derived from the provider email; no
 * session is ever created here and the flow can never switch or merge accounts. Security rules,
 * identical for every provider:
 *  - the provider identity is verified (Google id_token / Facebook token introspection) before
 *    any write;
 *  - a provider identity already linked to a different user is rejected (409);
 *  - a user may hold at most one link per provider (409);
 *  - unlink requires the current password and can never remove the last sign-in method.
 */
export class LinkedAccountService {
  public constructor(
    private readonly linkedAccountRepository: LinkedAccountRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly userRepository: UserRepository,
  ) {}

  // ---------------------------------------------------------------------------
  // Google (Phase 1) — public API unchanged.
  // ---------------------------------------------------------------------------

  public async buildGoogleAuthorizeUrl(userId: string): Promise<string> {
    if (!isGoogleAccountLinkConfigured()) {
      throw new LinkedAccountError("LINKED_ACCOUNT_NOT_CONFIGURED", 503);
    }

    const state = await signGoogleLinkState({ userId });

    return buildGoogleAccountLinkAuthUrl(state);
  }

  /**
   * Google redirects the browser here after consent (see linked-account.route.ts — the callback
   * is public because a top-level redirect cannot carry a Bearer token). Trust comes entirely
   * from the signed `state`: it names the user who started the flow, and this method links the
   * verified Google identity to THAT user only.
   */
  public async linkGoogleFromCallback(code: string, state: string): Promise<void> {
    if (!isGoogleAccountLinkConfigured()) {
      throw new LinkedAccountError("LINKED_ACCOUNT_NOT_CONFIGURED", 503);
    }

    const { userId } = await verifyGoogleLinkState(state);
    await this.resolveLinkableUser(userId, "Google");

    const identity = await verifyGoogleAccountLinkCallback(code);
    await this.persistVerifiedIdentity(GOOGLE_PROVIDER, userId, identity);
  }

  public async unlinkGoogle(userId: string, input: UnlinkLinkedAccountBody): Promise<void> {
    await this.unlinkProvider(GOOGLE_PROVIDER, userId, input);
  }

  // ---------------------------------------------------------------------------
  // Facebook — account LINKING only (never "Continue with Facebook" login).
  // ---------------------------------------------------------------------------

  public async buildFacebookAuthorizeUrl(userId: string): Promise<string> {
    if (!isFacebookAccountLinkConfigured()) {
      throw new LinkedAccountError("LINKED_ACCOUNT_NOT_CONFIGURED", 503, undefined, "Facebook");
    }

    const state = await signFacebookLinkState({ userId });

    return buildFacebookAccountLinkAuthUrl(state);
  }

  /**
   * Facebook redirects the browser here after consent. Public callback — trust is the signed
   * `state` only. Links the verified Facebook identity to the user named in the state, never to a
   * user matched by the Facebook email.
   */
  public async linkFacebookFromCallback(code: string, state: string): Promise<void> {
    if (!isFacebookAccountLinkConfigured()) {
      throw new LinkedAccountError("LINKED_ACCOUNT_NOT_CONFIGURED", 503, undefined, "Facebook");
    }

    const { userId } = await verifyFacebookLinkState(state);
    await this.resolveLinkableUser(userId, "Facebook");

    const identity = await verifyFacebookAccountLinkCallback(code);
    await this.persistVerifiedIdentity(FACEBOOK_PROVIDER, userId, identity);
  }

  public async unlinkFacebook(userId: string, input: UnlinkLinkedAccountBody): Promise<void> {
    await this.unlinkProvider(FACEBOOK_PROVIDER, userId, input);
  }

  // ---------------------------------------------------------------------------
  // Apple — account LINKING only (never "Continue with Apple" login).
  // ---------------------------------------------------------------------------

  public async buildAppleAuthorizeUrl(userId: string): Promise<string> {
    if (!isAppleAccountLinkConfigured()) {
      throw new LinkedAccountError("LINKED_ACCOUNT_NOT_CONFIGURED", 503, undefined, "Apple");
    }

    const nonce = createOpaqueToken();
    const state = await signAppleLinkState({ userId, nonce });

    return buildAppleAccountLinkAuthUrl(state, nonce);
  }

  /**
   * Apple POSTs the browser here (form_post) after consent. Public callback — trust is the signed
   * `state` (carries `userId` + `nonce`) plus the Apple id_token `nonce` claim, which must equal
   * `state.nonce`. There is no nonce cookie (a SameSite=Lax cookie is not sent on Apple's
   * cross-site POST). Links the verified Apple identity to `state.userId` only — never a user
   * matched by the Apple email. A missing Apple email fails the link (LinkedAccount.email
   * required).
   */
  public async linkAppleFromCallback(input: AppleLinkCallbackInput): Promise<void> {
    if (!isAppleAccountLinkConfigured()) {
      throw new LinkedAccountError("LINKED_ACCOUNT_NOT_CONFIGURED", 503, undefined, "Apple");
    }

    const { userId, nonce } = await verifyAppleLinkState(input.state);
    await this.resolveLinkableUser(userId, "Apple");

    const identity = await verifyAppleAccountLinkCallback({
      code: input.code,
      idToken: input.idToken,
      nonce,
    });
    await this.persistVerifiedIdentity(APPLE_PROVIDER, userId, identity);
  }

  public async unlinkApple(userId: string, input: UnlinkLinkedAccountBody): Promise<void> {
    await this.unlinkProvider(APPLE_PROVIDER, userId, input);
  }

  // ---------------------------------------------------------------------------
  // Shared read model.
  // ---------------------------------------------------------------------------

  public async listForUser(userId: string): Promise<LinkedAccountSummary[]> {
    const accounts = await this.linkedAccountRepository.findByUserId(userId);

    return accounts.map((account) => ({
      provider: account.provider,
      email: account.email,
      ...(account.displayName ? { displayName: account.displayName } : {}),
      linkedAt: account.linkedAt.toISOString(),
    }));
  }

  // ---------------------------------------------------------------------------
  // Provider-independent core.
  // ---------------------------------------------------------------------------

  /**
   * The signed state named a user; they must still exist and still be linkable NOW. Linking is
   * available to CUSTOMER, BUSINESS_OWNER (Phase 2C) and SUPERVISOR / STAFF (Phase 2D) — never
   * SUPER_ADMIN. A valid signature over a user that can no longer be linked is treated as a stale
   * request.
   */
  private async resolveLinkableUser(userId: string, providerLabel: string): Promise<UserDocument> {
    const user = await this.userRepository.findById(userId);

    const linkableRole =
      user?.role === "CUSTOMER" ||
      user?.role === "BUSINESS_OWNER" ||
      user?.role === "SUPERVISOR" ||
      user?.role === "STAFF";

    if (!user || user.status === "DELETED" || !linkableRole) {
      throw new LinkedAccountError("LINKED_ACCOUNT_INVALID_STATE", 400, undefined, providerLabel);
    }

    return user;
  }

  /**
   * Conflict detection + persistence, identical for every provider:
   *  - provider identity already linked to another user   → ALREADY_LINKED_ELSEWHERE (409)
   *  - provider identity already linked to THIS user      → idempotent no-op
   *  - this user already has another identity for provider → PROVIDER_ALREADY_LINKED (409)
   *  - a duplicate-key race on create                     → re-resolved to the same 409s
   */
  private async persistVerifiedIdentity(
    provider: LinkedAccountProvider,
    userId: string,
    identity: VerifiedIdentity,
  ): Promise<void> {
    const providerLabel = linkedAccountProviderLabels[provider];

    const byProviderAccount = await this.linkedAccountRepository.findByProviderAccount(
      provider,
      identity.providerAccountId,
    );

    if (byProviderAccount) {
      if (String(byProviderAccount.userId) !== userId) {
        throw new LinkedAccountError(
          "LINKED_ACCOUNT_ALREADY_LINKED_ELSEWHERE",
          409,
          undefined,
          providerLabel,
        );
      }

      // Same identity, same user — a harmless repeat of an already-completed link.
      return;
    }

    const existingForUser = await this.linkedAccountRepository.findByUserAndProvider(
      userId,
      provider,
    );

    if (existingForUser) {
      throw new LinkedAccountError(
        "LINKED_ACCOUNT_PROVIDER_ALREADY_LINKED",
        409,
        undefined,
        providerLabel,
      );
    }

    try {
      await this.linkedAccountRepository.create({
        userId: new Types.ObjectId(userId),
        provider,
        providerAccountId: identity.providerAccountId,
        email: normalizeEmail(identity.email),
        emailVerified: identity.emailVerified,
        ...(identity.displayName ? { displayName: identity.displayName } : {}),
        linkedAt: new Date(),
      });
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        // Lost a race against a concurrent link. Re-resolve to the stable domain error.
        const raced = await this.linkedAccountRepository.findByProviderAccount(
          provider,
          identity.providerAccountId,
        );

        if (raced && String(raced.userId) !== userId) {
          throw new LinkedAccountError(
            "LINKED_ACCOUNT_ALREADY_LINKED_ELSEWHERE",
            409,
            undefined,
            providerLabel,
          );
        }

        throw new LinkedAccountError(
          "LINKED_ACCOUNT_PROVIDER_ALREADY_LINKED",
          409,
          undefined,
          providerLabel,
        );
      }

      throw error;
    }
  }

  /**
   * Unlink one provider. Requires the current password (same precedent as changeMyPassword) and
   * the last-credential guard: after this unlink the account must still have at least one way to
   * sign in — a usable password always counts; otherwise another linked provider must remain. In
   * practice every User has a real password hash today, so this never blocks — it guards a future
   * passwordless sign-up path.
   */
  private async unlinkProvider(
    provider: LinkedAccountProvider,
    userId: string,
    input: UnlinkLinkedAccountBody,
  ): Promise<void> {
    const providerLabel = linkedAccountProviderLabels[provider];
    const user = await this.userRepository.findByIdWithPassword(userId);

    if (!user) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    const passwordValid = await this.passwordHasher.verify(
      user.passwordHash,
      input.currentPassword,
    );

    if (!passwordValid) {
      throw new AuthError("INVALID_CURRENT_PASSWORD", 400);
    }

    const existing = await this.linkedAccountRepository.findByUserAndProvider(userId, provider);

    if (!existing) {
      throw new LinkedAccountError("LINKED_ACCOUNT_NOT_FOUND", 404, undefined, providerLabel);
    }

    const hasUsablePassword = Boolean(user.passwordHash);
    const otherProviders = (await this.linkedAccountRepository.findByUserId(userId)).filter(
      (account) => account.provider !== provider,
    );

    if (!hasUsablePassword && otherProviders.length === 0) {
      throw new LinkedAccountError("LINKED_ACCOUNT_LAST_CREDENTIAL", 409, undefined, providerLabel);
    }

    await this.linkedAccountRepository.deleteByUserAndProvider(userId, provider);
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
