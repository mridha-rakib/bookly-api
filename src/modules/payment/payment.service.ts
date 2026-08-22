import type { Types } from "mongoose";

import type { UserRepository } from "../user/user.repository.js";
import type { CustomerPaymentProfileRepository } from "./customer-payment-profile.repository.js";
import { PaymentError } from "./payment.errors.js";
import type {
  CreateSetupIntentResult,
  PaymentGateway,
  PaymentIntentResult,
  PaymentMethodSummary,
  RefundResult,
} from "./payment.types.js";

export type SavedCardStatus = {
  hasSavedCard: boolean;
  card?: { brand: string; last4: string; expMonth: number; expYear: number };
};

/**
 * The Customer-facing payment orchestration layer — composes `PaymentGateway` (Stripe or a test
 * fake) with `CustomerPaymentProfileRepository`. Every money-moving method threads a caller-
 * supplied `idempotencyKey` straight to Stripe's own native idempotency mechanism (Stripe
 * deduplicates identical requests carrying the same key server-side, for up to 24h) — this is
 * the primary defense against a duplicate frontend submit, an HTTP retry, or a browser
 * back/refresh ever producing two real charges for the same logical request.
 */
export class PaymentService {
  public constructor(
    private readonly gateway: PaymentGateway,
    private readonly profileRepository: CustomerPaymentProfileRepository,
    private readonly userRepository: UserRepository,
  ) {}

  public async ensureStripeCustomer(
    userId: Types.ObjectId | string,
  ): Promise<{ stripeCustomerId: string }> {
    const existing = await this.profileRepository.findByUserId(userId);
    if (existing) {
      return { stripeCustomerId: existing.stripeCustomerId };
    }

    const [user, profile] = await Promise.all([
      this.userRepository.findById(userId),
      this.userRepository.findProfileByUserId(userId),
    ]);
    if (!user) {
      throw new PaymentError("PAYMENT_CUSTOMER_NOT_FOUND", 404);
    }

    const { stripeCustomerId } = await this.gateway.getOrCreateCustomer({
      existingStripeCustomerId: undefined,
      email: user.normalizedEmail,
      name: profile
        ? [profile.firstName, profile.lastName].filter(Boolean).join(" ")
        : user.normalizedEmail,
      metadata: { booklyUserId: String(userId) },
    });

    const created = await this.profileRepository.createIfMissing(userId, stripeCustomerId);
    // A concurrent racer may have won createIfMissing's upsert with a DIFFERENT stripeCustomerId
    // than the one just created here (two simultaneous first-time SetupIntent requests) — the
    // now-orphaned Stripe Customer this call created is harmless (never referenced again) and
    // deliberately not deleted here (a best-effort cleanup call is not worth the added failure
    // surface on this hot path); the DB row is always the source of truth going forward.
    return { stripeCustomerId: created.stripeCustomerId };
  }

  public async createSetupIntent(
    userId: Types.ObjectId | string,
  ): Promise<CreateSetupIntentResult> {
    const { stripeCustomerId } = await this.ensureStripeCustomer(userId);
    return this.gateway.createSetupIntent({ stripeCustomerId });
  }

  /**
   * Called once the frontend has confirmed a SetupIntent client-side (via Stripe.js) — resolves
   * the resulting PaymentMethod, sets it as the Stripe Customer's default, and persists safe
   * display metadata. Never called with an unconfirmed SetupIntent id: `retrieveSetupIntent`
   * itself re-verifies status server-side rather than trusting the frontend's claim.
   */
  public async confirmSavedPaymentMethod(
    userId: Types.ObjectId | string,
    setupIntentId: string,
  ): Promise<PaymentMethodSummary> {
    const setupIntent = await this.gateway.retrieveSetupIntent(setupIntentId);
    if (setupIntent.status !== "succeeded" || !setupIntent.paymentMethodId) {
      throw new PaymentError("PAYMENT_METHOD_INVALID", 400);
    }

    const { stripeCustomerId } = await this.ensureStripeCustomer(userId);
    await this.gateway.setDefaultPaymentMethod({
      stripeCustomerId,
      paymentMethodId: setupIntent.paymentMethodId,
    });

    const summary = await this.gateway.getPaymentMethodSummary(setupIntent.paymentMethodId);
    await this.profileRepository.savePaymentMethod({
      userId,
      defaultPaymentMethodId: summary.paymentMethodId,
      cardBrand: summary.brand,
      cardLast4: summary.last4,
      cardExpMonth: summary.expMonth,
      cardExpYear: summary.expYear,
    });

    return summary;
  }

  public async getSavedCardStatus(userId: Types.ObjectId | string): Promise<SavedCardStatus> {
    const profile = await this.profileRepository.findByUserId(userId);
    if (!profile?.defaultPaymentMethodId) {
      return { hasSavedCard: false };
    }

    return {
      hasSavedCard: true,
      card: {
        brand: profile.cardBrand ?? "unknown",
        last4: profile.cardLast4 ?? "0000",
        expMonth: profile.cardExpMonth ?? 0,
        expYear: profile.cardExpYear ?? 0,
      },
    };
  }

  /** The booking-deposit charge — on-session (the customer is actively completing checkout)
   * and always saves the card for future off-session use in the same call. Charged for EVERY
   * BOOKLY_MANAGED booking finalize, first or returning (Batch 6.5 correction) — previously
   * named `chargeActivationFee`, back when this was believed to only ever apply to a first
   * booking. Whether the resulting charge is economically Bookly's activation revenue or a
   * Business-owned prepayment is decided entirely by the caller (see
   * booking-creation.service.ts's persistCustomerBooking), never here — this method only moves
   * money, it has no opinion on who keeps it. */
  public async chargeBookingDeposit(input: {
    userId: Types.ObjectId | string;
    amountCents: number;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<PaymentIntentResult> {
    const profile = await this.profileRepository.findByUserId(input.userId);
    const paymentMethodId = profile?.defaultPaymentMethodId;
    if (!profile || !paymentMethodId) {
      throw new PaymentError("PAYMENT_METHOD_REQUIRED", 402);
    }

    return this.gateway.createAndConfirmPaymentIntent({
      stripeCustomerId: profile.stripeCustomerId,
      paymentMethodId,
      amountCents: input.amountCents,
      currency: "eur",
      idempotencyKey: input.idempotencyKey,
      offSession: false,
      saveForFutureUse: true,
      metadata: input.metadata,
    });
  }

  /** Cancellation/no-show auto-charges — the customer is not present, so this is always
   * off-session against the previously-saved default payment method. */
  public async chargeOffSession(input: {
    userId: Types.ObjectId | string;
    amountCents: number;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<PaymentIntentResult> {
    const profile = await this.profileRepository.findByUserId(input.userId);
    const paymentMethodId = profile?.defaultPaymentMethodId;
    if (!profile || !paymentMethodId) {
      throw new PaymentError("PAYMENT_METHOD_REQUIRED", 402);
    }

    return this.gateway.createAndConfirmPaymentIntent({
      stripeCustomerId: profile.stripeCustomerId,
      paymentMethodId,
      amountCents: input.amountCents,
      currency: "eur",
      idempotencyKey: input.idempotencyKey,
      offSession: true,
      saveForFutureUse: false,
      metadata: input.metadata,
    });
  }

  public async refund(input: {
    paymentIntentId: string;
    amountCents?: number | undefined;
    idempotencyKey: string;
    reason?: string | undefined;
  }): Promise<RefundResult> {
    return this.gateway.createRefund(input);
  }
}
