import type { ClientSession, Types } from "mongoose";

import type { UserRepository } from "../user/user.repository.js";
import type { CustomerPaymentProfileRepository } from "./customer-payment-profile.repository.js";
import { PaymentError } from "./payment.errors.js";
import type {
  CreateSetupIntentResult,
  PaymentGateway,
  PaymentIntentResult,
  PaymentIntentSnapshot,
  PaymentMethodSummary,
  RefundResult,
} from "./payment.types.js";
import type { PaymentAttemptDocument } from "./payment-attempt.model.js";
import { PaymentAttemptRepository } from "./payment-attempt.repository.js";
import { RefundOperationRepository } from "./refund-operation.repository.js";

export type PaymentAttemptContractCorrelation = {
  version: 2;
  classification: "FIRST" | "RETURNING";
  productKind: "NORMAL_BOOKING" | "PACKAGE_PURCHASE";
  businessClientId: Types.ObjectId | string;
};

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
    private readonly paymentAttemptRepository: PaymentAttemptRepository = new PaymentAttemptRepository(),
    private readonly refundOperationRepository: RefundOperationRepository = new RefundOperationRepository(),
  ) {}

  public async ensureStripeCustomer(
    userId: Types.ObjectId | string,
  ): Promise<{ stripeCustomerId: string }> {
    const [user, profile] = await Promise.all([
      this.userRepository.findById(userId),
      this.userRepository.findProfileByUserId(userId),
    ]);
    if (!user) {
      throw new PaymentError("PAYMENT_CUSTOMER_NOT_FOUND", 404);
    }

    const existing = await this.profileRepository.findByUserId(userId);
    const resolved = await this.gateway.getOrCreateCustomer({
      existingStripeCustomerId: existing?.stripeCustomerId,
      email: user.normalizedEmail,
      name: profile
        ? [profile.firstName, profile.lastName].filter(Boolean).join(" ")
        : user.normalizedEmail,
      metadata: { booklyUserId: String(userId) },
    });

    if (existing) {
      if (!resolved.replacedStaleCustomer) {
        return { stripeCustomerId: resolved.stripeCustomerId };
      }

      const repaired = await this.profileRepository.replaceStaleStripeCustomer({
        userId,
        staleStripeCustomerId: existing.stripeCustomerId,
        replacementStripeCustomerId: resolved.stripeCustomerId,
      });
      if (repaired) {
        return { stripeCustomerId: repaired.stripeCustomerId };
      }

      // A concurrent request already repaired this profile. Its Customer is authoritative;
      // the extra Customer created by this losing request is harmless and never referenced.
      const current = await this.profileRepository.findByUserId(userId);
      if (current) {
        return { stripeCustomerId: current.stripeCustomerId };
      }
      throw new PaymentError("PAYMENT_CUSTOMER_NOT_FOUND", 404);
    }

    const created = await this.profileRepository.createIfMissing(userId, resolved.stripeCustomerId);
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
    const { stripeCustomerId } = await this.ensureStripeCustomer(userId);
    const setupIntent = await this.gateway.retrieveSetupIntent(setupIntentId);
    if (setupIntent.status !== "succeeded" || !setupIntent.paymentMethodId) {
      throw new PaymentError("PAYMENT_METHOD_INVALID", 400);
    }
    if (!setupIntent.customerId || setupIntent.customerId !== stripeCustomerId) {
      throw new PaymentError("PAYMENT_METHOD_INVALID", 400);
    }
    const summary = await this.gateway.getPaymentMethodSummary(setupIntent.paymentMethodId);
    if (!summary.customerId || summary.customerId !== stripeCustomerId) {
      throw new PaymentError("PAYMENT_METHOD_INVALID", 400);
    }
    await this.gateway.setDefaultPaymentMethod({
      stripeCustomerId,
      paymentMethodId: setupIntent.paymentMethodId,
    });
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
    /** P1 — immutable Financial Contract V2 correlation persisted on the PaymentAttempt. */
    financialContract?: PaymentAttemptContractCorrelation | undefined;
    /** P1 — runs after the durable PaymentAttempt exists and BEFORE any provider interaction
     * (e.g. binding a FIRST relationship claim to this attempt). Throwing aborts with no PI. */
    beforeProviderDispatch?: ((attempt: PaymentAttemptDocument) => Promise<void>) | undefined;
  }): Promise<PaymentIntentResult> {
    const profile = await this.profileRepository.findByUserId(input.userId);
    const paymentMethodId = profile?.defaultPaymentMethodId;
    if (!profile || !paymentMethodId) {
      throw new PaymentError("PAYMENT_METHOD_REQUIRED", 402);
    }

    return this.executeDurablePayment({
      userId: input.userId,
      stripeCustomerId: profile.stripeCustomerId,
      paymentMethodId,
      amountCents: input.amountCents,
      currency: "EUR",
      idempotencyKey: input.idempotencyKey,
      offSession: false,
      saveForFutureUse: true,
      metadata: input.metadata,
      financialContract: input.financialContract,
      beforeProviderDispatch: input.beforeProviderDispatch,
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
    currency?: string | undefined;
    sourcePaymentAttemptId?: Types.ObjectId | string | undefined;
    sourceFinancialTransactionId?: Types.ObjectId | string | undefined;
    bookingId?: Types.ObjectId | string | undefined;
    packageProgressId?: Types.ObjectId | string | undefined;
    businessId?: Types.ObjectId | string | undefined;
    customerUserId?: Types.ObjectId | string | undefined;
    businessClientId?: Types.ObjectId | string | undefined;
    domainReason?: string | undefined;
  }): Promise<RefundResult> {
    let amountCents = input.amountCents;
    let currency = input.currency?.toUpperCase();
    if (amountCents === undefined || !currency) {
      const source = await this.requireRetrievePaymentIntent()(input.paymentIntentId);
      amountCents ??= source.amountCents;
      currency ??= source.currency;
    }

    const { operation, isNew } = await this.refundOperationRepository.createOrResumeWithDisposition(
      {
        logicalIdempotencyKey: input.idempotencyKey,
        sourcePaymentIntentId: input.paymentIntentId,
        expectedRefundAmountCents: amountCents,
        currency,
        reason: input.domainReason ?? input.reason ?? "UNSPECIFIED",
        ...(input.sourcePaymentAttemptId
          ? { sourcePaymentAttemptId: input.sourcePaymentAttemptId }
          : {}),
        ...(input.sourceFinancialTransactionId
          ? { sourceFinancialTransactionId: input.sourceFinancialTransactionId }
          : {}),
        ...(input.bookingId ? { bookingId: input.bookingId } : {}),
        ...(input.packageProgressId ? { packageProgressId: input.packageProgressId } : {}),
        ...(input.businessId ? { businessId: input.businessId } : {}),
        ...(input.customerUserId ? { customerUserId: input.customerUserId } : {}),
        ...(input.businessClientId ? { businessClientId: input.businessClientId } : {}),
      },
    );

    if (operation.providerRefundId) {
      const recovered = await this.requireRetrieveRefund()(operation.providerRefundId);
      this.assertRefundMatches(recovered, operation.sourcePaymentIntentId, amountCents, currency);
      const stored = await this.refundOperationRepository.recordProviderResult(operation._id, {
        providerRefundId: recovered.refundId,
        providerStatus: this.toRefundOperationStatus(recovered.status),
      });
      await this.syncCompensationStatus(operation.sourcePaymentAttemptId, stored.providerStatus);
      return { ...recovered, refundOperationId: String(operation._id) };
    }

    if (!isNew || operation.providerCallStartedAt) {
      const lookup = await this.requireFindRefundByMetadata()({
        refundOperationId: String(operation._id),
        paymentIntentId: input.paymentIntentId,
      });
      if (lookup.outcome === "AMBIGUOUS") {
        await this.refundOperationRepository.markReconciliationRequired(
          operation._id,
          "Multiple provider refunds matched one RefundOperation",
        );
        throw new PaymentError("PAYMENT_PROVIDER_CORRELATION_MISMATCH", 409);
      }
      if (lookup.outcome === "FOUND_ONE") {
        const recovered = lookup.value;
        this.assertRefundMatches(recovered, input.paymentIntentId, amountCents, currency);
        const stored = await this.refundOperationRepository.recordProviderResult(operation._id, {
          providerRefundId: recovered.refundId,
          providerStatus: this.toRefundOperationStatus(recovered.status),
        });
        await this.syncCompensationStatus(operation.sourcePaymentAttemptId, stored.providerStatus);
        return { ...recovered, refundOperationId: String(operation._id) };
      }
      if (operation.providerStatus === "FAILED") {
        throw new PaymentError("PAYMENT_REFUND_FAILED", 409);
      }
    }

    const source = await this.requireRetrievePaymentIntent()(input.paymentIntentId);
    if (
      source.paymentIntentId !== input.paymentIntentId ||
      source.currency.toUpperCase() !== currency ||
      amountCents > source.amountCents - source.amountRefundedCents
    ) {
      await this.refundOperationRepository.markFailed(
        operation._id,
        "Refund source, currency, or refundable amount did not match",
      );
      throw new PaymentError("PAYMENT_PROVIDER_CORRELATION_MISMATCH", 409);
    }

    await this.refundOperationRepository.markProviderCallStarted(operation._id);

    try {
      const result = await this.gateway.createRefund({
        paymentIntentId: input.paymentIntentId,
        amountCents,
        idempotencyKey: `refund-operation:${String(operation._id)}`,
        reason: input.reason,
        metadata: {
          booklyRefundOperationId: String(operation._id),
          booklyRefundKey: input.idempotencyKey,
        },
      });
      this.assertRefundMatches(result, input.paymentIntentId, amountCents, currency);
      const stored = await this.refundOperationRepository.recordProviderResult(operation._id, {
        providerRefundId: result.refundId,
        providerStatus: this.toRefundOperationStatus(result.status),
      });
      await this.syncCompensationStatus(operation.sourcePaymentAttemptId, stored.providerStatus);
      return { ...result, refundOperationId: String(operation._id) };
    } catch (error) {
      await this.refundOperationRepository.markReconciliationRequired(
        operation._id,
        error instanceof Error ? error.message : "Ambiguous refund provider response",
      );
      throw error;
    }
  }

  public async findPaymentAttempt(idempotencyKey: string) {
    return this.paymentAttemptRepository.findByLogicalKey(idempotencyKey);
  }

  public async findRefundOperation(idempotencyKey: string) {
    return this.refundOperationRepository.findByLogicalKey(idempotencyKey);
  }

  public async reconcilePaymentAttempt(paymentAttemptId: Types.ObjectId | string) {
    const attempt = await this.paymentAttemptRepository.findById(paymentAttemptId);
    if (!attempt) throw new PaymentError("PAYMENT_FAILED", 404);
    let snapshot: PaymentIntentSnapshot;
    if (attempt.providerPaymentIntentId) {
      snapshot = await this.requireRetrievePaymentIntent()(attempt.providerPaymentIntentId);
    } else {
      const lookup = await this.requireFindPaymentIntentByMetadata()(String(attempt._id));
      if (lookup.outcome === "AMBIGUOUS") {
        await this.paymentAttemptRepository.markProviderUnknown(
          attempt._id,
          "Multiple provider PaymentIntents matched one PaymentAttempt",
        );
        throw new PaymentError("PAYMENT_PROVIDER_CORRELATION_MISMATCH", 409);
      }
      if (lookup.outcome === "NOT_FOUND") return { attempt, snapshot: null };
      snapshot = lookup.value;
    }
    this.assertPaymentMatches(snapshot, attempt, attempt.providerCustomerId);
    const updated = await this.paymentAttemptRepository.recordProviderResult(attempt._id, {
      providerPaymentIntentId: snapshot.paymentIntentId,
      providerStatus: this.toPaymentAttemptStatus(snapshot.status),
      clientSecret: snapshot.clientSecret,
      lastErrorMessage: snapshot.failureMessage,
    });
    return { attempt: updated, snapshot };
  }

  public async claimPaymentPersistence(
    paymentAttemptId: string | undefined,
  ): Promise<string | undefined | null> {
    if (!paymentAttemptId) return undefined;
    return this.paymentAttemptRepository.claimPersistence(paymentAttemptId);
  }

  public async markPaymentCompleted(
    paymentAttemptId: string | undefined,
    input: {
      bookingId: Types.ObjectId | string;
      packageProgressId?: Types.ObjectId | string | undefined;
      succeededTransactionId?: Types.ObjectId | string | undefined;
    },
    persistenceLeaseToken: string | undefined,
    session?: ClientSession,
  ): Promise<boolean> {
    if (!paymentAttemptId) return true;
    if (!persistenceLeaseToken) return false;
    return this.paymentAttemptRepository.markCompleted(
      paymentAttemptId,
      input,
      persistenceLeaseToken,
      session,
    );
  }

  public async markPaymentCompensationRequired(
    paymentAttemptId: string | undefined,
    error: unknown,
    persistenceLeaseToken: string | undefined,
  ): Promise<boolean> {
    if (!paymentAttemptId || !persistenceLeaseToken) return false;
    return this.paymentAttemptRepository.markCompensationRequired(
      paymentAttemptId,
      error instanceof Error ? error.message : "Bookly persistence failed",
      persistenceLeaseToken,
    );
  }

  public async claimPaymentCompensation(
    paymentAttemptId: Types.ObjectId | string,
  ): Promise<string | null> {
    return this.paymentAttemptRepository.claimCompensation(paymentAttemptId);
  }

  public async markRefundLedgerSucceeded(
    refundOperationId: string | undefined,
    ledgerTransactionId: Types.ObjectId | string,
  ): Promise<void> {
    if (refundOperationId) {
      await this.refundOperationRepository.markLedgerSucceeded(
        refundOperationId,
        ledgerTransactionId,
      );
    }
  }

  private async syncCompensationStatus(
    paymentAttemptId: Types.ObjectId | undefined,
    refundStatus: import("./refund-operation.model.js").RefundOperationStatus,
  ): Promise<void> {
    if (!paymentAttemptId) return;
    if (refundStatus === "SUCCEEDED") {
      await this.paymentAttemptRepository.markRefunded(paymentAttemptId);
    } else if (refundStatus === "PROVIDER_PENDING") {
      await this.paymentAttemptRepository.markRefundPending(paymentAttemptId);
    } else if (refundStatus === "FAILED") {
      await this.paymentAttemptRepository.markCompensationFailed(paymentAttemptId);
    }
  }

  private async executeDurablePayment(input: {
    userId: Types.ObjectId | string;
    stripeCustomerId: string;
    paymentMethodId: string;
    amountCents: number;
    currency: string;
    idempotencyKey: string;
    offSession: boolean;
    saveForFutureUse: boolean;
    metadata: Record<string, string>;
    financialContract?: PaymentAttemptContractCorrelation | undefined;
    beforeProviderDispatch?: ((attempt: PaymentAttemptDocument) => Promise<void>) | undefined;
  }): Promise<PaymentIntentResult> {
    const purpose = input.metadata["purpose"] ?? "UNKNOWN";
    const productKind =
      purpose === "BOOKING_DEPOSIT"
        ? ("NORMAL_BOOKING" as const)
        : purpose === "PACKAGE_PURCHASE"
          ? ("PACKAGE_PURCHASE" as const)
          : undefined;
    if (input.financialContract && input.financialContract.productKind !== productKind) {
      throw new PaymentError("PAYMENT_IDEMPOTENCY_CONFLICT", 409);
    }
    const { attempt, isNew } = await this.paymentAttemptRepository.createOrResumeWithDisposition({
      logicalIdempotencyKey: input.idempotencyKey,
      customerUserId: input.userId,
      ...(input.metadata["businessId"] ? { businessId: input.metadata["businessId"] } : {}),
      ...(input.metadata["bookingId"] ? { bookingId: input.metadata["bookingId"] } : {}),
      purpose,
      ...(productKind ? { productKind } : {}),
      ...(input.financialContract
        ? {
            financialContractVersion: input.financialContract.version,
            relationshipClassification: input.financialContract.classification,
            businessClientId: input.financialContract.businessClientId,
          }
        : {}),
      currency: input.currency,
      expectedAmountCents: input.amountCents,
      providerCustomerId: input.stripeCustomerId,
    });

    if (input.beforeProviderDispatch) await input.beforeProviderDispatch(attempt);

    let result: PaymentIntentResult;
    if (attempt.providerPaymentIntentId) {
      const recovered = await this.requireRetrievePaymentIntent()(attempt.providerPaymentIntentId);
      this.assertPaymentMatches(recovered, attempt, input.stripeCustomerId);
      result = recovered;
    } else if (!isNew) {
      const lookup = await this.requireFindPaymentIntentByMetadata()(String(attempt._id));
      if (lookup.outcome === "FOUND_ONE") {
        const recovered = lookup.value;
        this.assertPaymentMatches(recovered, attempt, input.stripeCustomerId);
        result = recovered;
      } else if (lookup.outcome === "AMBIGUOUS") {
        await this.paymentAttemptRepository.markProviderUnknown(
          attempt._id,
          "Multiple provider PaymentIntents matched one PaymentAttempt",
        );
        throw new PaymentError("PAYMENT_PROVIDER_CORRELATION_MISMATCH", 409);
      } else if (attempt.providerStatus === "UNKNOWN") {
        throw new PaymentError("PAYMENT_FAILED", 503);
      } else {
        result = await this.createProviderPaymentIntent(input, attempt);
      }
    } else {
      result = await this.createProviderPaymentIntent(input, attempt);
    }

    const stored = await this.paymentAttemptRepository.recordProviderResult(attempt._id, {
      providerPaymentIntentId: result.paymentIntentId,
      providerStatus: this.toPaymentAttemptStatus(result.status),
      clientSecret: result.clientSecret,
      lastErrorMessage: result.failureMessage,
    });
    return { ...result, paymentAttemptId: String(stored._id) };
  }

  private async createProviderPaymentIntent(
    input: {
      stripeCustomerId: string;
      paymentMethodId: string;
      amountCents: number;
      currency: string;
      idempotencyKey: string;
      offSession: boolean;
      saveForFutureUse: boolean;
      metadata: Record<string, string>;
    },
    attempt: import("./payment-attempt.model.js").PaymentAttemptDocument,
  ): Promise<PaymentIntentResult> {
    try {
      return await this.gateway.createAndConfirmPaymentIntent({
        stripeCustomerId: input.stripeCustomerId,
        paymentMethodId: input.paymentMethodId,
        amountCents: input.amountCents,
        currency: input.currency.toLowerCase(),
        idempotencyKey: `payment-attempt:${String(attempt._id)}`,
        offSession: input.offSession,
        saveForFutureUse: input.saveForFutureUse,
        metadata: {
          ...input.metadata,
          booklyPaymentAttemptId: String(attempt._id),
          booklyPaymentKey: input.idempotencyKey,
          booklyPaymentSchema: "p0-v1",
        },
      });
    } catch (error) {
      await this.paymentAttemptRepository.markProviderUnknown(
        attempt._id,
        error instanceof Error ? error.message : "Ambiguous payment provider response",
      );
      throw error;
    }
  }

  private assertPaymentMatches(
    result: import("./payment.types.js").PaymentIntentSnapshot,
    attempt: import("./payment-attempt.model.js").PaymentAttemptDocument,
    customerId: string,
  ): void {
    if (
      result.amountCents !== attempt.expectedAmountCents ||
      result.currency.toUpperCase() !== attempt.currency ||
      result.customerId !== customerId ||
      (result.metadata["booklyPaymentAttemptId"] &&
        result.metadata["booklyPaymentAttemptId"] !== String(attempt._id))
    ) {
      throw new PaymentError("PAYMENT_PROVIDER_CORRELATION_MISMATCH", 409);
    }
  }

  private assertRefundMatches(
    result: RefundResult,
    paymentIntentId: string,
    amountCents: number,
    currency: string,
  ): void {
    if (
      (result.paymentIntentId && result.paymentIntentId !== paymentIntentId) ||
      (result.amountCents !== undefined && result.amountCents !== amountCents) ||
      (result.currency && result.currency.toUpperCase() !== currency.toUpperCase())
    ) {
      throw new PaymentError("PAYMENT_PROVIDER_CORRELATION_MISMATCH", 409);
    }
  }

  private toPaymentAttemptStatus(
    status: PaymentIntentResult["status"],
  ): import("./payment-attempt.model.js").PaymentAttemptProviderStatus {
    if (status === "succeeded") return "SUCCEEDED";
    if (status === "requires_action") return "REQUIRES_ACTION";
    if (status === "processing") return "PROCESSING";
    return "FAILED";
  }

  private toRefundOperationStatus(
    status: RefundResult["status"],
  ): import("./refund-operation.model.js").RefundOperationStatus {
    if (status === "succeeded") return "SUCCEEDED";
    if (status === "failed") return "FAILED";
    return "PROVIDER_PENDING";
  }

  private requireRetrievePaymentIntent(): NonNullable<PaymentGateway["retrievePaymentIntent"]> {
    if (!this.gateway.retrievePaymentIntent) throw new PaymentError("PAYMENT_FAILED", 503);
    return this.gateway.retrievePaymentIntent.bind(this.gateway);
  }

  private requireFindPaymentIntentByMetadata(): NonNullable<
    PaymentGateway["findPaymentIntentByMetadata"]
  > {
    if (!this.gateway.findPaymentIntentByMetadata) throw new PaymentError("PAYMENT_FAILED", 503);
    return this.gateway.findPaymentIntentByMetadata.bind(this.gateway);
  }

  private requireRetrieveRefund(): NonNullable<PaymentGateway["retrieveRefund"]> {
    if (!this.gateway.retrieveRefund) throw new PaymentError("PAYMENT_REFUND_FAILED", 503);
    return this.gateway.retrieveRefund.bind(this.gateway);
  }

  private requireFindRefundByMetadata(): NonNullable<PaymentGateway["findRefundByMetadata"]> {
    if (!this.gateway.findRefundByMetadata) throw new PaymentError("PAYMENT_REFUND_FAILED", 503);
    return this.gateway.findRefundByMetadata.bind(this.gateway);
  }
}
