import { randomUUID } from "node:crypto";

import type Stripe from "stripe";

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
} from "../../src/modules/payment/payment.types.js";

/**
 * A deterministic, in-memory `PaymentGateway` test double — no network calls, ever (see the
 * Batch 4 final report's "Tests added" section: the normal suite must remain network-independent
 * since this environment has no real Stripe TEST credentials). Every method mirrors
 * StripePaymentGateway's OWN behavior/status vocabulary exactly, so a service written against
 * the `PaymentGateway` interface cannot tell the difference except via the configured outcome.
 *
 * Configure a specific scenario per test via the `*ForNextCharge`/`*ForNextRefund` setters —
 * each is consumed exactly once (defaulting back to "succeeded" afterward) so tests never leak
 * configuration into one another.
 */
export class FakePaymentGateway implements PaymentGateway {
  private customers = new Map<string, { email: string; name: string }>();
  private paymentMethods = new Map<string, PaymentMethodSummary>();
  private setupIntents = new Map<string, SetupIntentStatusResult & { customerId: string }>();
  private idempotentPaymentIntents = new Map<string, PaymentIntentResult>();
  private idempotentRefunds = new Map<string, RefundResult>();

  private nextChargeOutcome: "succeeded" | "requires_action" | "failed" | undefined;
  private nextRefundOutcome: "succeeded" | "failed" | undefined;

  /** Test control surface — never part of the real PaymentGateway interface. */
  public queueNextChargeOutcome(outcome: "succeeded" | "requires_action" | "failed"): void {
    this.nextChargeOutcome = outcome;
  }

  public queueNextRefundOutcome(outcome: "succeeded" | "failed"): void {
    this.nextRefundOutcome = outcome;
  }

  public seedPaymentMethod(paymentMethodId: string, summary: PaymentMethodSummary): void {
    this.paymentMethods.set(paymentMethodId, summary);
  }

  public async getOrCreateCustomer(input: {
    existingStripeCustomerId: string | undefined;
    email: string;
    name: string;
    metadata: Record<string, string>;
  }): Promise<{ stripeCustomerId: string }> {
    void input.metadata;
    if (input.existingStripeCustomerId) {
      return { stripeCustomerId: input.existingStripeCustomerId };
    }
    const stripeCustomerId = `cus_fake_${randomUUID()}`;
    this.customers.set(stripeCustomerId, { email: input.email, name: input.name });
    return { stripeCustomerId };
  }

  public async createSetupIntent(input: {
    stripeCustomerId: string;
  }): Promise<CreateSetupIntentResult> {
    const setupIntentId = `seti_fake_${randomUUID()}`;
    const paymentMethodId = `pm_fake_${randomUUID()}`;
    this.paymentMethods.set(
      paymentMethodId,
      this.paymentMethods.get(paymentMethodId) ?? {
        paymentMethodId,
        brand: "visa",
        last4: "4242",
        expMonth: 12,
        expYear: 2030,
      },
    );
    this.setupIntents.set(setupIntentId, {
      status: "succeeded",
      paymentMethodId,
      customerId: input.stripeCustomerId,
    });
    return { setupIntentId, clientSecret: `${setupIntentId}_secret` };
  }

  public async retrieveSetupIntent(setupIntentId: string): Promise<SetupIntentStatusResult> {
    const found = this.setupIntents.get(setupIntentId);
    if (!found) {
      return { status: "canceled" };
    }
    return { status: found.status, paymentMethodId: found.paymentMethodId };
  }

  public async getPaymentMethodSummary(paymentMethodId: string): Promise<PaymentMethodSummary> {
    const existing = this.paymentMethods.get(paymentMethodId);
    if (existing) {
      return existing;
    }
    const summary: PaymentMethodSummary = {
      paymentMethodId,
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
    };
    this.paymentMethods.set(paymentMethodId, summary);
    return summary;
  }

  public async setDefaultPaymentMethod(_input: {
    stripeCustomerId: string;
    paymentMethodId: string;
  }): Promise<void> {
    // No-op — the fake has no notion of a Customer's default PM beyond what the caller (
    // CustomerPaymentProfileRepository) already persists on our side.
  }

  public async createAndConfirmPaymentIntent(
    input: CreatePaymentIntentInput,
  ): Promise<PaymentIntentResult> {
    const existing = this.idempotentPaymentIntents.get(input.idempotencyKey);
    if (existing) {
      return existing;
    }

    const outcome = this.nextChargeOutcome ?? "succeeded";
    this.nextChargeOutcome = undefined;

    const paymentIntentId = `pi_fake_${randomUUID()}`;
    let result: PaymentIntentResult;

    if (outcome === "succeeded") {
      result = {
        paymentIntentId,
        status: "succeeded",
        balanceTransactionId: `txn_fake_${randomUUID()}`,
      };
    } else if (outcome === "requires_action") {
      result = {
        paymentIntentId,
        status: "requires_action",
        clientSecret: `${paymentIntentId}_secret`,
      };
    } else {
      result = {
        paymentIntentId,
        status: "failed",
        failureMessage: "Your card was declined (test).",
      };
    }

    this.idempotentPaymentIntents.set(input.idempotencyKey, result);
    return result;
  }

  public async createRefund(input: CreateRefundInput): Promise<RefundResult> {
    const existing = this.idempotentRefunds.get(input.idempotencyKey);
    if (existing) {
      return existing;
    }

    const outcome = this.nextRefundOutcome ?? "succeeded";
    this.nextRefundOutcome = undefined;

    const result: RefundResult = {
      refundId: `re_fake_${randomUUID()}`,
      status: outcome,
    };
    this.idempotentRefunds.set(input.idempotencyKey, result);
    return result;
  }

  public async retrieveBalanceTransactionFee(
    _balanceTransactionId: string,
  ): Promise<BalanceTransactionFee | null> {
    return { feeCents: 55, currency: "EUR" };
  }

  private processingFeeOverride: BalanceTransactionFee | null | undefined;

  /** Test control surface — configure the next `retrieveProcessingFeeForPaymentIntent` result
   * (e.g. `null` to simulate "balance transaction not settled yet"). Consumed once. */
  public queueNextProcessingFee(fee: BalanceTransactionFee | null): void {
    this.processingFeeOverride = fee;
  }

  public async retrieveProcessingFeeForPaymentIntent(
    _paymentIntentId: string,
  ): Promise<BalanceTransactionFee | null> {
    if (this.processingFeeOverride !== undefined) {
      const fee = this.processingFeeOverride;
      this.processingFeeOverride = undefined;
      return fee;
    }
    return { feeCents: 55, currency: "EUR" };
  }

  public constructWebhookEvent(_rawBody: Buffer, _signature: string): Stripe.Event {
    throw new Error("FakePaymentGateway does not support real webhook verification");
  }
}
