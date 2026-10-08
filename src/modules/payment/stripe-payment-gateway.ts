import type Stripe from "stripe";

import { env } from "../../config/env.js";
import { PaymentError } from "./payment.errors.js";
import type {
  BalanceTransactionFee,
  CreatePaymentIntentInput,
  CreateRefundInput,
  CreateSetupIntentResult,
  PaymentGateway,
  PaymentIntentResult,
  PaymentIntentSnapshot,
  PaymentMethodSummary,
  ProviderLookupResult,
  RefundResult,
  SetupIntentStatusResult,
  TaxAssociationResult,
} from "./payment.types.js";
import { getStripeClient } from "./stripe-client.js";

/**
 * The only file in this codebase allowed to import the `stripe` SDK directly — every service
 * (PaymentService, BookingCreationService, BookingLifecycleService, the no-show worker) depends
 * on the `PaymentGateway` interface only (see payment.types.ts), never this class, matching this
 * codebase's existing repository-abstraction convention. `failureMessage` on a failed/declined
 * result is always a short Stripe-provided `decline_code`/`message` summary — safe to show a
 * customer — never a dump of the raw Stripe error object (which can contain the request's own
 * parameters).
 */
export class StripePaymentGateway implements PaymentGateway {
  private get client(): Stripe {
    return getStripeClient();
  }

  public async getOrCreateCustomer(input: {
    existingStripeCustomerId: string | undefined;
    email: string;
    name: string;
    metadata: Record<string, string>;
  }): Promise<{ stripeCustomerId: string; replacedStaleCustomer?: boolean }> {
    if (input.existingStripeCustomerId) {
      try {
        const customer = await this.client.customers.retrieve(input.existingStripeCustomerId);
        if (!customer.deleted) {
          return { stripeCustomerId: input.existingStripeCustomerId };
        }
      } catch (error) {
        if (!this.isMissingStripeCustomer(error)) {
          const stripeError = this.asStripeError(error);
          throw new PaymentError("PAYMENT_FAILED", 502, [
            { message: this.safeDeclineMessage(stripeError), code: "PAYMENT_FAILED" },
          ]);
        }
      }
    }

    const customer = await this.wrap(() =>
      this.client.customers.create({
        email: input.email,
        name: input.name,
        metadata: input.metadata,
      }),
    );
    return {
      stripeCustomerId: customer.id,
      ...(input.existingStripeCustomerId ? { replacedStaleCustomer: true } : {}),
    };
  }

  public async createSetupIntent(input: {
    stripeCustomerId: string;
  }): Promise<CreateSetupIntentResult> {
    const setupIntent = await this.wrap(() =>
      this.client.setupIntents.create({
        customer: input.stripeCustomerId,
        usage: "off_session",
        automatic_payment_methods: { enabled: true },
      }),
    );

    if (!setupIntent.client_secret) {
      throw new PaymentError("PAYMENT_METHOD_INVALID", 502);
    }

    return { setupIntentId: setupIntent.id, clientSecret: setupIntent.client_secret };
  }

  public async retrieveSetupIntent(setupIntentId: string): Promise<SetupIntentStatusResult> {
    const setupIntent = await this.wrap(() => this.client.setupIntents.retrieve(setupIntentId));

    return {
      status: setupIntent.status as SetupIntentStatusResult["status"],
      paymentMethodId:
        typeof setupIntent.payment_method === "string"
          ? setupIntent.payment_method
          : setupIntent.payment_method?.id,
      customerId:
        typeof setupIntent.customer === "string" ? setupIntent.customer : setupIntent.customer?.id,
    };
  }

  public async getPaymentMethodSummary(paymentMethodId: string): Promise<PaymentMethodSummary> {
    const paymentMethod = await this.wrap(() =>
      this.client.paymentMethods.retrieve(paymentMethodId),
    );

    if (!paymentMethod.card) {
      throw new PaymentError("PAYMENT_METHOD_INVALID", 400);
    }

    return {
      paymentMethodId: paymentMethod.id,
      customerId:
        typeof paymentMethod.customer === "string"
          ? paymentMethod.customer
          : paymentMethod.customer?.id,
      brand: paymentMethod.card.brand,
      last4: paymentMethod.card.last4,
      expMonth: paymentMethod.card.exp_month,
      expYear: paymentMethod.card.exp_year,
    };
  }

  public async setDefaultPaymentMethod(input: {
    stripeCustomerId: string;
    paymentMethodId: string;
  }): Promise<void> {
    await this.wrap(() =>
      this.client.customers.update(input.stripeCustomerId, {
        invoice_settings: { default_payment_method: input.paymentMethodId },
      }),
    );
  }

  public async createAndConfirmPaymentIntent(
    input: CreatePaymentIntentInput,
  ): Promise<PaymentIntentResult> {
    if (!input.idempotencyKey) {
      throw new PaymentError("PAYMENT_IDEMPOTENCY_KEY_REQUIRED", 400);
    }

    try {
      const paymentIntent = await this.client.paymentIntents.create(
        {
          amount: input.amountCents,
          currency: input.currency.toLowerCase(),
          customer: input.stripeCustomerId,
          payment_method: input.paymentMethodId,
          confirm: true,
          off_session: input.offSession,
          ...(input.saveForFutureUse ? { setup_future_usage: "off_session" } : {}),
          metadata: input.metadata,
          // Card-only for now — no other payment method types are wired in the frontend (see
          // the Batch 4 final report's frontend-wiring section).
          payment_method_types: ["card"],
        },
        { idempotencyKey: input.idempotencyKey },
      );

      return this.toPaymentIntentResult(paymentIntent);
    } catch (error) {
      return this.toFailedPaymentIntentResult(error);
    }
  }

  public async createRefund(input: CreateRefundInput): Promise<RefundResult> {
    const refund = await this.wrap(
      () =>
        this.client.refunds.create(
          {
            payment_intent: input.paymentIntentId,
            ...(input.amountCents !== undefined ? { amount: input.amountCents } : {}),
            ...(input.reason ? { reason: this.toStripeRefundReason(input.reason) } : {}),
            ...(input.metadata ? { metadata: input.metadata } : {}),
          },
          { idempotencyKey: input.idempotencyKey },
        ),
      "PAYMENT_REFUND_FAILED",
    );

    return {
      refundId: refund.id,
      status:
        refund.status === "succeeded"
          ? "succeeded"
          : refund.status === "failed"
            ? "failed"
            : "pending",
      paymentIntentId:
        typeof refund.payment_intent === "string"
          ? refund.payment_intent
          : refund.payment_intent?.id,
      amountCents: refund.amount,
      currency: refund.currency.toUpperCase(),
      metadata: refund.metadata ?? undefined,
    };
  }

  public async retrievePaymentIntent(paymentIntentId: string): Promise<PaymentIntentSnapshot> {
    const paymentIntent = await this.wrap(() =>
      this.client.paymentIntents.retrieve(paymentIntentId, {
        expand: ["latest_charge.balance_transaction"],
      }),
    );
    return this.toPaymentIntentSnapshot(paymentIntent);
  }

  public async findPaymentIntentByMetadata(
    paymentAttemptId: string,
  ): Promise<ProviderLookupResult<PaymentIntentSnapshot>> {
    const escaped = paymentAttemptId.replaceAll("'", "\\'");
    const result = await this.wrap(() =>
      this.client.paymentIntents.search({
        query: `metadata['booklyPaymentAttemptId']:'${escaped}'`,
        limit: 2,
      }),
    );
    if (result.data.length === 0) return { outcome: "NOT_FOUND" };
    if (result.data.length > 1) return { outcome: "AMBIGUOUS" };
    return {
      outcome: "FOUND_ONE",
      value: this.toPaymentIntentSnapshot(result.data[0] as Stripe.PaymentIntent),
    };
  }

  public async retrieveRefund(refundId: string): Promise<RefundResult> {
    const refund = await this.wrap(
      () => this.client.refunds.retrieve(refundId),
      "PAYMENT_REFUND_FAILED",
    );
    return this.toRefundResult(refund);
  }

  public async findRefundByMetadata(input: {
    refundOperationId: string;
    paymentIntentId: string;
  }): Promise<ProviderLookupResult<RefundResult>> {
    const matches: Stripe.Refund[] = [];
    let startingAfter: string | undefined;
    do {
      const page = await this.wrap(
        () =>
          this.client.refunds.list({
            payment_intent: input.paymentIntentId,
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          }),
        "PAYMENT_REFUND_FAILED",
      );
      for (const refund of page.data) {
        if (refund.metadata?.["booklyRefundOperationId"] === input.refundOperationId) {
          matches.push(refund);
          if (matches.length > 1) return { outcome: "AMBIGUOUS" };
        }
      }
      startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
      if (page.has_more && !startingAfter) return { outcome: "AMBIGUOUS" };
    } while (startingAfter);

    if (matches.length === 0) return { outcome: "NOT_FOUND" };
    return { outcome: "FOUND_ONE", value: this.toRefundResult(matches[0] as Stripe.Refund) };
  }

  public async retrieveBalanceTransactionFee(
    balanceTransactionId: string,
  ): Promise<BalanceTransactionFee | null> {
    const balanceTransaction = await this.wrap(() =>
      this.client.balanceTransactions.retrieve(balanceTransactionId),
    );
    return {
      feeCents: balanceTransaction.fee,
      currency: balanceTransaction.currency.toUpperCase(),
    };
  }

  public async retrieveProcessingFeeForPaymentIntent(
    paymentIntentId: string,
  ): Promise<BalanceTransactionFee | null> {
    const paymentIntent = await this.wrap(() =>
      this.client.paymentIntents.retrieve(paymentIntentId, {
        expand: ["latest_charge.balance_transaction"],
      }),
    );

    const charge =
      typeof paymentIntent.latest_charge === "object" ? paymentIntent.latest_charge : undefined;
    const balanceTransaction =
      charge && typeof charge.balance_transaction === "object"
        ? charge.balance_transaction
        : undefined;

    if (!balanceTransaction) {
      return null;
    }

    return {
      feeCents: balanceTransaction.fee,
      currency: balanceTransaction.currency.toUpperCase(),
    };
  }

  public async findTaxAssociation(paymentIntentId: string): Promise<TaxAssociationResult | null> {
    try {
      // Stripe documents simplified PaymentIntent Tax as public preview and requires this
      // request-level version. Do not pin/bump the global Stripe client: existing non-tax
      // PaymentIntent behavior must remain on the account/default version until activation.
      const association = await this.client.tax.associations.find(
        { payment_intent: paymentIntentId },
        { apiVersion: "2025-05-28.preview" },
      );
      const attempts = association.tax_transaction_attempts ?? [];
      const paymentAttempt = attempts.find((attempt) => attempt.source === paymentIntentId);
      return {
        taxCalculationId: association.calculation,
        ...(paymentAttempt?.committed
          ? { taxTransactionId: paymentAttempt.committed.transaction }
          : {}),
        ...(paymentAttempt?.errored ? { terminalErrorReason: paymentAttempt.errored.reason } : {}),
      };
    } catch (error) {
      // Stripe returns resource_missing while its association is eventually consistent. The
      // caller deliberately treats null as retryable rather than consuming reconciliation.
      if (this.isMissingTaxAssociation(error)) return null;
      throw error;
    }
  }

  public constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    if (!env.STRIPE_WEBHOOK_SECRET) {
      throw new PaymentError("PAYMENT_PROVIDER_NOT_CONFIGURED", 503);
    }

    try {
      return this.client.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch {
      throw new PaymentError("PAYMENT_WEBHOOK_SIGNATURE_INVALID", 400);
    }
  }

  // --- Internal helpers ---------------------------------------------------------------------

  private toPaymentIntentResult(paymentIntent: Stripe.PaymentIntent): PaymentIntentResult {
    const balanceTransactionId =
      typeof paymentIntent.latest_charge === "object" && paymentIntent.latest_charge
        ? this.extractBalanceTransactionId(paymentIntent.latest_charge)
        : undefined;

    if (paymentIntent.status === "succeeded") {
      return {
        paymentIntentId: paymentIntent.id,
        status: "succeeded",
        ...(balanceTransactionId ? { balanceTransactionId } : {}),
      };
    }

    if (
      paymentIntent.status === "requires_action" ||
      paymentIntent.status === "requires_confirmation"
    ) {
      return {
        paymentIntentId: paymentIntent.id,
        status: "requires_action",
        clientSecret: paymentIntent.client_secret ?? undefined,
      };
    }

    if (paymentIntent.status === "processing") {
      return { paymentIntentId: paymentIntent.id, status: "processing" };
    }

    return {
      paymentIntentId: paymentIntent.id,
      status: "failed",
      failureMessage: "The payment could not be completed.",
    };
  }

  private toPaymentIntentSnapshot(paymentIntent: Stripe.PaymentIntent): PaymentIntentSnapshot {
    return {
      ...this.toPaymentIntentResult(paymentIntent),
      amountCents: paymentIntent.amount,
      amountRefundedCents:
        typeof paymentIntent.latest_charge === "object" && paymentIntent.latest_charge
          ? paymentIntent.latest_charge.amount_refunded
          : 0,
      currency: paymentIntent.currency.toUpperCase(),
      customerId:
        typeof paymentIntent.customer === "string"
          ? paymentIntent.customer
          : paymentIntent.customer?.id,
      metadata: paymentIntent.metadata,
    };
  }

  private toRefundResult(refund: Stripe.Refund): RefundResult {
    return {
      refundId: refund.id,
      status:
        refund.status === "succeeded"
          ? "succeeded"
          : refund.status === "failed" || refund.status === "canceled"
            ? "failed"
            : "pending",
      paymentIntentId:
        typeof refund.payment_intent === "string"
          ? refund.payment_intent
          : refund.payment_intent?.id,
      amountCents: refund.amount,
      currency: refund.currency.toUpperCase(),
      metadata: refund.metadata ?? undefined,
    };
  }

  private extractBalanceTransactionId(charge: Stripe.Charge): string | undefined {
    return typeof charge.balance_transaction === "string"
      ? charge.balance_transaction
      : charge.balance_transaction?.id;
  }

  private toFailedPaymentIntentResult(error: unknown): PaymentIntentResult {
    const stripeError = this.asStripeError(error);

    if (stripeError?.payment_intent) {
      const paymentIntent = stripeError.payment_intent;
      if (paymentIntent.status === "requires_action") {
        return {
          paymentIntentId: paymentIntent.id,
          status: "requires_action",
          clientSecret: paymentIntent.client_secret ?? undefined,
        };
      }
      return {
        paymentIntentId: paymentIntent.id,
        status: "failed",
        failureMessage: this.safeDeclineMessage(stripeError),
      };
    }

    // No PaymentIntent was ever created (e.g. a request-validation error) — this is a hard
    // failure the caller must treat as "no charge occurred, nothing to reconcile."
    throw new PaymentError("PAYMENT_FAILED", 402, [
      { message: this.safeDeclineMessage(stripeError), code: "PAYMENT_FAILED" },
    ]);
  }

  private safeDeclineMessage(
    stripeError: { message?: string; decline_code?: string } | undefined,
  ): string {
    return stripeError?.decline_code
      ? `Your card was declined (${stripeError.decline_code}).`
      : (stripeError?.message ?? "The payment could not be completed.");
  }

  private asStripeError(
    error: unknown,
  ):
    | { message?: string; decline_code?: string; payment_intent?: Stripe.PaymentIntent }
    | undefined {
    if (typeof error === "object" && error !== null && "type" in error) {
      return error as {
        message?: string;
        decline_code?: string;
        payment_intent?: Stripe.PaymentIntent;
      };
    }
    return undefined;
  }

  private isMissingStripeCustomer(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      "code" in error &&
      (error as { type?: unknown }).type === "StripeInvalidRequestError" &&
      (error as { code?: unknown }).code === "resource_missing"
    );
  }

  private isMissingTaxAssociation(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      "code" in error &&
      (error as { type?: unknown }).type === "StripeInvalidRequestError" &&
      (error as { code?: unknown }).code === "resource_missing"
    );
  }

  private toStripeRefundReason(reason: string): Stripe.RefundCreateParams.Reason {
    if (reason === "duplicate" || reason === "fraudulent" || reason === "requested_by_customer") {
      return reason;
    }
    return "requested_by_customer";
  }

  private async wrap<T>(
    fn: () => Promise<T>,
    errorCode:
      | "PAYMENT_FAILED"
      | "PAYMENT_REFUND_FAILED"
      | "PAYMENT_METHOD_INVALID" = "PAYMENT_FAILED",
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const stripeError = this.asStripeError(error);
      throw new PaymentError(errorCode, 502, [
        { message: this.safeDeclineMessage(stripeError), code: errorCode },
      ]);
    }
  }
}
