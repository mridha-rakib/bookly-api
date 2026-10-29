import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import express from "express";
import mongoose, { type ClientSession, Types } from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/common/errors/app-error.js";
import { asyncHandler } from "../../../src/common/middleware/async-handler.js";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { AddonModel } from "../../../src/modules/addons/addon.model.js";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AppointmentReminderModel } from "../../../src/modules/appointment-reminder/appointment-reminder.model.js";
import { AppointmentReminderRepository } from "../../../src/modules/appointment-reminder/appointment-reminder.repository.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
} from "../../../src/modules/auth/auth.middleware.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import * as claims from "../../../src/modules/booking/booking-creation-claim.model.js";
import { BookingCreationClaimModel } from "../../../src/modules/booking/booking-creation-claim.model.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import * as completionReads from "../../../src/modules/booking/package-batch-completion.js";
import { readOwnedPackageBatchCompletion } from "../../../src/modules/booking/package-batch-completion.js";
import { PackageBatchDeliveryRecovery } from "../../../src/modules/booking/package-batch-delivery-recovery.js";
import { PackageBatchFinancialPersistence } from "../../../src/modules/booking/package-batch-financial-persistence.js";
import { inspectBatchPaymentAuthority } from "../../../src/modules/booking/package-batch-payment-recovery.js";
import { PackageCheckoutConflictError } from "../../../src/modules/booking/package-checkout.errors.js";
import { hashCanonicalPackageCheckoutContent as digest } from "../../../src/modules/booking/package-checkout-binding.js";
import { PackagePurchaseService } from "../../../src/modules/booking/package-purchase.service.js";
import { verifyPackagePurchaseConsentCertification } from "../../../src/modules/booking/package-purchase-authority.js";
import { PackagePurchaseHttpController } from "../../../src/modules/booking/package-purchase-http.js";
import { BookingFinancialTransactionModel } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
import { BookingFinancialTransactionRepository } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { BookingSlotReservationModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.model.js";
import { BookingSlotReservationClaimModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation-claim.model.js";
import { BusinessModel } from "../../../src/modules/business/business.model.js";
import { cancellationTiers } from "../../../src/modules/business-cancellation-policy/business-cancellation-policy.model.js";
import { BusinessCancellationPolicyRepository } from "../../../src/modules/business-cancellation-policy/business-cancellation-policy.repository.js";
import { BusinessTravelSettingsRepository } from "../../../src/modules/business-travel-settings/business-travel-settings.repository.js";
import { BusinessClientModel } from "../../../src/modules/client/client.model.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { FinancialRelationshipRepository } from "../../../src/modules/client/financial-relationship.repository.js";
import { FinancialRelationshipService } from "../../../src/modules/client/financial-relationship.service.js";
import { EmailOutboxModel } from "../../../src/modules/email-outbox/email-outbox.model.js";
import { EmailOutboxRepository } from "../../../src/modules/email-outbox/email-outbox.repository.js";
import * as eligibility from "../../../src/modules/package-progress/package-eligibility.js";
import { PackageProgressV2Model } from "../../../src/modules/package-progress/package-progress-v2.model.js";
import { PackageProgressV2Repository } from "../../../src/modules/package-progress/package-progress-v2.repository.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { MoneyRecoveryService } from "../../../src/modules/payment/money-recovery.service.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { PaymentAttemptModel } from "../../../src/modules/payment/payment-attempt.model.js";
import { PaymentAttemptRepository } from "../../../src/modules/payment/payment-attempt.repository.js";
import { RefundOperationModel } from "../../../src/modules/payment/refund-operation.model.js";
import { RefundOperationRepository } from "../../../src/modules/payment/refund-operation.repository.js";
import { PlatformSettingsRepository } from "../../../src/modules/platform-settings/platform-settings.repository.js";
import { StripeWebhookService } from "../../../src/modules/stripe-webhook/stripe-webhook.service.js";
import { StripeWebhookEventRepository } from "../../../src/modules/stripe-webhook/stripe-webhook-event.repository.js";
import { UserModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import { FakePaymentGateway } from "../../helpers/fake-payment-gateway.js";
import { INTERNAL_TIME, packageBatchFixture } from "../../helpers/package-batch-fixture.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

vi.mock("../../../src/modules/booking/package-batch-authority.js", () => ({
  verifyPackageBatchActivation: vi.fn(async () => undefined),
}));
// New HTTP tests compose synthetic authority around the existing real F2 test domain.
// This does not qualify original consent, change the production registry or promote evidence.
vi.mock("../../../src/modules/booking/package-purchase-authority.js", () => ({
  verifyPackagePurchaseConsentCertification: vi.fn(async () => undefined),
  verifyPackagePurchaseProductionCompletion: vi.fn(async () => undefined),
}));

async function fixture(
  first = false,
  group = false,
  options: Parameters<typeof packageBatchFixture>[0] = {},
) {
  const t = await packageBatchFixture({ ...options, first, group });
  if (!first)
    await BusinessClientModel.updateOne(
      { _id: t.scope.businessClientId },
      { $set: { activatedAt: INTERNAL_TIME } },
    );
  const attempts = new PaymentAttemptRepository(),
    refunds = new RefundOperationRepository();
  const relationships = new FinancialRelationshipService(
    new FinancialRelationshipRepository(),
    attempts,
    refunds,
    new BookingRepository(),
    new BookingCreationClaimRepository(),
    new ClientRepository(),
  );
  const gateway = new FakePaymentGateway();
  const profiles = new CustomerPaymentProfileRepository();
  await profiles.createIfMissing(t.f.context.customerUserId, "cus_f2_synthetic");
  await profiles.savePaymentMethod({
    userId: t.f.context.customerUserId,
    defaultPaymentMethodId: "pm_f2_synthetic",
    cardBrand: "visa",
    cardLast4: "4242",
    cardExpMonth: 12,
    cardExpYear: 2030,
  });
  const payments = new PaymentService(gateway, profiles, new UserRepository(), attempts, refunds);
  const writer = new PackageBatchFinancialPersistence(
    t.writer,
    relationships,
    payments,
    () => INTERNAL_TIME,
  );
  const ledger = new BookingFinancialTransactionService(
    new BookingFinancialTransactionRepository(),
  );
  const bookings = new BookingRepository();
  const webhooks = new StripeWebhookService(
    gateway,
    new StripeWebhookEventRepository(),
    ledger,
    undefined,
    attempts,
    refunds,
    undefined,
    bookings,
    relationships,
  );
  const recovery = new MoneyRecoveryService(
    payments,
    attempts,
    refunds,
    bookings,
    ledger,
    webhooks,
    undefined,
    relationships,
  );
  return {
    ...t,
    writer,
    core: t.writer,
    gateway,
    payments,
    attempts,
    relationships,
    recovery,
    webhooks,
  };
}

let actualServerCodes: number[] = [];
describe("F2 preparation-only same-parent financial/delivery integration", () => {
  beforeAll(connectIsolatedDatabase, 120000);
  beforeEach(async () => {
    await clearIsolatedDatabase();
    actualServerCodes = [];
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    const evidence = process.env["BOOKLY_F2_EVIDENCE_PATH"];
    if (!evidence) return;
    appendFileSync(
      evidence,
      `${JSON.stringify({
        test: expect.getState().currentTestName,
        authority: "VITEST_MODULE_MOCK_ONLY",
        serverCodes: actualServerCodes,
        claims: await BookingCreationClaimModel.find()
          .select(
            "_id businessId actorUserId bookingId packageBatchControl.phase packageBatchPreparation.batchId packageBatchCompletion.state",
          )
          .lean(),
        bookings: await BookingModel.find()
          .select(
            "_id businessId customer.customerUserId customer.businessClientId schedule financials.totalCents financials.depositCents",
          )
          .lean(),
        progress: await PackageProgressV2Model.find()
          .select(
            "_id originBookingId items.totalSessions items.remainingSessions items.completedSessions items.expiredSessions sessions.status",
          )
          .lean(),
        effects: await BookingSlotReservationClaimModel.find()
          .select("idempotencyKey reservationId partySize effect")
          .lean(),
        days: await BookingSlotReservationModel.find()
          .select(
            "businessId staffMembershipId occupancyDate intervals.capacityUsed intervals.capacityMax intervals.reservationId",
          )
          .lean(),
        attempts: await PaymentAttemptModel.find()
          .select(
            "_id logicalIdempotencyKey packageBatchBinding providerStatus persistenceStatus compensationStatus expectedAmountCents bookingId packageProgressId",
          )
          .lean(),
        ledger: await BookingFinancialTransactionModel.find()
          .select("_id bookingId type direction amountCents currency status idempotencyKey")
          .lean(),
        emails: await EmailOutboxModel.find()
          .select("_id eventKey templateKey status dedupeKey")
          .lean(),
        reminders: await AppointmentReminderModel.find()
          .select("_id kind bookingId status dedupeKey")
          .lean(),
      })}\n`,
    );
  });
  afterAll(stopIsolatedReplicaSet);

  it("F2-01/03/13/37/39/41/51 RETURNING commits exact siblings, one Progress and every delivery intent without a fake payment", async () => {
    const t = await fixture();
    const result = await t.writer.complete(t.scope);
    expect(result.bookings).toHaveLength(2);
    expect(result.finance.contract.classification).toBe("RETURNING");
    expect(await PaymentAttemptModel.countDocuments()).toBe(0);
    expect(await BookingFinancialTransactionModel.countDocuments()).toBe(0);
    expect(await EmailOutboxModel.countDocuments()).toBe(2);
    expect(await AppointmentReminderModel.countDocuments()).toBe(2);
    expect(result.completion.tasks.filter((t) => t.port === "CALENDAR")).toHaveLength(2);
  });

  it("F2-02/05/06/07/14 FIRST consumes once, completes one bound attempt and one origin ledger with shared Group capacity", async () => {
    const t = await fixture(true, true);
    const result = await t.writer.complete(t.scope);
    expect(result.finance.contract.classification).toBe("FIRST");
    expect(await PaymentAttemptModel.countDocuments({ persistenceStatus: "COMPLETED" })).toBe(1);
    expect(await BookingFinancialTransactionModel.countDocuments()).toBe(1);
    const attempt = await PaymentAttemptModel.findOne().orFail();
    expect(attempt.packageBatchBinding?.originBookingId).toBe(
      String(result.preparation.originBookingId),
    );
    expect(
      (await BusinessClientModel.findById(t.scope.businessClientId))?.financialRelationship?.state,
    ).toBe("CONSUMED");
    expect(result.bookings.filter((b) => b.financialContract)).toHaveLength(1);
    const replay = await t.writer.complete(t.scope);
    expect(replay.preparation.originBookingId).toEqual(result.preparation.originBookingId);
    expect(await PaymentAttemptModel.countDocuments()).toBe(1);
  });

  for (const stage of ["ledger", "attempt", "email", "reminder"] as const) {
    it(`F2-25/52/53/54 definite charged abort after ${stage} restores the entire parent and authorizes one refund`, async () => {
      const t = await fixture(true);
      if (stage === "ledger") {
        const original = BookingFinancialTransactionService.prototype.record;
        vi.spyOn(BookingFinancialTransactionService.prototype, "record").mockImplementationOnce(
          async function (this: BookingFinancialTransactionService, ...args) {
            await original.apply(this, args);
            throw new Error("injected after ledger");
          },
        );
      } else if (stage === "attempt") {
        const original = PaymentAttemptRepository.prototype.markCompleted;
        vi.spyOn(PaymentAttemptRepository.prototype, "markCompleted").mockImplementationOnce(
          async function (this: PaymentAttemptRepository, ...args) {
            await original.apply(this, args);
            throw new Error("injected after attempt");
          },
        );
      } else if (stage === "email") {
        const original = EmailOutboxRepository.prototype.enqueue;
        vi.spyOn(EmailOutboxRepository.prototype, "enqueue").mockImplementationOnce(async function (
          this: EmailOutboxRepository,
          ...args
        ) {
          await original.apply(this, args);
          throw new Error("injected after email");
        });
      } else {
        const original = AppointmentReminderRepository.prototype.schedule;
        vi.spyOn(AppointmentReminderRepository.prototype, "schedule").mockImplementationOnce(
          async function (this: AppointmentReminderRepository, ...args) {
            await original.apply(this, args);
            throw new Error("injected after reminder");
          },
        );
      }
      await expect(t.writer.complete(t.scope)).rejects.toThrow("injected");
      expect(await BookingModel.countDocuments()).toBe(0);
      expect(await PackageProgressV2Model.countDocuments()).toBe(0);
      expect(await BookingFinancialTransactionModel.countDocuments()).toBe(0);
      expect(await EmailOutboxModel.countDocuments()).toBe(0);
      expect(await AppointmentReminderModel.countDocuments()).toBe(0);
      expect(await PaymentAttemptModel.countDocuments({ persistenceStatus: "COMPLETED" })).toBe(0);
      expect(await RefundOperationModel.countDocuments()).toBe(1);
      expect(
        (await BusinessClientModel.findById(t.scope.businessClientId))?.financialRelationship
          ?.state,
      ).toBe("ELIGIBLE");
      await expect(t.writer.complete(t.scope)).rejects.toThrow(PackageCheckoutConflictError);
      expect(await RefundOperationModel.countDocuments()).toBe(1);
      expect((await BookingCreationClaimModel.findOne())?.packageBatchControl?.phase).toBe(
        "FAILED_FINAL",
      );
    });
  }

  it("F2-21/42 cannot declare origin-only or missing email proof complete", async () => {
    const t = await fixture(true);
    const result = await t.writer.complete(t.scope);
    const one = result.completion.emails[0];
    if (!one) throw new Error("missing email fixture");
    await EmailOutboxModel.collection.deleteOne({ _id: one.id });
    await expect(readOwnedPackageBatchCompletion(t.scope)).rejects.toThrow();
    await expect(t.writer.complete(t.scope)).rejects.toThrow();
    expect(await PaymentAttemptModel.countDocuments()).toBe(1);
  });

  it("F2-20/24 batch persistence lease cannot be reclaimed by age or orphan-compensated", async () => {
    const t = await fixture(true);
    const original = t.core.materializeInSession.bind(t.core);
    vi.spyOn(t.core, "materializeInSession").mockImplementationOnce(async (...args) => {
      await original(...args);
      const error = new Error("unknown classification");
      Object.assign(error, { errorLabels: ["UnknownTransactionCommitResult"] });
      throw error;
    });
    await expect(t.writer.complete(t.scope)).rejects.toMatchObject({ statusCode: 503 });
    const attempt = await PaymentAttemptModel.findOne().orFail();
    await PaymentAttemptModel.updateOne(
      { _id: attempt._id },
      { $set: { persistenceLeaseExpiresAt: new Date(0) } },
    );
    expect(await t.attempts.claimPersistence(attempt._id)).toBeNull();
    expect(await t.attempts.claimCompensation(attempt._id)).toBeNull();
    expect(await RefundOperationModel.countDocuments()).toBe(0);
  });

  it("F2-08/09/10/18/62 accepted travel rights, sibling extras, policies and both reminder kinds compose atomically", async () => {
    const t = await fixture(true, true, {
      travel: true,
      addon: true,
      policy: true,
      categoryWindow: true,
      endReminder: true,
    });
    const result = await t.writer.complete(t.scope);
    expect(result.bookings).toHaveLength(2);
    expect(result.progress.items.every((i) => i.travelCities?.length === 1)).toBe(true);
    for (const b of result.bookings) {
      expect(b.serviceLines[0]?.addons).toHaveLength(1);
      expect(b.financials.addonsSubtotalCents).toBe(500);
      expect(b.financials.travelFeeCents).toBe(300);
      expect(b.cancellationPolicySnapshot?.noShowPercentage).toBe(20);
      expect(b.noShowEligibilitySnapshot?.categoryKey).toBe("BEAUTY_WELLNESS");
    }
    expect(result.completion.reminders).toHaveLength(4);
  });

  it("F2-15 immutable batch binding cannot be repointed by save/query/pipeline/bulk", async () => {
    const t = await fixture(true);
    await t.writer.complete(t.scope);
    const attempt = await PaymentAttemptModel.findOne().orFail();
    await expect(
      PaymentAttemptModel.updateOne({ _id: attempt._id }, { $unset: { packageBatchBinding: 1 } }),
    ).rejects.toThrow("immutable");
    await expect(
      PaymentAttemptModel.updateOne(
        { _id: attempt._id },
        [{ $set: { packageBatchBinding: null } }],
        { updatePipeline: true },
      ),
    ).rejects.toThrow("immutable");
    attempt.set("packageBatchBinding.termsHash", "0".repeat(64));
    await expect(attempt.save({ validateBeforeSave: false })).rejects.toThrow("immutable");
  });
  for (const [base, upfront] of [
    [0, 0],
    [100, 100],
    [1000, 500],
    [15000, 3000],
    [50000, 3500],
  ] as const) {
    it(`F2-04 FIRST bundle ${base} uses source formula ${upfront} with no sibling allocation`, async () => {
      const t = await fixture(true, false, { bundlePriceCents: base });
      const r = await t.writer.complete(t.scope);
      expect(r.finance.contract.onlineChargeCents).toBe(upfront);
      expect(await PaymentAttemptModel.countDocuments()).toBe(upfront ? 1 : 0);
      expect(await BookingFinancialTransactionModel.countDocuments()).toBe(upfront ? 1 : 0);
      expect(r.bookings.filter((b) => b.financials.depositCents > 0)).toHaveLength(upfront ? 1 : 0);
    });
  }

  it("F2-19 real commit followed by controlled lost application return resolves full finance and intents", async () => {
    const t = await fixture(true);
    const original = mongoose.mongo.ClientSession.prototype.withTransaction;
    vi.spyOn(mongoose.mongo.ClientSession.prototype, "withTransaction").mockImplementationOnce(
      async function (this: ClientSession, fn, options) {
        await original.call(this, fn, options);
        throw new Error("lost application return");
      },
    );
    const result = await t.writer.complete(t.scope);
    expect(result.completion.paymentAttemptId).toBeDefined();
    expect(await RefundOperationModel.countDocuments()).toBe(0);
    expect(await EmailOutboxModel.countDocuments()).toBe(2);
  });

  it("F2-22/24/29/30 worker and relationship refuse origin-only, missing-binding and aged unknown evidence", async () => {
    const t = await fixture(true);
    const original = t.core.materializeInSession.bind(t.core);
    vi.spyOn(t.core, "materializeInSession").mockImplementationOnce(async (...args) => {
      await original(...args);
      const e = new Error("uncertain");
      Object.assign(e, { errorLabels: ["UnknownTransactionCommitResult"] });
      throw e;
    });
    await expect(t.writer.complete(t.scope)).rejects.toMatchObject({ statusCode: 503 });
    const readProvider = vi.spyOn(t.payments, "reconcilePaymentAttempt");
    await t.recovery.runOnce();
    expect(readProvider).not.toHaveBeenCalled();
    const attempt = await PaymentAttemptModel.findOne().orFail();
    expect((await inspectBatchPaymentAuthority(attempt))?.kind).toBe("BATCH_PAYMENT_UNRESOLVED");
    await t.relationships.reconcile(t.scope.businessClientId);
    expect(
      (await BusinessClientModel.findById(t.scope.businessClientId))?.financialRelationship?.state,
    ).toBe("FIRST_PENDING");
    await PaymentAttemptModel.collection.updateOne(
      { _id: attempt._id },
      { $unset: { packageBatchBinding: 1, nextRecoveryAt: 1 } },
    );
    const outcomes = await t.recovery.runOnce();
    expect(outcomes.errors).toBeGreaterThan(0);
    expect(await RefundOperationModel.countDocuments()).toBe(0);
    expect(await BookingModel.countDocuments()).toBe(0);
  });

  it("F2-31 webhook requires exact canonical complete proof and original immutable metadata", async () => {
    const t = await fixture(true);
    await t.writer.complete(t.scope);
    const attempt = await PaymentAttemptModel.findOne().orFail();
    const source = await t.gateway.retrievePaymentIntent(
      attempt.providerPaymentIntentId ?? "missing",
    );
    const event = (id: string, metadata: Record<string, string>) => ({
      id,
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: source.paymentIntentId,
          amount: source.amountCents,
          currency: "eur",
          customer: source.customerId,
          metadata,
        },
      },
    });
    expect(
      await Reflect.apply(t.webhooks.process, t.webhooks, [
        event("evt_f2_complete", source.metadata),
      ]),
    ).toBe(true);
    await expect(
      Reflect.apply(t.webhooks.process, t.webhooks, [
        event("evt_f2_wrong", { ...source.metadata, booklyBatchTermsHash: "0".repeat(64) }),
      ]),
    ).rejects.toThrow();
    if (!attempt.bookingId) throw new Error("Missing origin fixture");
    const member = await BookingModel.findOne({ _id: { $ne: attempt.bookingId } }).orFail();
    await BookingModel.collection.deleteOne({ _id: member._id });
    await expect(
      Reflect.apply(t.webhooks.process, t.webhooks, [event("evt_f2_partial", source.metadata)]),
    ).rejects.toThrow();
    expect(await RefundOperationModel.countDocuments()).toBe(0);
  });

  it("F2-44/45/46/47/49/50 all sibling recovery tasks survive one port failure; exact tokens prevent stale DONE", async () => {
    const t = await fixture(true);
    const r = await t.writer.complete(t.scope);
    let calls = 0;
    const runner = new PackageBatchDeliveryRecovery(
      {
        reconcileExisting: async (input) => {
          if (++calls === 1) throw new Error("controlled missing provider response");
          return { outcome: "MATCHED", ...input };
        },
      },
      () => INTERNAL_TIME,
    );
    await runner.runOnce(t.scope);
    const row = await BookingCreationClaimModel.findOne().orFail();
    expect(
      row.packageBatchDelivery
        ?.filter((t) => t.port === "CALENDAR")
        .map((t) => t.state)
        .sort(),
    ).toEqual(["DONE", "RETRY"]);
    const key = r.completion.tasks.find((t) => t.port === "CALENDAR")?.key;
    if (!key) throw new Error("no calendar fixture");
    expect(
      await claims.settleBatchDeliveryTask(t.scope, key, "stale-token", "DONE", INTERNAL_TIME),
    ).toBe(false);
    const later = new Date(INTERNAL_TIME.getTime() + 180000);
    await new PackageBatchDeliveryRecovery(
      { reconcileExisting: async (input) => ({ outcome: "MATCHED", ...input }) },
      () => later,
    ).runOnce(t.scope);
    expect(
      (await BookingCreationClaimModel.findOne())?.packageBatchDelivery
        ?.filter((t) => t.port === "CALENDAR")
        .every((t) => t.state === "DONE"),
    ).toBe(true);
    expect(await PaymentAttemptModel.countDocuments({ persistenceStatus: "COMPLETED" })).toBe(1);
    expect(await BookingFinancialTransactionModel.countDocuments()).toBe(1);
    expect(await PackageProgressV2Model.countDocuments()).toBe(1);
  });

  it("F2-34/48 real Group reschedule preserves original full purchase membership and skips stale CREATED tasks", async () => {
    const t = await fixture(false, true);
    const r = await t.writer.complete(t.scope);
    const b = r.bookings[0];
    if (!b) throw new Error("missing member");
    await t.lifecycle.rescheduleByCustomer(
      String(t.f.context.customerUserId),
      String(b._id),
      "2030-08-21T09:00:00Z",
    );
    const read = vi.fn(async () => ({ outcome: "NOT_FOUND" as const }));
    await new PackageBatchDeliveryRecovery(
      { reconcileExisting: read },
      () => INTERNAL_TIME,
    ).runOnce(t.scope);
    expect(read).toHaveBeenCalledTimes(1);
    const after = await readOwnedPackageBatchCompletion(t.scope);
    expect(after?.preparation.originBookingId).toEqual(r.preparation.originBookingId);
    expect(
      (await BookingCreationClaimModel.findOne())?.packageBatchDelivery?.find(
        (t) => t.bookingId.equals(b._id) && t.port === "CALENDAR",
      )?.state,
    ).toBe("SKIPPED");
  });

  it("F2-12/61 changed accepted add-on rejects without repricing and compensates exact known paid abort", async () => {
    const t = await fixture(true, false, { addon: true });
    await AddonModel.updateMany({}, { $set: { priceCents: 999 } });
    await expect(t.writer.complete(t.scope)).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(0);
    expect(await RefundOperationModel.countDocuments()).toBe(1);
  });

  it("F2-61 changed global no-show window rejects the accepted snapshot", async () => {
    const t = await fixture(false, false, { policy: true, categoryWindow: true });
    const repository = new PlatformSettingsRepository();
    const current = await repository.getOrCreate();
    await repository.update({
      noShowCategoryWindows: current.noShowCategoryWindows.map((w) => ({
        categoryKey: w.categoryKey,
        opensAfterMinutes: w.opensAfterMinutes + 1,
        closesAfterMinutes: w.closesAfterMinutes + 1,
      })),
    });
    await expect(t.writer.complete(t.scope)).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(0);
  });

  it("F2-56 full result append failure restores finance, all intents and all siblings", async () => {
    const t = await fixture(true);
    const original = claims.appendBatchCompletion;
    vi.spyOn(claims, "appendBatchCompletion").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("after full result");
    });
    await expect(t.writer.complete(t.scope)).rejects.toThrow("after full result");
    expect(await BookingModel.countDocuments()).toBe(0);
    expect(await EmailOutboxModel.countDocuments()).toBe(0);
    expect(await AppointmentReminderModel.countDocuments()).toBe(0);
    expect(await BookingFinancialTransactionModel.countDocuments()).toBe(0);
    expect((await BookingCreationClaimModel.findOne())?.packageBatchCompletion).toBeUndefined();
  });

  it("F2-35/60 same-key contender is bounded while one canonical paid owner commits", async () => {
    const t = await fixture(true);
    let release = () => {},
      entered = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const reached = new Promise<void>((r) => {
      entered = r;
    });
    const original = t.core.materializeInSession.bind(t.core);
    vi.spyOn(t.core, "materializeInSession").mockImplementationOnce(async (...args) => {
      entered();
      await hold;
      return original(...args);
    });
    const first = t.writer.complete(t.scope);
    await reached;
    try {
      await expect(t.writer.complete(t.scope)).rejects.toMatchObject({ statusCode: 503 });
    } finally {
      release();
    }
    const winner = await first;
    expect((await t.writer.complete(t.scope)).preparation).toEqual(winner.preparation);
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
    expect(await BookingModel.countDocuments()).toBe(2);
  });

  it("F2-57 actual112 retries the entire paid callback with unchanged canonical IDs/binding", async () => {
    const t = await fixture(true);
    let release = () => {},
      entered = () => {},
      tries = 0;
    const hold = new Promise<void>((r) => {
        release = r;
      }),
      reached = new Promise<void>((r) => {
        entered = r;
      });
    const codes: number[] = [];
    const original = eligibility.acquirePackageEligibilityFence;
    vi.spyOn(eligibility, "acquirePackageEligibilityFence").mockImplementation(async (...args) => {
      if (++tries === 1) {
        await BusinessModel.findById(t.scope.businessId).session(args[1]);
        entered();
        await hold;
      }
      try {
        return await original(...args);
      } catch (e) {
        if (e && typeof e === "object" && "code" in e && typeof e.code === "number")
          codes.push(e.code);
        throw e;
      }
    });
    const first = t.writer.complete(t.scope);
    await reached;
    try {
      await t.schedules.replace(t.f.providers[0]?._id ?? new Types.ObjectId(), t.scope.businessId, [
        { dayOfWeek: "TUESDAY", intervals: [{ startTime: "09:00", endTime: "17:00" }] },
      ]);
    } finally {
      release();
    }
    const r = await first;
    expect(codes).toContain(112);
    actualServerCodes.push(...codes);
    expect(r.bookings.map((b) => String(b._id)).sort()).toEqual(
      t.quote.payload.appointments.map((a) => String(a.bookingId)).sort(),
    );
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
    expect(await PaymentAttemptModel.countDocuments({ persistenceStatus: "COMPLETED" })).toBe(1);
  });

  it("F2-58 actual11000 for a retained sibling aborts the later complete batch without origin-only recovery", async () => {
    const t = await fixture();
    const prior = await t.writer.complete(t.scope);
    const next = await t.another(true);
    const sample = prior.bookings[0],
      collision = next.quote.payload.appointments[0];
    if (!sample || !collision) throw new Error("collision fixture missing");
    await new BookingModel({
      ...sample,
      _id: collision.bookingId,
      reference: "BK-F2COLLISION",
    }).save();
    await expect(
      t.writer.complete(next.scope).catch((e: unknown) => {
        if (e && typeof e === "object" && "code" in e && typeof e.code === "number")
          actualServerCodes.push(e.code);
        throw e;
      }),
    ).rejects.toMatchObject({ code: 11000 });
    expect(await PackageProgressV2Model.countDocuments()).toBe(1);
    expect(await BookingModel.countDocuments()).toBe(3);
    expect(await readOwnedPackageBatchCompletion(next.scope)).toBeNull();
  });

  it("F2-59 different keys at a final shared Group seat admit one full batch without oversell", async () => {
    const t = await fixture(false, true);
    const next = await t.another(false, true);
    const a = t.quote.payload.appointments.find((a) => a.group);
    if (!a?.group) throw new Error("group fixture missing");
    await t.reservations.reserveOrJoin({
      businessId: t.scope.businessId,
      serviceId: a.serviceId,
      staffMembershipId: a.staffMembershipId,
      timezone: "UTC",
      startAt: a.startAt,
      endAt: a.endAt,
      partySize: 2,
      capacityMax: a.group.capacityMax,
      idempotencyKey: "f2:old-party",
    });
    const results = await Promise.allSettled([
      t.writer.complete(t.scope),
      t.writer.complete(next.scope),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await BookingModel.countDocuments()).toBe(2);
    expect(await PackageProgressV2Model.countDocuments()).toBe(1);
    const days = await BookingSlotReservationModel.find();
    expect(
      days.flatMap((d) => d.intervals).find((i) => i.serviceId.equals(a.serviceId))?.capacityUsed,
    ).toBe(3);
  });

  it("F2-37 a real owner recipient gets one source-template intent per sibling", async () => {
    const t = await fixture();
    await UserModel.create({
      _id: t.f.business.ownerUserId,
      normalizedEmail: "owner@f2.test",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      passwordHash: "unused",
      security: { passwordUpdatedAt: new Date() },
    });
    const r = await t.writer.complete(t.scope);
    expect(r.completion.emails).toHaveLength(4);
    expect(r.completion.tasks.filter((t) => t.port === "OWNER_EMAIL")).toHaveLength(0);
  });

  for (const mode of ["mutation-first", "admission-first"] as const) {
    it(`F2-61 accepted Add-on write conflict orders ${mode} without silently changing dues`, async () => {
      const t = await fixture(false, false, { addon: true });
      const addon = await AddonModel.findOne().orFail();
      const mutate = () =>
        new AddonRepository().replaceById(t.scope.businessId, addon._id, {
          name: addon.name,
          status: "ACTIVE",
          priceCents: 999,
        });
      if (mode === "mutation-first") {
        await mutate();
        await expect(t.writer.complete(t.scope)).rejects.toThrow();
        expect(await BookingModel.countDocuments()).toBe(0);
        return;
      }
      let entered = () => {},
        release = () => {};
      const hold = new Promise<void>((r) => {
          release = r;
        }),
        reached = new Promise<void>((r) => {
          entered = r;
        });
      const original = t.reservations.reserveOrJoin.bind(t.reservations);
      vi.spyOn(t.reservations, "reserveOrJoin").mockImplementationOnce(async (...args) => {
        entered();
        await hold;
        return original(...args);
      });
      const pending = t.writer.complete(t.scope);
      await reached;
      const change = mutate();
      release();
      const r = await pending;
      await change;
      expect(r.bookings.every((b) => b.financials.addonsSubtotalCents === 500)).toBe(true);
      expect((await AddonModel.findById(addon._id))?.priceCents).toBe(999);
    });
  }

  it("F2-18/61 changed future travel fees deny the original accepted rights and preserve the quote", async () => {
    const t = await fixture(false, true, { travel: true });
    await new BusinessTravelSettingsRepository().upsertByBusinessId(t.scope.businessId, [
      { city: "Larnaca", active: true, feeCents: 999 },
    ]);
    await expect(t.writer.complete(t.scope)).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(0);
    expect(
      t.quote.payload.items.every((i) => i.travelEntitlement?.cities[0]?.feeCents === 300),
    ).toBe(true);
  });

  it("F2-26/27 a pending synthetic refund retains FIRST until exact provider-confirmed completion, then restores once", async () => {
    const t = await fixture(true);
    t.gateway.queueNextRefundOutcome("pending");
    vi.spyOn(t.core, "materializeInSession").mockRejectedValueOnce(new Error("known abort"));
    await expect(t.writer.complete(t.scope)).rejects.toThrow("known abort");
    const refund = await RefundOperationModel.findOne().orFail();
    expect(refund.providerStatus).toBe("PROVIDER_PENDING");
    expect(
      (await BusinessClientModel.findById(t.scope.businessClientId))?.financialRelationship?.state,
    ).toBe("FIRST_PENDING");
    if (!refund.providerRefundId) throw new Error("missing fake refund");
    t.gateway.succeedRefund(refund.providerRefundId);
    await t.recovery.runOnce();
    await t.relationships.reconcile(t.scope.businessClientId);
    expect(
      (await BusinessClientModel.findById(t.scope.businessClientId))?.financialRelationship?.state,
    ).toBe("ELIGIBLE");
    expect(await RefundOperationModel.countDocuments()).toBe(1);
    expect(await BookingModel.countDocuments()).toBe(0);
  });

  it("F2-15 mismatched canonical attempt cannot be resumed under the original provider identity", async () => {
    const t = await fixture(true);
    await t.writer.complete(t.scope);
    const a = await PaymentAttemptModel.findOne().orFail();
    const b = a.packageBatchBinding;
    if (!b) throw new Error("binding missing");
    await expect(
      t.attempts.createOrResume({
        logicalIdempotencyKey: a.logicalIdempotencyKey,
        customerUserId: a.customerUserId,
        businessId: a.businessId,
        bookingId: a.bookingId,
        packageProgressId: a.packageProgressId,
        businessClientId: a.businessClientId,
        productKind: a.productKind,
        purpose: a.purpose,
        currency: a.currency,
        expectedAmountCents: a.expectedAmountCents,
        providerCustomerId: a.providerCustomerId,
        financialContractVersion: a.financialContractVersion,
        relationshipClassification: a.relationshipClassification,
        packageBatchBinding: { ...b, batchId: String(new Types.ObjectId()) },
      }),
    ).rejects.toThrow();
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
    expect(await PaymentAttemptModel.countDocuments()).toBe(1);
  });

  it("F2-16 wrong persistence token aborts without stealing another owner's refund authority", async () => {
    const t = await fixture(true);
    const original = PaymentAttemptRepository.prototype.claimPersistence;
    vi.spyOn(PaymentAttemptRepository.prototype, "claimPersistence").mockImplementationOnce(
      async function (this: PaymentAttemptRepository, ...args) {
        await original.apply(this, args);
        return "wrong-owner-token";
      },
    );
    await expect(t.writer.complete(t.scope)).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(0);
    expect(await PackageProgressV2Model.countDocuments()).toBe(0);
    expect(await RefundOperationModel.countDocuments()).toBe(0);
    expect((await PaymentAttemptModel.findOne())?.persistenceStatus).toBe("PERSISTING");
  });

  it("F2-17 two accepted keys cannot both acquire the same FIRST relationship", async () => {
    const t = await fixture(true);
    const next = await t.another(true);
    let release = () => {},
      entered = () => {};
    const hold = new Promise<void>((r) => {
        release = r;
      }),
      reached = new Promise<void>((r) => {
        entered = r;
      });
    const original = t.gateway.createAndConfirmPaymentIntent.bind(t.gateway);
    vi.spyOn(t.gateway, "createAndConfirmPaymentIntent").mockImplementationOnce(async (...args) => {
      entered();
      await hold;
      return original(...args);
    });
    const first = t.writer.complete(t.scope);
    await reached;
    try {
      await expect(t.writer.complete(next.scope)).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      release();
    }
    await first;
    expect(await PaymentAttemptModel.countDocuments()).toBe(1);
    expect(await BookingModel.countDocuments()).toBe(2);
    expect(
      (await BusinessClientModel.findById(t.scope.businessClientId))?.financialRelationship?.state,
    ).toBe("CONSUMED");
  });

  it("F2-20 unavailable complete proof after actual commit preserves paid winner then recovers read-only", async () => {
    const t = await fixture(true);
    let unavailable = false;
    const read = completionReads.readOwnedPackageBatchCompletion;
    vi.spyOn(completionReads, "readOwnedPackageBatchCompletion").mockImplementation(
      async (...args) => {
        if (unavailable) throw new Error("unavailable primary");
        return read(...args);
      },
    );
    const transaction = mongoose.mongo.ClientSession.prototype.withTransaction;
    vi.spyOn(mongoose.mongo.ClientSession.prototype, "withTransaction").mockImplementationOnce(
      async function (this: ClientSession, fn, options) {
        await transaction.call(this, fn, options);
        unavailable = true;
        throw new Error("lost application return");
      },
    );
    await expect(t.writer.complete(t.scope)).rejects.toMatchObject({ statusCode: 503 });
    expect(await PaymentAttemptModel.countDocuments({ persistenceStatus: "COMPLETED" })).toBe(1);
    expect(await RefundOperationModel.countDocuments()).toBe(0);
    unavailable = false;
    expect((await t.writer.complete(t.scope)).bookings).toHaveLength(2);
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
  });

  for (const missing of ["sibling", "all-bookings", "progress", "calendar-task"] as const) {
    it(`F2-21/22/23/24/42 full proof fails closed with ${missing} missing`, async () => {
      const t = await fixture(true);
      const r = await t.writer.complete(t.scope);
      if (missing === "progress")
        await PackageProgressV2Model.collection.deleteOne({ _id: r.preparation.packageProgressId });
      else if (missing === "calendar-task")
        await BookingCreationClaimModel.collection.updateOne(
          { _id: r.preparation.claimId },
          { $set: { packageBatchDelivery: [] } },
        );
      else
        await BookingModel.collection.deleteMany(
          missing === "sibling" ? { _id: { $ne: r.preparation.originBookingId } } : {},
        );
      const attempt = await PaymentAttemptModel.findOne().orFail();
      await expect(inspectBatchPaymentAuthority(attempt)).rejects.toThrow();
      await expect(t.writer.complete(t.scope)).rejects.toThrow();
      expect(t.gateway.paymentIntentInputs).toHaveLength(1);
      expect(await RefundOperationModel.countDocuments()).toBe(0);
    });
  }

  it("F2-26/27 worker resumes a known abort interrupted before RefundOperation creation", async () => {
    const t = await fixture(true);
    vi.spyOn(t.core, "materializeInSession").mockRejectedValueOnce(
      new Error("known callback abort"),
    );
    vi.spyOn(t.payments, "refund").mockRejectedValueOnce(
      new Error("interrupted before refund preparation"),
    );
    await expect(t.writer.complete(t.scope)).rejects.toThrow("interrupted");
    expect(await RefundOperationModel.countDocuments()).toBe(0);
    expect((await PaymentAttemptModel.findOne())?.compensationStatus).toBe("REQUIRED");
    // The interrupted compensation claimant's lease is expired; REQUIRED, not age, is the
    // durable abort authority. No PERSISTING/NOT_REQUIRED batch is reclaimed this way.
    await PaymentAttemptModel.updateMany({}, { $unset: { persistenceLeaseExpiresAt: 1 } });
    await t.recovery.runOnce();
    expect(await RefundOperationModel.countDocuments({ providerStatus: "SUCCEEDED" })).toBe(1);
    expect(
      (await BusinessClientModel.findById(t.scope.businessClientId))?.financialRelationship?.state,
    ).toBe("ELIGIBLE");
    await t.recovery.runOnce();
    expect(await RefundOperationModel.countDocuments()).toBe(1);
  });

  it("F2-28 stale compensation owner cannot reverse a completed paid batch", async () => {
    const t = await fixture(true);
    await t.writer.complete(t.scope);
    const a = await PaymentAttemptModel.findOne().orFail();
    expect(await t.attempts.markCompensationRequired(a._id, "stale", "expired-owner-token")).toBe(
      false,
    );
    expect(await t.attempts.claimCompensation(a._id)).toBeNull();
    expect(await RefundOperationModel.countDocuments()).toBe(0);
  });

  it("F2-33/43 replay after expiry performs no new financial, scheduling or delivery write", async () => {
    const t = await fixture(true);
    const r = await t.writer.complete(t.scope);
    const snapshot = async () =>
      digest({
        bookings: await BookingModel.find().sort({ _id: 1 }).lean(),
        progress: await PackageProgressV2Model.find().sort({ _id: 1 }).lean(),
        claims: await BookingCreationClaimModel.find().sort({ _id: 1 }).lean(),
        attempts: await PaymentAttemptModel.find().sort({ _id: 1 }).lean(),
        emails: await EmailOutboxModel.find().sort({ _id: 1 }).lean(),
        reminders: await AppointmentReminderModel.find().sort({ _id: 1 }).lean(),
        clients: await BusinessClientModel.find().sort({ _id: 1 }).lean(),
      });
    const before = await snapshot();
    const clock = vi.fn(() => new Date("2035-01-01"));
    t.advance(new Date("2035-01-01"));
    const later = new PackageBatchFinancialPersistence(t.core, t.relationships, t.payments, clock);
    expect((await later.complete(t.scope)).preparation).toEqual(r.preparation);
    expect(clock).not.toHaveBeenCalled();
    expect(await snapshot()).toBe(before);
  });

  it("F2-36 a real foreign JWT and wrong Business/client cannot adopt monetary or member results", async () => {
    const t = await fixture(true);
    await t.writer.complete(t.scope);
    const userId = new Types.ObjectId();
    await UserModel.create({
      _id: userId,
      normalizedEmail: "foreign@f2.test",
      role: "CUSTOMER",
      status: "ACTIVE",
      passwordHash: "unused",
      security: { passwordUpdatedAt: new Date() },
    });
    const customer = await t.authority.authenticate(
      `Bearer ${await issueTestAccessToken(t.tokens, { userId, role: "CUSTOMER" })}`,
    );
    for (const scope of [
      { ...t.scope, customer },
      { ...t.scope, businessId: new Types.ObjectId() },
      { ...t.scope, businessClientId: new Types.ObjectId() },
    ])
      await expect(t.writer.complete(scope)).rejects.toThrow();
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
    expect(await RefundOperationModel.countDocuments()).toBe(0);
  });

  it("F2-42/55 missing expected deferred task cannot publish a full result", async () => {
    const t = await fixture(true);
    const original = claims.appendBatchCompletion;
    vi.spyOn(claims, "appendBatchCompletion").mockImplementationOnce(
      async (scope, token, proof, tasks, session) => {
        return original(scope, token, proof, tasks.slice(1), session);
      },
    );
    await expect(t.writer.complete(t.scope)).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(0);
    expect(await EmailOutboxModel.countDocuments()).toBe(0);
    expect(await BookingFinancialTransactionModel.countDocuments()).toBe(0);
  });

  for (const stage of [
    "first-reservation",
    "later-reservation",
    "first-booking",
    "last-booking",
    "progress",
    "FIRST-consumption",
  ] as const) {
    it(`F2-51/55 early paid parent abort after ${stage} leaves no sibling or effect`, async () => {
      const t = await fixture(true, true);
      let calls = 0;
      if (stage.includes("reservation")) {
        const original = t.reservations.reserveOrJoin.bind(t.reservations);
        vi.spyOn(t.reservations, "reserveOrJoin").mockImplementation(async (...args) => {
          const r = await original(...args);
          if (++calls === (stage === "first-reservation" ? 1 : 2)) throw new Error(stage);
          return r;
        });
      } else if (stage.includes("booking")) {
        const original = BookingRepository.prototype.create;
        vi.spyOn(BookingRepository.prototype, "create").mockImplementation(async function (
          this: BookingRepository,
          ...args
        ) {
          const r = await original.apply(this, args);
          if (++calls === (stage === "first-booking" ? 1 : 2)) throw new Error(stage);
          return r;
        });
      } else if (stage === "progress") {
        const original = PackageProgressV2Repository.prototype.create;
        vi.spyOn(PackageProgressV2Repository.prototype, "create").mockImplementationOnce(
          async function (this: PackageProgressV2Repository, ...args) {
            await original.apply(this, args);
            throw new Error(stage);
          },
        );
      } else {
        const original = t.relationships.consumeFirst.bind(t.relationships);
        vi.spyOn(t.relationships, "consumeFirst").mockImplementationOnce(async (...args) => {
          await original(...args);
          throw new Error(stage);
        });
      }
      await expect(t.writer.complete(t.scope)).rejects.toThrow(stage);
      expect(await BookingModel.countDocuments()).toBe(0);
      expect(await PackageProgressV2Model.countDocuments()).toBe(0);
      expect(await BookingSlotReservationModel.countDocuments()).toBe(0);
      expect(await EmailOutboxModel.countDocuments()).toBe(0);
      expect(await AppointmentReminderModel.countDocuments()).toBe(0);
      expect(await RefundOperationModel.countDocuments()).toBe(1);
      expect(
        (await BusinessClientModel.findById(t.scope.businessClientId))?.financialRelationship
          ?.state,
      ).toBe("ELIGIBLE");
    });
  }

  for (const months of [6, 12] as const) {
    it(`F2-63 FINITE${months} keeps the canonical calendar contract in a fully composed batch`, async () => {
      const t = await fixture(true, true, { mode: "FINITE", months });
      const r = await t.writer.complete(t.scope);
      const validity = r.progress.purchasedContract?.validity;
      expect(validity?.mode).toBe("FINITE");
      if (validity?.mode !== "FINITE") throw new Error("finite fixture");
      expect(validity.months).toBe(months);
      expect(r.bookings).toHaveLength(2);
    });
  }

  it("F2-51 a committed F1 parent cannot be upgraded in a later transaction on the same session", async () => {
    const t = await fixture(true);
    let captured: Parameters<typeof claims.appendBatchCompletion> | undefined;
    const realAppend = claims.appendBatchCompletion;
    const parent = await mongoose.startSession();
    const realEnd = parent.endSession.bind(parent);
    const end = vi.spyOn(parent, "endSession").mockResolvedValue(undefined);
    vi.spyOn(mongoose, "startSession").mockResolvedValueOnce(parent);
    vi.spyOn(claims, "appendBatchCompletion").mockImplementationOnce(async (...args) => {
      captured = args;
    });
    try {
      await expect(t.writer.complete(t.scope)).rejects.toMatchObject({ statusCode: 503 });
      if (!captured) throw new Error("Missing captured internal fixture");
      const number = parent.serverSession.txnNumber;
      const [scope, token, proof, tasks] = captured;
      await expect(
        parent.withTransaction(() => realAppend(scope, token, proof, tasks, parent)),
      ).rejects.toThrow();
      expect(parent.serverSession.txnNumber).toBeGreaterThan(number);
      expect((await BookingCreationClaimModel.findOne())?.packageBatchCompletion).toBeUndefined();
      expect(await RefundOperationModel.countDocuments()).toBe(0);
    } finally {
      end.mockRestore();
      await realEnd();
    }
  });
  for (const quotedFirst of [false, true]) {
    it(`F2-11 quote estimate ${quotedFirst ? "FIRST" : "RETURNING"} cannot replace final relationship authority`, async () => {
      const t = await fixture(quotedFirst);
      await BusinessClientModel.updateOne(
        { _id: t.scope.businessClientId },
        quotedFirst ? { $set: { activatedAt: INTERNAL_TIME } } : { $unset: { activatedAt: 1 } },
      );
      await expect(t.writer.complete(t.scope)).rejects.toThrow();
      expect(t.gateway.paymentIntentInputs).toHaveLength(0);
      expect(await BookingModel.countDocuments()).toBe(0);
      expect(await PaymentAttemptModel.countDocuments()).toBe(0);
      expect(t.quote.payload.financials.classification).toBe(quotedFirst ? "FIRST" : "RETURNING");
    });
  }

  for (const domain of ["policy", "global-window", "travel"] as const) {
    for (const order of ["mutation-first", "admission-first"] as const) {
      it(`F2-61/62 ${domain} actual writer orders ${order} without rewriting accepted terms`, async () => {
        const travel = domain === "travel";
        const t = await fixture(
          false,
          true,
          travel ? { travel: true } : { policy: true, categoryWindow: true },
        );
        const settings = !travel ? await new PlatformSettingsRepository().getOrCreate() : null;
        const mutate = async () => {
          if (domain === "travel")
            return new BusinessTravelSettingsRepository().upsertByBusinessId(t.scope.businessId, [
              { city: "Larnaca", active: true, feeCents: 999 },
            ]);
          if (domain === "policy")
            return new BusinessCancellationPolicyRepository().replace(
              t.scope.businessId,
              cancellationTiers.map((tier) => ({ tier, mode: "FREE" as const })),
              40,
            );
          if (!settings) throw new Error("missing settings fixture");
          return new PlatformSettingsRepository().update({
            noShowCategoryWindows: settings.noShowCategoryWindows.map((w) => ({
              categoryKey: w.categoryKey,
              opensAfterMinutes: w.opensAfterMinutes + 1,
              closesAfterMinutes: w.closesAfterMinutes + 1,
            })),
          });
        };
        if (order === "mutation-first") {
          await mutate();
          await expect(t.writer.complete(t.scope)).rejects.toThrow();
          expect(await BookingModel.countDocuments()).toBe(0);
          return;
        }
        let release = () => {},
          entered = () => {};
        const hold = new Promise<void>((r) => {
            release = r;
          }),
          reached = new Promise<void>((r) => {
            entered = r;
          });
        const original = t.reservations.reserveOrJoin.bind(t.reservations);
        vi.spyOn(t.reservations, "reserveOrJoin").mockImplementationOnce(async (...args) => {
          entered();
          await hold;
          return original(...args);
        });
        const pending = t.writer.complete(t.scope);
        await reached;
        const edit = mutate();
        release();
        const result = await pending;
        await edit;
        expect(result.bookings).toHaveLength(2);
        expect(await readOwnedPackageBatchCompletion(t.scope)).not.toBeNull();
        if (travel)
          expect(result.progress.items.every((i) => i.travelCities?.[0]?.feeCents === 300)).toBe(
            true,
          );
        else
          expect(
            result.bookings.every((b) => b.cancellationPolicySnapshot?.noShowPercentage === 20),
          ).toBe(true);
      });
    }
  }

  it("F2-18 full accepted future travel rights include unselected cities and enter purchased snapshots", async () => {
    const t = await fixture(true, true, { travel: true, extraTravelCity: true });
    const r = await t.writer.complete(t.scope);
    expect(
      r.progress.items.every((i) =>
        i.travelCities?.some((c) => c.city === "Nicosia" && c.feeCents === 700),
      ),
    ).toBe(true);
    expect(r.bookings.every((b) => b.financials.travelFeeCents === 300)).toBe(true);
    const claim = await BookingCreationClaimModel.findOne().orFail();
    expect(claim.packageCheckoutPresentation?.disclosure.content.renderedTermsSnapshot).toContain(
      "Nicosia",
    );
  });

  it("F2-18/61 changing only an unselected future travel city cannot silently rebind the accepted Package", async () => {
    const t = await fixture(false, true, { travel: true, extraTravelCity: true });
    await new BusinessTravelSettingsRepository().upsertByBusinessId(t.scope.businessId, [
      { city: "Larnaca", active: true, feeCents: 300 },
      { city: "Nicosia", active: true, feeCents: 701 },
    ]);
    await expect(t.writer.complete(t.scope)).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(0);
    expect(
      t.quote.payload.items[0]?.travelEntitlement?.cities.find((c) => c.city === "Nicosia")
        ?.feeCents,
    ).toBe(700);
  });

  it("F2-27 a lost fake refund response is reconciled through the original RefundOperation only", async () => {
    const t = await fixture(true);
    vi.spyOn(t.core, "materializeInSession").mockRejectedValueOnce(
      new Error("known callback abort"),
    );
    const original = t.gateway.createRefund.bind(t.gateway);
    vi.spyOn(t.gateway, "createRefund").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("controlled lost fake refund return");
    });
    await expect(t.writer.complete(t.scope)).rejects.toThrow("controlled lost fake refund return");
    expect(
      await RefundOperationModel.countDocuments({ providerStatus: "RECONCILIATION_REQUIRED" }),
    ).toBe(1);
    await t.recovery.runOnce();
    await t.relationships.reconcile(t.scope.businessClientId);
    expect(await RefundOperationModel.countDocuments({ providerStatus: "SUCCEEDED" })).toBe(1);
    expect(t.gateway.refundInputs).toHaveLength(1);
    expect(await BookingModel.countDocuments()).toBe(0);
    expect(
      (await BusinessClientModel.findById(t.scope.businessClientId))?.financialRelationship?.state,
    ).toBe("ELIGIBLE");
    await expect(t.writer.complete(t.scope)).rejects.toThrow(PackageCheckoutConflictError);
    expect((await BookingCreationClaimModel.findOne())?.packageBatchControl?.phase).toBe(
      "FAILED_FINAL",
    );
  });

  it("F2-55/56 abort of a full accepted-terms batch restores dependency/coordinator writes too", async () => {
    const t = await fixture(true, true, {
      travel: true,
      extraTravelCity: true,
      addon: true,
      policy: true,
      categoryWindow: true,
      endReminder: true,
    });
    const business = await BusinessModel.findById(t.scope.businessId).orFail();
    const addon = await AddonModel.findOne().orFail();
    const client = await BusinessClientModel.findById(t.scope.businessClientId).orFail();
    const original = claims.appendBatchCompletion;
    vi.spyOn(claims, "appendBatchCompletion").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("full accepted terms rollback");
    });
    await expect(t.writer.complete(t.scope)).rejects.toThrow("full accepted terms rollback");
    expect((await BusinessModel.findById(t.scope.businessId))?.packageEligibilityVersion).toBe(
      business.packageEligibilityVersion,
    );
    expect((await AddonModel.findById(addon._id))?.get("__v")).toBe(addon.get("__v"));
    expect((await BusinessClientModel.findById(client._id))?.get("__v")).toBe(client.get("__v"));
    expect(await BookingModel.countDocuments()).toBe(0);
    expect(await PackageProgressV2Model.countDocuments()).toBe(0);
    expect(await BookingSlotReservationModel.countDocuments()).toBe(0);
    expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(0);
    expect(await BookingFinancialTransactionModel.countDocuments()).toBe(0);
    expect(await EmailOutboxModel.countDocuments()).toBe(0);
    expect(await AppointmentReminderModel.countDocuments()).toBe(0);
    expect((await BookingCreationClaimModel.findOne())?.packageBatchCompletion).toBeUndefined();
    expect((await BookingCreationClaimModel.findOne())?.packageBatchDelivery).toBeUndefined();
  });
  it("F2 provider-resume action-required payment resumes the same provider intent before persistence", async () => {
    const t = await fixture(true);
    t.gateway.queueNextChargeOutcome("requires_action");
    await expect(t.writer.complete(t.scope)).rejects.toThrow();
    const attempt = await PaymentAttemptModel.findOne().orFail();
    expect(attempt.providerPaymentIntentId).toBeTruthy();
    expect((await BookingCreationClaimModel.findOne())?.packageBatchControl?.phase).toBe(
      "PREPARED",
    );
    expect(await BookingModel.countDocuments()).toBe(0);
    if (!attempt.providerPaymentIntentId) throw new Error("Missing synthetic provider intent");
    t.gateway.succeedPaymentIntent(attempt.providerPaymentIntentId);
    await t.writer.complete(t.scope);
    expect(await PaymentAttemptModel.countDocuments()).toBe(1);
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
    expect(await BookingFinancialTransactionModel.countDocuments()).toBe(1);
    expect(await readOwnedPackageBatchCompletion(t.scope)).toBeTruthy();
  });

  it("F2 provider-resume ambiguous provider creation resumes by the original durable attempt without a second charge", async () => {
    const t = await fixture(true);
    t.gateway.queueNextChargeLostResponse();
    await expect(t.writer.complete(t.scope)).rejects.toThrow();
    expect((await BookingCreationClaimModel.findOne())?.packageBatchControl?.phase).toBe(
      "PREPARED",
    );
    await t.writer.complete(t.scope);
    expect(await PaymentAttemptModel.countDocuments()).toBe(1);
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
    expect(await readOwnedPackageBatchCompletion(t.scope)).toBeTruthy();
  });
});

describe("P3A purchase HTTP over the existing F2 parent (synthetic authorities only)", () => {
  beforeAll(connectIsolatedDatabase, 120000);
  beforeEach(clearIsolatedDatabase);
  afterEach(() => vi.restoreAllMocks());
  afterAll(stopIsolatedReplicaSet);
  async function surface(first = false) {
    const operationId = randomUUID(),
      t = await fixture(first, false, { operationId });
    const app = express();
    app.use(express.json());
    app.use(
      createAuthenticateAccessTokenMiddleware(t.tokens, new UserRepository()),
      requireActiveUser(),
    );
    const service = new PackagePurchaseService(t.authority, t.writer);
    app.post("/actions/:action", asyncHandler(new PackagePurchaseHttpController(service).execute));
    app.use(createErrorHandler({ isProduction: true }));
    const post = (
      action = "purchase",
      body: object = { businessId: String(t.scope.businessId), operationId },
      authorization = t.authorization,
    ) => request(app).post(`/actions/${action}`).set("Authorization", authorization).send(body);
    return { ...t, operationId, post };
  }
  it.each([false, true])(
    "paid=%s real parent completes and replays one Progress with exact intents",
    async (first) => {
      const t = await surface(first);
      const a = await t.post().expect(200),
        b = await t.post().expect(200);
      expect(a.body.data.purchaseCompletion).toBe("VERIFIED");
      expect(b.body.data.packageProgressId).toBe(a.body.data.packageProgressId);
      expect(await PackageProgressV2Model.countDocuments()).toBe(1);
      expect(await BookingModel.countDocuments()).toBe(2);
      expect(await PaymentAttemptModel.countDocuments()).toBe(first ? 1 : 0);
      expect(await BookingFinancialTransactionModel.countDocuments()).toBe(first ? 1 : 0);
      expect(await EmailOutboxModel.countDocuments()).toBeGreaterThan(0);
      const claim = await BookingCreationClaimModel.findOne().orFail();
      expect(claim.packageBatchCompletion?.activation).toBe(
        "SYNTHETIC_AUTHORITY_NOT_PRODUCTION_CONSENT",
      );
    },
  );
  it("3DS status/reload exposes only the exact Customer's original attempt; no credits before persistence", async () => {
    const t = await surface(true);
    t.gateway.queueNextChargeOutcome("requires_action");
    const a = await t.post().expect(202);
    expect(a.body.data).toMatchObject({
      state: "PAYMENT_PENDING",
      providerStatus: "REQUIRES_ACTION",
    });
    expect(a.body.data.clientSecret).toBeTruthy();
    expect(await PackageProgressV2Model.countDocuments()).toBe(0);
    const reread = await t.post("purchase-status").expect(202);
    expect(reread.body.data.quoteId).toBe(a.body.data.quoteId);
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
    const attempt = await PaymentAttemptModel.findOne().orFail();
    if (!attempt.providerPaymentIntentId) throw Error("Expected exact fake PI");
    t.gateway.succeedPaymentIntent(attempt.providerPaymentIntentId);
    await t.post().expect(200);
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
  });
  it("lost provider response remains unconfirmed and recovers the same logical payment", async () => {
    const t = await surface(true);
    t.gateway.queueNextChargeLostResponse();
    const initial = await t.post();
    expect(initial.status).not.toBe(200);
    const status = await t.post("purchase-status").expect(202);
    expect(status.body.data.state).not.toBe("COMPLETE");
    expect(await PackageProgressV2Model.countDocuments()).toBe(0);
    await t.post().expect(200);
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
  });
  it("a failed payment never grants a purchased package", async () => {
    const t = await surface(true);
    t.gateway.queueNextChargeOutcome("failed");
    const initial = await t.post();
    expect(initial.status).not.toBe(200);
    const status = await t.post("purchase-status").expect(202);
    expect(status.body.data.providerStatus).toBe("FAILED");
    expect(await PackageProgressV2Model.countDocuments()).toBe(0);
  });
  it("actual parent rollback and pending compensation do not report reimbursement complete", async () => {
    const t = await surface(true);
    t.gateway.queueNextRefundOutcome("pending");
    vi.spyOn(EmailOutboxRepository.prototype, "enqueue").mockRejectedValueOnce(
      Error("synthetic transactional failure"),
    );
    const initial = await t.post();
    expect(initial.status).not.toBe(200);
    const status = await t.post("purchase-status").expect(202);
    expect(status.body.data.state).toBe("COMPENSATION");
    expect(status.body.data.compensationStatus).not.toBe("REFUNDED");
    expect(await PackageProgressV2Model.countDocuments()).toBe(0);
    expect(await BookingModel.countDocuments()).toBe(0);
  });
  it("foreign Business, posted authority and unknown operation cannot dispatch a charge", async () => {
    const t = await surface(true);
    await t
      .post("purchase", { businessId: String(new Types.ObjectId()), operationId: t.operationId })
      .expect(404);
    await t
      .post("purchase", {
        businessId: String(t.scope.businessId),
        operationId: t.operationId,
        certified: true,
      })
      .expect(400);
    await t
      .post("purchase", { businessId: String(t.scope.businessId), operationId: randomUUID() })
      .expect(404);
    expect(t.gateway.paymentIntentInputs).toHaveLength(0);
  });
  it("acceptance without certification cannot prepare, charge or create entitlement even behind synthetic rollout", async () => {
    const t = await surface(true);
    vi.mocked(verifyPackagePurchaseConsentCertification).mockRejectedValueOnce(
      new AppError("Uncertified", 503),
    );
    await t.post().expect(503);
    expect(t.gateway.paymentIntentInputs).toHaveLength(0);
    expect(await BookingModel.countDocuments()).toBe(0);
    expect(await PackageProgressV2Model.countDocuments()).toBe(0);
    expect((await BookingCreationClaimModel.findOne())?.packageBatchPreparation).toBeUndefined();
  });
  it("competing initial-slot purchases through HTTP cannot materialize two exclusive members", async () => {
    const t = await surface(false),
      otherOperation = randomUUID();
    await t.another(false, false, otherOperation);
    const results = await Promise.all([
      t.post(),
      t.post("purchase", { businessId: String(t.scope.businessId), operationId: otherOperation }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await PackageProgressV2Model.countDocuments()).toBe(1);
    expect(await BookingModel.countDocuments()).toBe(2);
  });
});
