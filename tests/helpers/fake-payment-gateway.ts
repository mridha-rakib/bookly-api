import { randomUUID } from "node:crypto";

import type Stripe from "stripe";

import type {
  BalanceTransactionFee,
  CreatePaymentIntentInput,
  CreateRefundInput,
  CreateSetupIntentResult,
  DisputeSnapshot,
  PaymentGateway,
  PaymentIntentResult,
  PaymentIntentSnapshot,
  PaymentMethodSummary,
  ProviderLookupResult,
  RefundResult,
  SetupIntentStatusResult,
  TaxAssociationResult,
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
  public paymentIntentInputs: CreatePaymentIntentInput[] = [];
  public refundInputs: CreateRefundInput[] = [];
  private customers = new Map<string, { email: string; name: string }>();
  private paymentMethods = new Map<string, PaymentMethodSummary>();
  private setupIntents = new Map<string, SetupIntentStatusResult & { customerId: string }>();
  private idempotentPaymentIntents = new Map<string, PaymentIntentResult>();
  private idempotentRefunds = new Map<string, RefundResult>();

  private nextChargeOutcome: "succeeded" | "requires_action" | "failed" | undefined;
  private nextRefundOutcome: "succeeded" | "pending" | "failed" | undefined;

  /** Test control surface — never part of the real PaymentGateway interface. */
  public queueNextChargeOutcome(outcome: "succeeded" | "requires_action" | "failed"): void {
    this.nextChargeOutcome = outcome;
  }

  public queueNextRefundOutcome(outcome: "succeeded" | "pending" | "failed"): void {
    this.nextRefundOutcome = outcome;
  }

  private nextChargeLostResponse: Error | undefined;
  private nextChargeThrowBeforeCreate: Error | undefined;

  /** Test control (P5): the next PaymentIntent IS created at the provider (with the queued
   * outcome) but the response is lost — the call throws like a timeout/connection error. */
  public queueNextChargeLostResponse(error = new Error("Request timed out (test)")): void {
    this.nextChargeLostResponse = error;
  }

  /** Test control (P5): the next create call throws WITHOUT creating any PaymentIntent (e.g. a
   * detached card rejected before a PI exists, or a network failure before reaching Stripe). */
  public queueNextChargeThrowBeforeCreate(error = new Error("No such PaymentMethod (test)")): void {
    this.nextChargeThrowBeforeCreate = error;
  }

  public succeedRefund(refundId: string): void {
    for (const [key, value] of this.idempotentRefunds) {
      if (value.refundId === refundId) {
        this.idempotentRefunds.set(key, { ...value, status: "succeeded" });
        return;
      }
    }
    throw new Error("Unknown fake Refund");
  }

  public succeedPaymentIntent(paymentIntentId: string): void {
    this.setPaymentIntentStatus(paymentIntentId, "succeeded");
  }

  /** Test control: moves an existing fake PaymentIntent to another provider state — e.g. a 3DS
   * failure (`failed` = Stripe requires_payment_method) or a Dashboard cancel (`canceled`). */
  public setPaymentIntentStatus(
    paymentIntentId: string,
    status: PaymentIntentResult["status"],
  ): void {
    for (const [key, value] of this.idempotentPaymentIntents) {
      if (value.paymentIntentId === paymentIntentId) {
        this.idempotentPaymentIntents.set(key, {
          paymentIntentId,
          status,
          ...(status === "requires_action" ? { clientSecret: `${paymentIntentId}_secret` } : {}),
          ...(status === "failed" ? { failureMessage: "Authentication failed (test)." } : {}),
          ...(status === "canceled"
            ? { failureMessage: "The payment was canceled.", cancellationReason: "abandoned" }
            : {}),
        });
        return;
      }
    }
    throw new Error("Unknown fake PaymentIntent");
  }

  /** Every PaymentIntent id `retrievePaymentIntent` was asked for, in order. */
  public retrievedPaymentIntentIds: string[] = [];
  private nextRetrieveError: Error | undefined;

  /** Test control: the next `retrievePaymentIntent` call throws (a transient provider error). */
  public failNextRetrieve(error: Error): void {
    this.nextRetrieveError = error;
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
        customerId: input.stripeCustomerId,
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
    return {
      status: found.status,
      paymentMethodId: found.paymentMethodId,
      customerId: found.customerId,
    };
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
    if (this.nextChargeThrowBeforeCreate) {
      const error = this.nextChargeThrowBeforeCreate;
      this.nextChargeThrowBeforeCreate = undefined;
      throw error;
    }
    this.paymentIntentInputs.push(input);
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
    if (this.nextChargeLostResponse) {
      const error = this.nextChargeLostResponse;
      this.nextChargeLostResponse = undefined;
      throw error;
    }
    return result;
  }

  /** Every PaymentIntent the fake has created, in creation order (P5 one-PI-per-attempt checks). */
  public createdPaymentIntentIds(): string[] {
    return [...new Set([...this.idempotentPaymentIntents.values()].map((r) => r.paymentIntentId))];
  }

  public async retrievePaymentIntent(paymentIntentId: string): Promise<PaymentIntentSnapshot> {
    this.retrievedPaymentIntentIds.push(paymentIntentId);
    if (this.nextRetrieveError) {
      const error = this.nextRetrieveError;
      this.nextRetrieveError = undefined;
      throw error;
    }
    return this.snapshotOf(paymentIntentId);
  }

  private snapshotOf(paymentIntentId: string): PaymentIntentSnapshot {
    const found = [...this.idempotentPaymentIntents.values()].find(
      (entry) => entry.paymentIntentId === paymentIntentId,
    );
    if (!found) throw new Error("Unknown fake PaymentIntent");
    const input = this.paymentIntentInputs.find(
      (entry) =>
        this.idempotentPaymentIntents.get(entry.idempotencyKey)?.paymentIntentId ===
        paymentIntentId,
    );
    if (!input) throw new Error("Missing fake PaymentIntent input");
    return {
      ...found,
      amountCents: input.amountCents,
      amountRefundedCents: 0,
      currency: input.currency.toUpperCase(),
      customerId: input.stripeCustomerId,
      metadata: input.metadata,
    };
  }

  /** Test control: Stripe search is eventually consistent — while true, metadata search misses
   * every PaymentIntent (the customer-scoped list below stays strongly consistent). */
  public searchLagging = false;
  public customerListCalls = 0;
  private nextCustomerListError: Error | undefined;

  /** Test control: the next customer-scoped list call throws (a transient provider error). */
  public failNextCustomerList(error: Error): void {
    this.nextCustomerListError = error;
  }

  public async findCustomerPaymentIntentByAttempt(input: {
    stripeCustomerId: string;
    paymentAttemptId: string;
    createdSince: Date;
  }): Promise<ProviderLookupResult<PaymentIntentSnapshot>> {
    this.customerListCalls += 1;
    if (this.nextCustomerListError) {
      const error = this.nextCustomerListError;
      this.nextCustomerListError = undefined;
      throw error;
    }
    const paymentIntentIds = new Set(
      this.paymentIntentInputs
        .filter(
          (entry) =>
            entry.stripeCustomerId === input.stripeCustomerId &&
            entry.metadata["booklyPaymentAttemptId"] === input.paymentAttemptId,
        )
        .map((entry) => this.idempotentPaymentIntents.get(entry.idempotencyKey)?.paymentIntentId)
        .filter((id): id is string => Boolean(id)),
    );
    if (paymentIntentIds.size === 0) return { outcome: "NOT_FOUND" };
    if (paymentIntentIds.size > 1) return { outcome: "AMBIGUOUS" };
    return { outcome: "FOUND_ONE", value: this.snapshotOf([...paymentIntentIds][0] as string) };
  }

  public async findPaymentIntentByMetadata(
    paymentAttemptId: string,
  ): Promise<ProviderLookupResult<PaymentIntentSnapshot>> {
    if (this.searchLagging) return { outcome: "NOT_FOUND" };
    const inputs = this.paymentIntentInputs.filter(
      (entry) => entry.metadata["booklyPaymentAttemptId"] === paymentAttemptId,
    );
    if (inputs.length === 0) return { outcome: "NOT_FOUND" };
    if (inputs.length > 1) return { outcome: "AMBIGUOUS" };
    const input = inputs[0] as CreatePaymentIntentInput;
    const result = this.idempotentPaymentIntents.get(input.idempotencyKey);
    return result
      ? { outcome: "FOUND_ONE", value: await this.retrievePaymentIntent(result.paymentIntentId) }
      : { outcome: "NOT_FOUND" };
  }

  public async createRefund(input: CreateRefundInput): Promise<RefundResult> {
    this.refundInputs.push(input);
    const existing = this.idempotentRefunds.get(input.idempotencyKey);
    if (existing) {
      return existing;
    }

    const outcome = this.nextRefundOutcome ?? "succeeded";
    this.nextRefundOutcome = undefined;

    const result: RefundResult = {
      refundId: `re_fake_${randomUUID()}`,
      status: outcome,
      paymentIntentId: input.paymentIntentId,
      amountCents: input.amountCents,
      currency: "EUR",
      metadata: input.metadata,
      createdAt: new Date(),
    };
    this.idempotentRefunds.set(input.idempotencyKey, result);
    return result;
  }

  public async retrieveRefund(refundId: string): Promise<RefundResult> {
    const found = [...this.idempotentRefunds.values(), ...this.externalRefunds].find(
      (entry) => entry.refundId === refundId,
    );
    if (!found) throw new Error("Unknown fake Refund");
    return found;
  }

  // --- P6: provider-originated reversals (disputes, refunds made outside Bookly) ------------

  private externalRefunds: RefundResult[] = [];
  private disputes = new Map<string, DisputeSnapshot>();
  private nextDisputeRetrieveError: Error | undefined;
  public disputeRetrieveCalls = 0;
  public refundListCalls = 0;

  /** Test control: a refund created OUTSIDE Bookly (Stripe Dashboard / direct API) — no
   * idempotency key, no Bookly metadata unless given. */
  public createExternalRefund(
    paymentIntentId: string,
    amountCents: number,
    options: {
      status?: RefundResult["status"];
      currency?: string;
      metadata?: Record<string, string>;
      createdAt?: Date;
    } = {},
  ): RefundResult {
    const refund: RefundResult = {
      refundId: `re_ext_${randomUUID()}`,
      status: options.status ?? "succeeded",
      paymentIntentId,
      amountCents,
      currency: options.currency ?? "EUR",
      metadata: options.metadata ?? {},
      createdAt: options.createdAt ?? new Date(),
    };
    this.externalRefunds.push(refund);
    return refund;
  }

  /** Test control: moves any fake refund (Bookly or external) to another provider status. */
  public setRefundStatus(refundId: string, status: RefundResult["status"]): void {
    for (const [key, value] of this.idempotentRefunds) {
      if (value.refundId === refundId) {
        this.idempotentRefunds.set(key, { ...value, status });
        return;
      }
    }
    const index = this.externalRefunds.findIndex((entry) => entry.refundId === refundId);
    if (index < 0) throw new Error("Unknown fake Refund");
    this.externalRefunds[index] = { ...(this.externalRefunds[index] as RefundResult), status };
  }

  private allRefunds(): RefundResult[] {
    return [...this.idempotentRefunds.values(), ...this.externalRefunds];
  }

  public async listRefundsForPaymentIntent(paymentIntentId: string): Promise<RefundResult[]> {
    this.refundListCalls += 1;
    return this.allRefunds().filter((entry) => entry.paymentIntentId === paymentIntentId);
  }

  public async listRefundsCreatedSince(
    createdSince: Date,
    maxItems: number,
  ): Promise<RefundResult[]> {
    return this.allRefunds()
      .filter((entry) => (entry.createdAt?.getTime() ?? 0) >= createdSince.getTime())
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
      .slice(0, maxItems);
  }

  /** Test control: opens a dispute on a PaymentIntent. `withdraw` adds the usual immediate
   * withdrawal balance transaction (principal + dispute fee). */
  public openDispute(
    paymentIntentId: string,
    amountCents: number,
    options: {
      status?: string;
      reason?: string;
      currency?: string;
      withdraw?: boolean;
      feeCents?: number;
      createdAt?: Date;
    } = {},
  ): string {
    const disputeId = `dp_fake_${randomUUID().replaceAll("-", "")}`;
    const createdAt = options.createdAt ?? new Date();
    this.disputes.set(disputeId, {
      disputeId,
      chargeId: `ch_fake_${paymentIntentId}`,
      paymentIntentId,
      amountCents,
      currency: options.currency ?? "EUR",
      status: options.status ?? "needs_response",
      reason: options.reason ?? "fraudulent",
      evidenceDueAt: new Date(createdAt.getTime() + 7 * 24 * 60 * 60_000),
      isChargeRefundable: false,
      createdAt,
      balanceTransactions: [],
    });
    if (options.withdraw) {
      this.withdrawDisputeFunds(disputeId, {
        ...(options.feeCents !== undefined ? { feeCents: options.feeCents } : {}),
      });
    }
    return disputeId;
  }

  /** Test control: a provider balance transaction withdrawing the disputed funds (+ fee). */
  public withdrawDisputeFunds(
    disputeId: string,
    options: { amountCents?: number; feeCents?: number; currency?: string; at?: Date } = {},
  ): string {
    const dispute = this.requireDispute(disputeId);
    return this.addDisputeMovement(dispute, {
      amountCents: -(options.amountCents ?? dispute.amountCents),
      feeCents: options.feeCents ?? 1_500,
      currency: options.currency ?? dispute.currency,
      at: options.at,
      reportingCategory: "dispute",
    });
  }

  /** Test control: a provider balance transaction reinstating funds (dispute won). */
  public reinstateDisputeFunds(
    disputeId: string,
    options: { amountCents?: number; feeCents?: number; currency?: string; at?: Date } = {},
  ): string {
    const dispute = this.requireDispute(disputeId);
    return this.addDisputeMovement(dispute, {
      amountCents: options.amountCents ?? dispute.amountCents,
      feeCents: options.feeCents ?? -1_500,
      currency: options.currency ?? dispute.currency,
      at: options.at,
      reportingCategory: "dispute_reversal",
    });
  }

  public setDisputeStatus(disputeId: string, status: string): void {
    const dispute = this.requireDispute(disputeId);
    this.disputes.set(disputeId, { ...dispute, status });
  }

  /** Test control: the next `retrieveDispute` call throws (a transient provider error). */
  public failNextDisputeRetrieve(error = new Error("Stripe unavailable (test)")): void {
    this.nextDisputeRetrieveError = error;
  }

  public async retrieveDispute(disputeId: string): Promise<DisputeSnapshot> {
    this.disputeRetrieveCalls += 1;
    if (this.nextDisputeRetrieveError) {
      const error = this.nextDisputeRetrieveError;
      this.nextDisputeRetrieveError = undefined;
      throw error;
    }
    return this.copyDispute(this.requireDispute(disputeId));
  }

  public async listDisputesCreatedSince(
    createdSince: Date,
    maxItems: number,
  ): Promise<DisputeSnapshot[]> {
    return [...this.disputes.values()]
      .filter((entry) => entry.createdAt.getTime() >= createdSince.getTime())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, maxItems)
      .map((entry) => this.copyDispute(entry));
  }

  private requireDispute(disputeId: string): DisputeSnapshot {
    const dispute = this.disputes.get(disputeId);
    if (!dispute) throw new Error("Unknown fake Dispute");
    return dispute;
  }

  private copyDispute(dispute: DisputeSnapshot): DisputeSnapshot {
    return {
      ...dispute,
      balanceTransactions: dispute.balanceTransactions.map((bt) => ({ ...bt })),
    };
  }

  private addDisputeMovement(
    dispute: DisputeSnapshot,
    movement: {
      amountCents: number;
      feeCents: number;
      currency: string;
      at?: Date | undefined;
      reportingCategory: string;
    },
  ): string {
    const balanceTransactionId = `txn_dp_${randomUUID()}`;
    const last = dispute.balanceTransactions.at(-1)?.createdAt.getTime() ?? 0;
    this.disputes.set(dispute.disputeId, {
      ...dispute,
      balanceTransactions: [
        ...dispute.balanceTransactions,
        {
          balanceTransactionId,
          amountCents: movement.amountCents,
          feeCents: movement.feeCents,
          currency: movement.currency,
          // Strictly increasing so provider ordering is deterministic in tests.
          createdAt: movement.at ?? new Date(Math.max(Date.now(), last + 1_000)),
          reportingCategory: movement.reportingCategory,
        },
      ],
    });
    return balanceTransactionId;
  }

  public async findRefundByMetadata(input: {
    refundOperationId: string;
    paymentIntentId: string;
  }): Promise<ProviderLookupResult<RefundResult>> {
    const matches = [...this.idempotentRefunds.values()].filter(
      (entry) =>
        entry.paymentIntentId === input.paymentIntentId &&
        entry.metadata?.["booklyRefundOperationId"] === input.refundOperationId,
    );
    if (matches.length === 0) return { outcome: "NOT_FOUND" };
    if (matches.length > 1) return { outcome: "AMBIGUOUS" };
    return { outcome: "FOUND_ONE", value: matches[0] as RefundResult };
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

  public async findTaxAssociation(_paymentIntentId: string): Promise<TaxAssociationResult | null> {
    return null;
  }

  public constructWebhookEvent(_rawBody: Buffer, _signature: string): Stripe.Event {
    throw new Error("FakePaymentGateway does not support real webhook verification");
  }
}
