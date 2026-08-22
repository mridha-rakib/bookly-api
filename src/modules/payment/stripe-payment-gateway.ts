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
  PaymentMethodSummary,
  RefundResult,
  SetupIntentStatusResult,
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
  }): Promise<{ stripeCustomerId: string }> {
    if (input.existingStripeCustomerId) {
      return { stripeCustomerId: input.existingStripeCustomerId };
    }

    const customer = await this.wrap(() =>
      this.client.customers.create({
        email: input.email,
        name: input.name,
        metadata: input.metadata,
      }),
    );
    return { stripeCustomerId: customer.id };
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
    };
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
