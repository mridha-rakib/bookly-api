import type Stripe from "stripe";

/**
 * The full payment-provider surface every payment/lifecycle service is written against —
 * never the `stripe` SDK directly (see stripe-payment-gateway.ts's own comment). This is what
 * makes the money-movement logic (PaymentService, BookingCreationService's finalize path,
 * BookingLifecycleService's cancellation/no-show charge paths) unit-testable without a network
 * call: production wires StripePaymentGateway; tests inject a deterministic fake implementing
 * this exact interface (see tests/support/fake-payment-gateway.ts) — matching this codebase's
 * existing repository/service dependency-injection convention throughout every other module.
 */

export type PaymentMethodSummary = {
  paymentMethodId: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
};

export type CreateSetupIntentResult = {
  setupIntentId: string;
  clientSecret: string;
};

export type SetupIntentStatusResult = {
  status: "succeeded" | "requires_action" | "requires_payment_method" | "processing" | "canceled";
  paymentMethodId?: string | undefined;
};

export type CreatePaymentIntentInput = {
  stripeCustomerId: string;
  paymentMethodId: string;
  amountCents: number;
  currency: string;
  /** Passed to Stripe as its own native Idempotency-Key header — the primary defense against a
   * duplicate frontend submit or HTTP retry ever producing two charges for the same logical
   * request (see PaymentService's own doc comment). */
  idempotencyKey: string;
  /** true for a charge with no customer actively present in the checkout flow (cancellation/
   * no-show auto-charges) — Stripe requires the payment method to have been saved with
   * `setup_future_usage` for this to succeed without a fresh authentication challenge. */
  offSession: boolean;
  /** true only for the very first (on-session) activation charge — saves the payment method
   * for later off-session use in the SAME API call (Stripe's `setup_future_usage: off_session`),
   * so a Customer never needs a second, separate SetupIntent immediately after paying. */
  saveForFutureUse: boolean;
  metadata: Record<string, string>;
};

export type PaymentIntentResult = {
  paymentIntentId: string;
  status: "succeeded" | "requires_action" | "processing" | "failed";
  clientSecret?: string | undefined;
  /** A short, safe-to-display summary (e.g. "Your card was declined") — never the raw Stripe
   * error object/message passed straight through (see PaymentError's own comment). */
  failureMessage?: string | undefined;
  /** Present once Stripe reports the underlying balance transaction — the authoritative source
   * for the real processing-fee amount (see rule #12 / PROCESSING_FEE ledger entries). Absent
   * on a synchronous confirm response; populated later from the `payment_intent.succeeded`
   * webhook once Stripe has settled the charge and expanded balance_transaction. */
  balanceTransactionId?: string | undefined;
};

export type CreateRefundInput = {
  paymentIntentId: string;
  /** Omit for a full refund. */
  amountCents?: number | undefined;
  idempotencyKey: string;
  reason?: string | undefined;
};

export type RefundResult = {
  refundId: string;
  status: "succeeded" | "pending" | "failed";
};

export type BalanceTransactionFee = {
  feeCents: number;
  currency: string;
};

export interface PaymentGateway {
  getOrCreateCustomer(input: {
    existingStripeCustomerId: string | undefined;
    email: string;
    name: string;
    metadata: Record<string, string>;
  }): Promise<{ stripeCustomerId: string }>;

  createSetupIntent(input: { stripeCustomerId: string }): Promise<CreateSetupIntentResult>;

  retrieveSetupIntent(setupIntentId: string): Promise<SetupIntentStatusResult>;

  /** Resolves a PaymentMethod id (already attached to the Customer, e.g. via a confirmed
   * SetupIntent) to safe, storable display metadata — never the full card object. */
  getPaymentMethodSummary(paymentMethodId: string): Promise<PaymentMethodSummary>;

  setDefaultPaymentMethod(input: {
    stripeCustomerId: string;
    paymentMethodId: string;
  }): Promise<void>;

  createAndConfirmPaymentIntent(input: CreatePaymentIntentInput): Promise<PaymentIntentResult>;

  createRefund(input: CreateRefundInput): Promise<RefundResult>;

  retrieveBalanceTransactionFee(
    balanceTransactionId: string,
  ): Promise<BalanceTransactionFee | null>;

  /** Batch 7 (Finance) — resolves the real Stripe processing-fee amount for an already-succeeded
   * PaymentIntent by re-fetching it with `latest_charge.balance_transaction` expanded (the
   * synchronous confirm response almost never has this yet — see PaymentIntentResult's own
   * comment). Returns `null` when the balance transaction is not yet available (e.g. called too
   * soon after settlement) — the caller treats this as "no PROCESSING_FEE entry recorded this
   * time", never as an error; a future webhook retry (this codebase's existing reconciliation
   * pattern) gets another chance. */
  retrieveProcessingFeeForPaymentIntent(
    paymentIntentId: string,
  ): Promise<BalanceTransactionFee | null>;

  /** Verifies the Stripe-Signature header against the RAW request body and returns the parsed
   * event — throws PAYMENT_WEBHOOK_SIGNATURE_INVALID on any mismatch. Never trust an
   * unverified webhook payload (see stripe-webhook.route.ts's own comment on raw-body mounting). */
  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event;
}
