import { Types } from "mongoose";

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AuthError } from "../auth/auth.errors.js";
import {
  addMinutes,
  assertOtpResendAllowed,
  createOpaqueToken,
  generateNumericOtp,
  safeCompare,
  sha256,
} from "../auth/auth.utils.js";
import type { PasswordHasher } from "../auth/password-hasher.js";
import { requireCurrentPassword } from "../auth/require-current-password.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { UserDocument } from "../user/user.model.js";
import type { UserRepository } from "../user/user.repository.js";
import { resolveAuthProviders } from "../user/user.types.js";
import type { EmailOtpProvider } from "../verification/email-otp.provider.js";
import { decryptIban, encryptIban } from "./payout-destination.crypto.js";
import { PayoutDestinationError } from "./payout-destination.errors.js";
import { requireValidIban } from "./payout-destination.iban.js";
import type { PayoutDestinationDocument } from "./payout-destination.model.js";
import type { PayoutDestinationRepository } from "./payout-destination.repository.js";
import type { UpdatePayoutDestinationBody } from "./payout-destination.schema.js";
import {
  buildMaskedIban,
  type PayoutDestinationRevealView,
  type PayoutDestinationView,
} from "./payout-destination.types.js";
import type { PayoutStepUpPurpose } from "./payout-destination-step-up.model.js";
import type { PayoutDestinationStepUpRepository } from "./payout-destination-step-up.repository.js";

const STEP_UP_PURPOSE: PayoutStepUpPurpose = "PAYOUT_DESTINATION_CHANGE";

/** How long a verified OTP's authorization proof stays usable. Short by design — it exists only
 * to bridge "I proved mailbox control" to "I submitted the new IBAN", not to create a session. */
const AUTHORIZATION_TTL_MINUTES = 10;

/**
 * Business Payout Destination — store and read ONLY.
 *
 * Nothing in this class can move money: there is no transfer, withdrawal or payout call anywhere
 * in it. The authoritative payout write path is unchanged and remains
 * BusinessPayoutService.executePayout (Super Admin only), which reads this module's repository
 * for a SAFE METADATA SNAPSHOT at confirm time and nothing else.
 *
 * Authorization model, mirroring FinanceService exactly:
 *  - Owner surface: route-level `requireRoles(["BUSINESS_OWNER"])` (so SUPERVISOR/STAFF get 403
 *    before reaching here) PLUS {@link requireOwnedPayoutDestinationBusiness}, which verifies the
 *    actor actually OWNS this businessId — a body-supplied businessId/ownerId is never trusted,
 *    and the `businessId` is only ever taken from the route param.
 *  - Super Admin surface: the SUPER_ADMIN route-level gate is the authorization (matching
 *    executePayout's existing precedent); no ownership check, and reveal is additionally
 *    rate-limited and audited.
 */
export class PayoutDestinationService {
  public constructor(
    private readonly businessRepository: BusinessRepository,
    private readonly userRepository: UserRepository,
    private readonly payoutDestinationRepository: PayoutDestinationRepository,
    private readonly stepUpRepository: PayoutDestinationStepUpRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly emailOtpProvider: EmailOtpProvider,
  ) {}

  // --- Business Owner surface ---------------------------------------------------------------

  /** Masked read. Returns `{ configured: false }` when no document exists — absence IS the
   * "not configured" state; there is no status field to consult. */
  public async getForOwner(
    actorUserId: string,
    businessId: string,
  ): Promise<PayoutDestinationView> {
    const business = await this.requireOwnedPayoutDestinationBusiness(actorUserId, businessId);
    const destination = await this.payoutDestinationRepository.findByBusinessId(business._id);
    return this.toView(destination);
  }

  /**
   * Create-or-replace — ONE handler for both, because one Business has at most one destination
   * (unique index on businessId). Step-up is verified BEFORE anything is written, so a failed
   * step-up leaves the stored destination byte-identical and writes no history entry and sends
   * no notification.
   */
  public async upsertForOwner(
    actorUserId: string,
    businessId: string,
    input: UpdatePayoutDestinationBody,
  ): Promise<PayoutDestinationView> {
    const business = await this.requireOwnedPayoutDestinationBusiness(actorUserId, businessId);
    const user = await this.requireUser(actorUserId);

    // 1. Step-up FIRST. Every failure path below throws before any write.
    await this.requireStepUp(user, business, input.stepUp);

    // 2. Normalize -> validate -> derive -> encrypt, in that order. The values persisted are all
    //    derived from the SAME canonical string that gets encrypted, so the mask can never
    //    disagree with the ciphertext, and the user's original formatting is never stored.
    const iban = requireValidIban(input.iban);
    const encrypted = encryptIban(iban.normalized, business._id);

    const existing = await this.payoutDestinationRepository.findByBusinessId(business._id);
    const previousLast4 = existing?.ibanLast4;
    const now = new Date();

    const saved = await this.payoutDestinationRepository.upsert(
      business._id,
      {
        accountHolderName: input.accountHolderName,
        ibanCiphertext: encrypted.ciphertext,
        ibanIv: encrypted.iv,
        ibanAuthTag: encrypted.authTag,
        ibanKeyVersion: encrypted.keyVersion,
        ibanLast4: iban.last4,
        ibanCountry: iban.country,
        ...(input.bankName === undefined ? {} : { bankName: input.bankName }),
        lastUpdatedByUserId: user._id,
      },
      {
        action: existing ? "UPDATED" : "CREATED",
        actorUserId: user._id,
        changedAt: now,
        ...(previousLast4 === undefined ? {} : { previousLast4 }),
        newLast4: iban.last4,
      },
    );

    // Structured, safe fields only — never the input object, never the IBAN.
    logger.info(
      { businessId: String(business._id), userId: String(user._id), created: !existing },
      "Payout destination saved",
    );

    this.notifyOwnerOfChange(user, business, iban.country, iban.last4, now);

    return this.toView(saved);
  }

  // --- OAuth-only step-up (two-step OTP) -----------------------------------------------------

  /**
   * Step 1. Sends a PAYOUT_DESTINATION_CHANGE OTP to the Owner's account email and upserts the
   * single active challenge slot for this (user, business). Reuses the exact resend-cooldown /
   * resends-per-hour policy every other OTP send in this codebase uses
   * ({@link assertOtpResendAllowed}); the route additionally applies the same
   * `otpSendLimiter`-style per-IP limiter.
   *
   * Rejected for password accounts: they have a strictly stronger factor available, and allowing
   * both would let an attacker who has the session choose the weaker one.
   */
  public async requestStepUpOtp(
    actorUserId: string,
    businessId: string,
  ): Promise<{ expiresAt: string }> {
    const business = await this.requireOwnedPayoutDestinationBusiness(actorUserId, businessId);
    const user = await this.requireUser(actorUserId);

    if (this.hasPassword(user)) {
      throw new PayoutDestinationError("PAYOUT_DESTINATION_STEP_UP_NOT_APPLICABLE", 400);
    }

    const existing = await this.stepUpRepository.findActive(
      user._id,
      business._id,
      STEP_UP_PURPOSE,
    );
    assertOtpResendAllowed(existing?.resendTimestamps ?? [], existing?.sentAt);

    const code = generateNumericOtp(env.OTP_LENGTH);
    const now = new Date();
    const otpExpiresAt = addMinutes(now, env.OTP_EXPIRY_MINUTES);

    await this.stepUpRepository.upsertOtpChallenge(user._id, business._id, STEP_UP_PURPOSE, {
      otpHash: this.hashStepUpOtp(user._id, business._id, code),
      otpExpiresAt,
      sentAt: now,
      resendTimestamps: [...(existing?.resendTimestamps ?? []), now],
      // The slot itself outlives the code so the issued authorization proof (phase 2) has
      // somewhere to live; the TTL index reaps it either way.
      expiresAt: addMinutes(now, env.OTP_EXPIRY_MINUTES + AUTHORIZATION_TTL_MINUTES),
    });

    // Awaited, not fire-and-forget: the user cannot proceed without this code, matching
    // EmailOtpProvider.sendOtp's own documented contract.
    await this.emailOtpProvider.sendOtp({
      to: user.normalizedEmail,
      code,
      purpose: "PAYOUT_DESTINATION_CHANGE",
    });

    logger.info(
      { businessId: String(business._id), userId: String(user._id) },
      "Payout destination step-up OTP sent",
    );

    return { expiresAt: otpExpiresAt.toISOString() };
  }

  /**
   * Step 2. On a correct, unexpired, under-attempt-cap code, mints a short-lived, single-use,
   * user+business+purpose-bound opaque proof. This is NOT an auth session and grants nothing
   * except one payout-destination write on THIS Business.
   */
  public async verifyStepUpOtp(
    actorUserId: string,
    businessId: string,
    code: string,
  ): Promise<{ otpAuthorizationToken: string; expiresAt: string }> {
    const business = await this.requireOwnedPayoutDestinationBusiness(actorUserId, businessId);
    const user = await this.requireUser(actorUserId);

    if (this.hasPassword(user)) {
      throw new PayoutDestinationError("PAYOUT_DESTINATION_STEP_UP_NOT_APPLICABLE", 400);
    }

    const challenge = await this.stepUpRepository.findActive(
      user._id,
      business._id,
      STEP_UP_PURPOSE,
    );

    if (!challenge?.otpHash || !challenge.otpExpiresAt) {
      throw new PayoutDestinationError("PAYOUT_DESTINATION_STEP_UP_INVALID", 400);
    }

    if (challenge.attempts >= env.OTP_MAX_VERIFICATION_ATTEMPTS) {
      throw new AuthError("OTP_ATTEMPTS_EXCEEDED", 429);
    }

    if (challenge.otpExpiresAt <= new Date()) {
      throw new AuthError("OTP_EXPIRED", 400);
    }

    const submitted = this.hashStepUpOtp(user._id, business._id, code);

    if (!safeCompare(submitted, challenge.otpHash)) {
      await this.stepUpRepository.incrementAttempts(challenge._id);
      throw new AuthError("OTP_INVALID", 400);
    }

    const token = createOpaqueToken();
    const now = new Date();
    const authorizationExpiresAt = addMinutes(now, AUTHORIZATION_TTL_MINUTES);

    // Conditional on the OTP still being present — a concurrent duplicate verify loses here
    // rather than minting a second proof, and the code is cleared in the same write.
    const promoted = await this.stepUpRepository.promoteToAuthorization(challenge._id, {
      authorizationTokenHash: this.hashAuthorizationToken(user._id, business._id, token),
      authorizationExpiresAt,
      expiresAt: authorizationExpiresAt,
    });

    if (!promoted) {
      throw new PayoutDestinationError("PAYOUT_DESTINATION_STEP_UP_INVALID", 400);
    }

    logger.info(
      { businessId: String(business._id), userId: String(user._id) },
      "Payout destination step-up OTP verified",
    );

    return { otpAuthorizationToken: token, expiresAt: authorizationExpiresAt.toISOString() };
  }

  // --- Super Admin surface -------------------------------------------------------------------

  /** Masked read — the SAME shape and the SAME builder as the Owner's read; a Super Admin sees
   * no more than an Owner does until they explicitly reveal. No ownership check: the SUPER_ADMIN
   * route gate is the authorization, matching executePayout. */
  public async getForSuperAdmin(businessId: string): Promise<PayoutDestinationView> {
    const business = await this.requireBusiness(businessId);
    const destination = await this.payoutDestinationRepository.findByBusinessId(business._id);
    return this.toView(destination);
  }

  /**
   * The one action in the whole application that returns a decrypted IBAN. SUPER_ADMIN only
   * (route gate), rate-limited (route), and audited here with an `IBAN_REVEALED` history entry
   * that records WHO and WHEN and deliberately NOT what — no IBAN, not even the last 4, beyond
   * what the record already stores.
   *
   * Fails closed: a missing record is a 404-style domain error, and ANY decrypt problem
   * (tampered ciphertext/auth tag, unknown or unconfigured key version, a ciphertext bound to a
   * different Business) surfaces as one 500-class PAYOUT_DESTINATION_DECRYPT_FAILED. A partial
   * or malformed IBAN is never returned, and this method's return value is never logged.
   */
  public async revealIbanForSuperAdmin(
    actorUserId: string,
    businessId: string,
  ): Promise<PayoutDestinationRevealView> {
    const business = await this.requireBusiness(businessId);
    const destination = await this.payoutDestinationRepository.findByBusinessIdWithSecret(
      business._id,
    );

    if (!destination) {
      throw new PayoutDestinationError("PAYOUT_DESTINATION_NOT_CONFIGURED", 404);
    }

    const iban = decryptIban(
      {
        ciphertext: destination.ibanCiphertext,
        iv: destination.ibanIv,
        authTag: destination.ibanAuthTag,
        keyVersion: destination.ibanKeyVersion,
      },
      business._id,
    );

    const revealedAt = new Date();

    // Audited only AFTER a successful decrypt: a failed/tampered read is not a reveal.
    await this.payoutDestinationRepository.appendHistory(business._id, {
      action: "IBAN_REVEALED",
      // Route params are validated as 24-hex before reaching here.
      actorUserId: new Types.ObjectId(actorUserId),
      changedAt: revealedAt,
    });

    // Structured safe fields only. The response body is NEVER logged.
    logger.info(
      { businessId: String(business._id), userId: actorUserId },
      "Payout destination IBAN revealed by Super Admin",
    );

    return {
      iban,
      accountHolderName: destination.accountHolderName,
      ...(destination.bankName === undefined ? {} : { bankName: destination.bankName }),
      revealedAt,
    };
  }

  // --- Internals ------------------------------------------------------------------------------

  /** Mirrors FinanceService.requireOwnedFinanceBusiness exactly, including its deliberate choice
   * to answer "not found" for a Business that exists but is not the actor's — so an Owner cannot
   * probe which Business ids exist. */
  private async requireOwnedPayoutDestinationBusiness(
    actorUserId: string,
    businessId: string,
  ): Promise<BusinessDocument> {
    const business = await this.requireBusiness(businessId);

    if (!business.ownerUserId.equals(actorUserId)) {
      throw new PayoutDestinationError("PAYOUT_DESTINATION_BUSINESS_NOT_FOUND", 404);
    }

    return business;
  }

  private async requireBusiness(businessId: string): Promise<BusinessDocument> {
    if (!/^[a-f\d]{24}$/i.test(businessId)) {
      throw new PayoutDestinationError("PAYOUT_DESTINATION_BUSINESS_NOT_FOUND", 404);
    }

    const business = await this.businessRepository.findById(businessId);

    if (!business) {
      throw new PayoutDestinationError("PAYOUT_DESTINATION_BUSINESS_NOT_FOUND", 404);
    }

    return business;
  }

  private async requireUser(actorUserId: string): Promise<UserDocument> {
    const user = await this.userRepository.findByIdWithPassword(actorUserId);

    if (!user) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return user;
  }

  /** The same `hasPassword` the `GET /auth/me` payload exposes to the frontend (see
   * AuthService.getMe) — one rule, so the UI's step-up branch and this check can never disagree. */
  private hasPassword(user: UserDocument): boolean {
    return resolveAuthProviders(user.authProviders).includes("PASSWORD");
  }

  /**
   * The step-up gate. Which factor is required is decided SERVER-side from the account's own
   * auth providers; a caller cannot pick the weaker one by sending the other field.
   */
  private async requireStepUp(
    user: UserDocument,
    business: BusinessDocument,
    stepUp: UpdatePayoutDestinationBody["stepUp"],
  ): Promise<void> {
    if (this.hasPassword(user)) {
      // Shared helper (auth/require-current-password.ts) — identical behaviour to the four
      // AuthService step-ups, including rejecting an absent password with the same error as a
      // wrong one.
      await requireCurrentPassword(this.passwordHasher, user, stepUp.currentPassword);
      return;
    }

    if (!stepUp.otpAuthorizationToken) {
      throw new PayoutDestinationError("PAYOUT_DESTINATION_STEP_UP_REQUIRED", 400);
    }

    // Single use: the row is DELETED by this call, so the same proof cannot be replayed. The
    // match is bound to user + business + purpose + token hash together.
    const consumed = await this.stepUpRepository.consumeAuthorization({
      userId: user._id,
      businessId: business._id,
      purpose: STEP_UP_PURPOSE,
      authorizationTokenHash: this.hashAuthorizationToken(
        user._id,
        business._id,
        stepUp.otpAuthorizationToken,
      ),
    });

    if (!consumed?.authorizationExpiresAt || consumed.authorizationExpiresAt <= new Date()) {
      throw new PayoutDestinationError("PAYOUT_DESTINATION_STEP_UP_INVALID", 400);
    }
  }

  /**
   * Purpose isolation, belt and braces. The challenge already lives in its own collection keyed
   * by (userId, businessId, purpose), so a contact-change code physically cannot be submitted
   * here and vice versa; binding the purpose INTO the hash means that even if the two
   * collections were ever merged, a code hashed for PAYOUT_DESTINATION_CHANGE could never
   * `safeCompare`-match an EMAIL_CHANGE hash, and vice versa. Same salt scheme as
   * AuthService.hashContactChangeOtp.
   */
  private hashStepUpOtp(userId: Types.ObjectId, businessId: Types.ObjectId, code: string): string {
    return sha256(`${userId}:${STEP_UP_PURPOSE}:${businessId}:${code}:${env.OTP_HASH_SECRET}`);
  }

  private hashAuthorizationToken(
    userId: Types.ObjectId,
    businessId: Types.ObjectId,
    token: string,
  ): string {
    return sha256(
      `${userId}:${STEP_UP_PURPOSE}:AUTHORIZATION:${businessId}:${token}:${env.OTP_HASH_SECRET}`,
    );
  }

  /**
   * The ONE masked projection every read path goes through. It cannot leak the ciphertext/iv/
   * authTag/keyVersion because it never reads those fields — and the schema marks the three
   * secret ones `select: false`, so on a masked read they are not even loaded.
   */
  private toView(destination: PayoutDestinationDocument | null): PayoutDestinationView {
    if (!destination) {
      return { configured: false };
    }

    return {
      configured: true,
      accountHolderName: destination.accountHolderName,
      ibanMasked: buildMaskedIban(destination.ibanCountry, destination.ibanLast4),
      ibanLast4: destination.ibanLast4,
      ibanCountry: destination.ibanCountry,
      ...(destination.bankName === undefined ? {} : { bankName: destination.bankName }),
      updatedAt: destination.updatedAt,
    };
  }

  /**
   * Post-write owner notification. Carries ONLY the business name, the masked IBAN/last 4 and
   * the timestamp — never the full IBAN, never a password, never an OTP.
   *
   * Fire-and-forget with a logged failure, following this codebase's existing convention for
   * post-write security notices (see AuthService.verifyEmailChange's "your email was changed"
   * send, which is `.catch(...)`-logged and deliberately does not roll the committed change
   * back). The destination change is already committed and correct; failing the request over an
   * undelivered notice would be strictly worse for the Owner.
   */
  private notifyOwnerOfChange(
    user: UserDocument,
    business: BusinessDocument,
    ibanCountry: string,
    ibanLast4: string,
    changedAt: Date,
  ): void {
    const masked = buildMaskedIban(ibanCountry, ibanLast4);

    this.emailOtpProvider
      .sendNotice({
        to: user.normalizedEmail,
        subject: "Your Bookly payout bank details were updated",
        text: `The payout bank details for ${business.name} were updated on ${changedAt.toISOString()}. Payouts will now be sent to the account ending ${masked}. If you didn't make this change, please contact support immediately.`,
      })
      .catch((error: unknown) => {
        logger.error(
          { err: error, businessId: String(business._id), userId: String(user._id) },
          "Payout destination change notice failed to send",
        );
      });
  }
}
