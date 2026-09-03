import { Types } from "mongoose";

import { AuthError } from "../auth/auth.errors.js";
import { normalizeEmail } from "../auth/auth.utils.js";
import type { PasswordHasher } from "../auth/password-hasher.js";
import type { UserRepository } from "../user/user.repository.js";
import {
  buildGoogleAccountLinkAuthUrl,
  isGoogleAccountLinkConfigured,
  verifyGoogleAccountLinkCallback,
} from "./google-oauth.client.js";
import { LinkedAccountError } from "./linked-account.errors.js";
import type { LinkedAccountRepository } from "./linked-account.repository.js";
import type { UnlinkGoogleAccountBody } from "./linked-account.schema.js";
import { signGoogleLinkState, verifyGoogleLinkState } from "./linked-account.state.js";
import type { LinkedAccountSummary } from "./linked-account.types.js";

const GOOGLE_PROVIDER = "GOOGLE" as const;

/**
 * Business logic for Customer → Google account linking (Phase 1). Holds NO HTTP concerns and NO
 * direct Mongo access. Security rules enforced here:
 *  - link is only ever started by an authenticated Customer (route gate) and the target user is
 *    carried in the signed OAuth state, never derived from the Google email;
 *  - the Google identity is verified (id_token) before any write;
 *  - a Google account already linked to a different user is rejected;
 *  - a user may hold at most one Google link;
 *  - unlink requires the current password and can never remove the last sign-in method.
 */
export class LinkedAccountService {
  public constructor(
    private readonly linkedAccountRepository: LinkedAccountRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly userRepository: UserRepository,
  ) {}

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
   * verified Google identity to THAT user only — the provider email is never used to look up or
   * match an account.
   */
  public async linkGoogleFromCallback(code: string, state: string): Promise<void> {
    if (!isGoogleAccountLinkConfigured()) {
      throw new LinkedAccountError("LINKED_ACCOUNT_NOT_CONFIGURED", 503);
    }

    const { userId } = await verifyGoogleLinkState(state);

    const user = await this.userRepository.findById(userId);

    if (!user || user.status === "DELETED" || user.role !== "CUSTOMER") {
      // A valid signature over a user that can no longer be linked — treat as a stale request.
      throw new LinkedAccountError("LINKED_ACCOUNT_INVALID_STATE", 400);
    }

    const identity = await verifyGoogleAccountLinkCallback(code);

    // Provider-identity uniqueness — this Google account must not already belong to someone else.
    const byProviderAccount = await this.linkedAccountRepository.findByProviderAccount(
      GOOGLE_PROVIDER,
      identity.providerAccountId,
    );

    if (byProviderAccount) {
      if (String(byProviderAccount.userId) !== userId) {
        throw new LinkedAccountError("LINKED_ACCOUNT_ALREADY_LINKED_ELSEWHERE", 409);
      }

      // Same Google account, same user — a harmless repeat of an already-completed link.
      return;
    }

    // One Google account per user.
    const existingForUser = await this.linkedAccountRepository.findByUserAndProvider(
      userId,
      GOOGLE_PROVIDER,
    );

    if (existingForUser) {
      throw new LinkedAccountError("LINKED_ACCOUNT_PROVIDER_ALREADY_LINKED", 409);
    }

    try {
      await this.linkedAccountRepository.create({
        userId: new Types.ObjectId(userId),
        provider: GOOGLE_PROVIDER,
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
          GOOGLE_PROVIDER,
          identity.providerAccountId,
        );

        if (raced && String(raced.userId) !== userId) {
          throw new LinkedAccountError("LINKED_ACCOUNT_ALREADY_LINKED_ELSEWHERE", 409);
        }

        throw new LinkedAccountError("LINKED_ACCOUNT_PROVIDER_ALREADY_LINKED", 409);
      }

      throw error;
    }
  }

  public async unlinkGoogle(userId: string, input: UnlinkGoogleAccountBody): Promise<void> {
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

    const existing = await this.linkedAccountRepository.findByUserAndProvider(
      userId,
      GOOGLE_PROVIDER,
    );

    if (!existing) {
      throw new LinkedAccountError("LINKED_ACCOUNT_NOT_FOUND", 404);
    }

    // Last-credential protection: after this unlink the account must still have at least one way
    // to sign in. A usable password always counts; otherwise another linked provider must remain.
    // In Phase 1 every User has a real password hash, so this never blocks today — it guards a
    // future passwordless (Google-only) sign-up path.
    const hasUsablePassword = Boolean(user.passwordHash);
    const otherProviders = (await this.linkedAccountRepository.findByUserId(userId)).filter(
      (account) => account.provider !== GOOGLE_PROVIDER,
    );

    if (!hasUsablePassword && otherProviders.length === 0) {
      throw new LinkedAccountError("LINKED_ACCOUNT_LAST_CREDENTIAL", 409);
    }

    await this.linkedAccountRepository.deleteByUserAndProvider(userId, GOOGLE_PROVIDER);
  }

  public async listForUser(userId: string): Promise<LinkedAccountSummary[]> {
    const accounts = await this.linkedAccountRepository.findByUserId(userId);

    return accounts.map((account) => ({
      provider: account.provider,
      email: account.email,
      ...(account.displayName ? { displayName: account.displayName } : {}),
      linkedAt: account.linkedAt.toISOString(),
    }));
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
