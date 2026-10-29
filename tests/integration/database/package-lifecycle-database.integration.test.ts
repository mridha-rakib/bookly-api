import { appendFileSync } from "node:fs";
import express from "express";
import mongoose, { Types } from "mongoose";
import type Stripe from "stripe";
import httpRequest from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asyncHandler } from "../../../src/common/middleware/async-handler.js";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { validateRequest } from "../../../src/common/middleware/validate-request.js";
import { AddonModel } from "../../../src/modules/addons/addon.model.js";
import { AddonServiceAssignmentModel } from "../../../src/modules/addons/addon-service-assignment.model.js";
import { AppointmentReminderModel } from "../../../src/modules/appointment-reminder/appointment-reminder.model.js";
import { AppointmentReminderRepository } from "../../../src/modules/appointment-reminder/appointment-reminder.repository.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
} from "../../../src/modules/auth/auth.middleware.js";
import { BookingController } from "../../../src/modules/booking/booking.controller.js";
import { toBookingCalendarEntryDto } from "../../../src/modules/booking/booking.dto.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import {
  bookingIdParamsSchema,
  completeBookingBodySchema,
} from "../../../src/modules/booking/booking.schema.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import { BookingLifecycleService } from "../../../src/modules/booking/booking-lifecycle.service.js";
import {
  readOwnedPackageBatchCompletion,
  verifyBatchCompletion,
} from "../../../src/modules/booking/package-batch-completion.js";
import { PackageBatchFinancialPersistence } from "../../../src/modules/booking/package-batch-financial-persistence.js";
import { PackageLifecycleService } from "../../../src/modules/booking/package-lifecycle.service.js";
import { PackageLifecycleDeliveryRecovery } from "../../../src/modules/booking/package-lifecycle-delivery-recovery.js";
import { PackageLifecycleHttpController } from "../../../src/modules/booking/package-lifecycle-http.controller.js";
import type { PackageLifecycleHttpServices } from "../../../src/modules/booking/package-lifecycle-http.factory.js";
import type { LifecycleIntent } from "../../../src/modules/booking/package-lifecycle-operation.js";
import {
  lifecycleOperationId,
  PackageLifecycleOperationModel,
  PackageLifecycleOperations,
} from "../../../src/modules/booking/package-lifecycle-operation.js";
import * as purchaseAuthority from "../../../src/modules/booking/package-purchase-authority.js";
import { BookingFinancialTransactionModel } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
import { BookingFinancialTransactionRepository } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { BookingSlotReservationModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.model.js";
import { BookingSlotReservationClaimModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation-claim.model.js";
import { BusinessModel } from "../../../src/modules/business/business.model.js";
import { BusinessTravelSettingsModel } from "../../../src/modules/business-travel-settings/business-travel-settings.model.js";
import { BusinessClientModel } from "../../../src/modules/client/client.model.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { FinancialRelationshipRepository } from "../../../src/modules/client/financial-relationship.repository.js";
import { FinancialRelationshipService } from "../../../src/modules/client/financial-relationship.service.js";
import { EmailOutboxModel } from "../../../src/modules/email-outbox/email-outbox.model.js";
import { EmailOutboxRepository } from "../../../src/modules/email-outbox/email-outbox.repository.js";
import * as eligibility from "../../../src/modules/package-progress/package-eligibility.js";
import { withPackageEligibility } from "../../../src/modules/package-progress/package-eligibility.js";
import { PackageProgressV2Model } from "../../../src/modules/package-progress/package-progress-v2.model.js";
import { PackageProgressV2Repository } from "../../../src/modules/package-progress/package-progress-v2.repository.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { MoneyRecoveryService } from "../../../src/modules/payment/money-recovery.service.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import * as lifecyclePaymentModel from "../../../src/modules/payment/payment-attempt.model.js";
import {
  completeLifecyclePaymentAttempt,
  PaymentAttemptModel,
} from "../../../src/modules/payment/payment-attempt.model.js";
import { PaymentAttemptRepository } from "../../../src/modules/payment/payment-attempt.repository.js";
import { RefundOperationModel } from "../../../src/modules/payment/refund-operation.model.js";
import { RefundOperationRepository } from "../../../src/modules/payment/refund-operation.repository.js";
import { ServiceModel } from "../../../src/modules/services/service.model.js";
import { StaffMembershipModel } from "../../../src/modules/staff/staff.model.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
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
// Existing S5 fixtures are deliberately synthetic and retain v1 proof. This explicit
// engineering seam does not qualify consent; genuine P3B protocol tests use the real verifier.
vi.mock("../../../src/modules/booking/package-purchase-authority.js", async (original) => ({
  ...(await original<object>()),
  verifyPackagePurchaseConsentCertification: vi.fn(async () => undefined),
}));
async function fixture(options: Parameters<typeof packageBatchFixture>[0] = {}) {
  const t = await packageBatchFixture({ bundlePriceCents: 0, ...options });
  await UserModel.create({
    _id: t.f.business.ownerUserId,
    normalizedEmail: "owner@s5.test",
    role: "BUSINESS_OWNER",
    status: "ACTIVE",
    passwordHash: "unused",
    security: { passwordUpdatedAt: INTERNAL_TIME },
  });
  let now = new Date(INTERNAL_TIME);
  if (!options.first)
    await BusinessClientModel.updateOne(
      { _id: t.scope.businessClientId },
      { $set: { activatedAt: INTERNAL_TIME } },
    );
  const gateway = new FakePaymentGateway(),
    attempts = new PaymentAttemptRepository(),
    refunds = new RefundOperationRepository();
  const relationships = new FinancialRelationshipService(
    new FinancialRelationshipRepository(),
    attempts,
    refunds,
    new BookingRepository(),
    new BookingCreationClaimRepository(),
    new ClientRepository(),
  );
  const profiles = new CustomerPaymentProfileRepository();
  if (options.first) {
    await profiles.createIfMissing(t.f.context.customerUserId, "cus_s5_synthetic");
    await profiles.savePaymentMethod({
      userId: t.f.context.customerUserId,
      defaultPaymentMethodId: "pm_s5_synthetic",
      cardBrand: "visa",
      cardLast4: "4242",
      cardExpMonth: 12,
      cardExpYear: 2030,
    });
  }
  const payments = new PaymentService(gateway, profiles, new UserRepository(), attempts, refunds);
  const full = await new PackageBatchFinancialPersistence(
    t.writer,
    relationships,
    payments,
    () => now,
  ).complete(t.scope);
  const lifecycle = new PackageLifecycleService(
    t.availability,
    t.reservations,
    t.booking,
    () => now,
  );
  const progress = full.progress;
  if (progress.creditAccountingVersion !== 2) throw Error("accounting2 required");
  const first = must(full.bookings[0]);
  const intent = (
    action:
      | "REDEEM"
      | "RESCHEDULE"
      | "CANCEL"
      | "COMPLETE"
      | "MARK_NO_SHOW"
      | "NO_SHOW"
      | "REVERSE_NO_SHOW"
      | "EXPIRE"
      | "VENUE_SETTLEMENT",
    extra: Partial<LifecycleIntent> = {},
  ) => ({
    key: `s5:${new Types.ObjectId()}`,
    action,
    businessId: t.scope.businessId,
    businessClientId: t.scope.businessClientId,
    packageProgressId: progress._id,
    ...extra,
  });
  const redeem = () =>
    intent("REDEEM", {
      packageItemId: must(progress.items[0]).packageItemId,
      staffMembershipId: must(first.serviceLines[0]).responsibleStaffMembershipId,
      startAt: new Date(first.schedule.startAt.getTime() + 86400000),
    });
  const customer = (request: ReturnType<typeof intent>) =>
    lifecycle.customer(t.scope.customer, request);
  return {
    ...t,
    full,
    lifecycle,
    progress,
    first,
    intent,
    redeem,
    customer,
    gateway,
    payments,
    attempts,
    refunds,
    relationships,
    clock: () => now,
    sessionOffer: async (request: ReturnType<typeof intent>) => {
      const fullIntent = {
        ...request,
        version: 1 as const,
        actorUserId: t.f.context.customerUserId,
        customerUserId: t.f.context.customerUserId,
        actorRole: "CUSTOMER" as const,
      };
      const ops = new PackageLifecycleOperations();
      const quote = await ops.presentSession(t.scope.customer, fullIntent, now);
      return {
        quote,
        accept: () =>
          ops.acceptSession(
            t.scope.customer,
            fullIntent,
            {
              quoteId: quote.quoteId,
              termsHash: quote.termsHash,
              disclosureHash: quote.disclosureHash,
              challenge: quote.challenge,
              action: "ACCEPT_SESSION_DUES",
            },
            now,
          ),
        fullIntent,
      };
    },
    moneyLifecycle: new PackageLifecycleService(
      t.availability,
      t.reservations,
      t.booking,
      () => now,
      payments,
    ),
    advance: (at: Date) => {
      now = at;
    },
    business: (request: ReturnType<typeof intent>) =>
      lifecycle.business(
        t.f.business.ownerUserId,
        "BUSINESS_OWNER",
        t.f.context.customerUserId,
        request,
      ),
  };
}
function must<T>(value: T | null | undefined): T {
  if (value == null) throw Error("Required synthetic evidence missing");
  return value;
}
let serverCodes: number[] = [];
describe("S5 internal first-class lifecycle", () => {
  beforeAll(connectIsolatedDatabase, 120000);
  beforeEach(async () => {
    await clearIsolatedDatabase();
    serverCodes = [];
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    const path = process.env["BOOKLY_S5_EVIDENCE_PATH"];
    if (path)
      appendFileSync(
        path,
        `${JSON.stringify({
          test: expect.getState().currentTestName,
          authority: "VITEST_MODULE_MOCK_ONLY",
          serverCodes,
          operations: await PackageLifecycleOperationModel.find()
            .select(
              "_id bookingId phase intent.action intent.businessId intent.customerUserId intent.packageProgressId result.status result.money result.venue result.emails result.reminders result.tasks assessment delivery.index delivery.state delivery.attempts delivery.completionStage delivery.externalDelivery",
            )
            .lean(),
          bookings: await BookingModel.find()
            .select(
              "_id status schedule serviceLines.reservationId serviceLines.reservationOperationKey",
            )
            .lean(),
          progress: await PackageProgressV2Model.find()
            .select("_id originBookingId items sessions")
            .lean(),
          paymentAttempts: await PaymentAttemptModel.find()
            .select(
              "_id logicalIdempotencyKey packageLifecycleBinding packageBatchBinding providerPaymentIntentId expectedAmountCents providerStatus persistenceStatus compensationStatus succeededTransactionId",
            )
            .lean(),
          refunds: await RefundOperationModel.find()
            .select(
              "_id logicalIdempotencyKey sourcePaymentAttemptId sourcePaymentIntentId expectedRefundAmountCents providerStatus providerRefundId",
            )
            .lean(),
          emails: await EmailOutboxModel.countDocuments(),
          reminders: await AppointmentReminderModel.countDocuments(),
        })}\n`,
      );
  });
  afterAll(stopIsolatedReplicaSet);
  it("S5-01/04/05 FIXED remaining credit creates only its retained Booking and one attempt", async () => {
    const t = await fixture();
    const input = t.redeem();
    const result = await t.customer(input);
    expect(result?.booking?.serviceLines[0]?.packageContext?.role).toBe("REDEMPTION");
    expect(result?.booking?.financials.totalCents).toBe(0);
    expect(result?.progress.items[0]?.remainingSessions).toBe(
      must(t.progress.items[0]).remainingSessions - 1,
    );
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length + 1);
  });
  it("S5-02/06/15 Group replay adds one credit/seat only and keeps actual shared target", async () => {
    const t = await fixture({ group: true });
    const req = t.redeem();
    const a = await t.customer(req);
    const before = await BookingSlotReservationModel.find().lean();
    const b = await t.customer(req);
    expect(String(a?.booking?._id)).toBe(String(b?.booking?._id));
    expect(await BookingSlotReservationModel.find().lean()).toEqual(before);
    expect(await PackageLifecycleOperationModel.countDocuments()).toBe(1);
    expect(a?.booking?.serviceLines[0]?.schedulingSnapshot?.group?.partySize).toBe(1);
  });
  it("S5-07 same key with changed Staff/time/item rejects", async () => {
    const t = await fixture();
    const req = t.redeem();
    await t.customer(req);
    await expect(
      t.customer({ ...req, startAt: new Date(t.first.schedule.startAt.getTime() + 2 * 86400000) }),
    ).rejects.toThrow();
  });
  it("S5-08 foreign Business/client cannot redeem or inspect winner", async () => {
    const t = await fixture();
    const req = t.redeem();
    await t.customer(req);
    await expect(t.customer({ ...req, businessId: new Types.ObjectId() })).rejects.toThrow();
    await expect(t.customer({ ...req, businessClientId: new Types.ObjectId() })).rejects.toThrow();
  });
  it("S5-09 wrong purchased item rejects before capacity", async () => {
    const t = await fixture();
    await expect(
      t.customer({ ...t.redeem(), packageItemId: new Types.ObjectId() }),
    ).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
  });
  it("S5-12/16 FOREVER redemption creates no new purchase contract/attempt/FIRST", async () => {
    const t = await fixture({ mode: "FOREVER" });
    const r = await t.customer(t.redeem());
    expect(r?.booking?.financialContract).toBeUndefined();
    expect(await PaymentAttemptModel.countDocuments()).toBe(0);
    expect(String(r?.progress.originBookingId)).toBe(String(t.progress.originBookingId));
  });
  it("S5-13 inactive selected Staff denies despite other providers", async () => {
    const t = await fixture();
    const req = t.redeem();
    await t.f.providers[0]?.updateOne({ $set: { employmentActive: false } });
    await expect(t.customer(req)).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
  });
  it("S5-17/19/20 FIXED move preserves occupied duration and original allocated credit", async () => {
    const t = await fixture();
    const b = t.first;
    await ServiceModel.updateOne(
      { _id: must(b.serviceLines[0]).serviceId },
      { $set: { "fixedPricing.bufferAfterMin": 60 } },
    );
    const r = await t.customer(
      t.intent("RESCHEDULE", {
        bookingId: b._id,
        startAt: new Date(b.schedule.startAt.getTime() + 86400000),
      }),
    );
    expect(
      must(r?.booking).schedule.endAt.getTime() - must(r?.booking).schedule.startAt.getTime(),
    ).toBe(b.schedule.endAt.getTime() - b.schedule.startAt.getTime());
    expect(r?.progress.sessions.length).toBe(t.progress.sessions.length);
  });
  it("S5-18/21/25/27 Group move replay keeps original full purchase proof and one destination effect", async () => {
    const t = await fixture({ group: true });
    const req = t.intent("RESCHEDULE", {
      bookingId: t.first._id,
      startAt: new Date(t.first.schedule.startAt.getTime() + 86400000),
    });
    await t.customer(req);
    const n = await BookingSlotReservationClaimModel.countDocuments();
    await t.customer(req);
    expect(await BookingSlotReservationClaimModel.countDocuments()).toBe(n);
    expect(await readOwnedPackageBatchCompletion(t.scope)).toBeTruthy();
  });
  it("S5-22 invalid move restores old occupancy/Booking/Progress", async () => {
    const t = await fixture();
    const old = await BookingSlotReservationModel.find().lean();
    await expect(
      t.customer(
        t.intent("RESCHEDULE", {
          bookingId: t.first._id,
          startAt: new Date(t.first.schedule.startAt.getTime() + 86400000),
          staffMembershipId: new Types.ObjectId(),
        }),
      ),
    ).rejects.toThrow();
    expect(await BookingSlotReservationModel.find().lean()).toEqual(old);
    expect((await BookingModel.findById(t.first._id))?.schedule.startAt).toEqual(
      t.first.schedule.startAt,
    );
  });
  it("S5-28/30/31/33 free Group cancellation restores once, releases one, never refunds origin", async () => {
    const t = await fixture({ group: true });
    const req = t.intent("CANCEL", { bookingId: t.first._id });
    const r = await t.customer(req);
    await t.customer(req);
    expect(r?.progress.items[0]?.remainingSessions).toBe(
      must(t.progress.items[0]).remainingSessions + 1,
    );
    expect(t.gateway.refundInputs).toHaveLength(0);
    expect(await readOwnedPackageBatchCompletion(t.scope)).toBeTruthy();
  });
  it("S5-32 owner cancellation uses real ownership and restores credit", async () => {
    const t = await fixture();
    const r = await t.business(t.intent("CANCEL", { bookingId: t.first._id }));
    expect(r?.booking?.status).toBe("CANCELLED_BY_BUSINESS");
  });
  it("S5-35/36 completion resolves Scheduled to Completed once and keeps occupancy", async () => {
    const t = await fixture();
    const old = await BookingSlotReservationModel.find().lean();
    const req = t.intent("COMPLETE", { bookingId: t.first._id });
    const r = await t.business(req);
    await t.business(req);
    expect(r?.progress.items[0]?.completedSessions).toBe(1);
    expect(await BookingSlotReservationModel.find().lean()).toEqual(old);
    expect(await readOwnedPackageBatchCompletion(t.scope)).toBeTruthy();
  });
  it.each([6, 12] as const)("S5-41/42/44 FINITE%s expires only remaining once", async (months) => {
    const t = await fixture({ mode: "FINITE", months });
    if (t.progress.purchasedContract?.validity.mode !== "FINITE") throw Error("finite fixture");
    t.advance(t.progress.purchasedContract.validity.expiresAt);
    const req = t.intent("EXPIRE");
    const r = await t.customer(req);
    await t.customer(req);
    expect(r?.progress.items.every((i) => i.remainingSessions === 0)).toBe(true);
    expect(r?.progress.sessions.every((a) => a.status === "SCHEDULED")).toBe(true);
  });
  it("S5-43 FOREVER reconcile is a durable no-op", async () => {
    const t = await fixture({ mode: "FOREVER" });
    const r = await t.customer(t.intent("EXPIRE"));
    expect(r?.result.status).toBe("FOREVER");
    expect(r?.progress.expiryReconciledAt).toBeUndefined();
  });
  it("S5-11 expired redemption denies with no new reservation", async () => {
    const t = await fixture({ mode: "FINITE" });
    if (t.progress.purchasedContract?.validity.mode !== "FINITE") throw Error("finite fixture");
    t.advance(t.progress.purchasedContract.validity.expiresAt);
    await expect(t.customer(t.redeem())).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
  });
  it("S5-34/45 restoring after expiry increments X not R", async () => {
    const t = await fixture({ mode: "FINITE" });
    if (t.progress.purchasedContract?.validity.mode !== "FINITE") throw Error("finite fixture");
    t.advance(t.progress.purchasedContract.validity.expiresAt);
    const r = await t.business(t.intent("CANCEL", { bookingId: t.first._id }));
    expect(
      r?.progress.creditAccountingVersion === 2 ? r.progress.items[0]?.expiredSessions : undefined,
    ).toBe(1);
    expect(r?.progress.items[0]?.remainingSessions).toBe(t.progress.items[0]?.remainingSessions);
  });
  it("S5-51 abort after actual redemption reservation restores credit and capacity", async () => {
    const t = await fixture({ group: true });
    const original = t.reservations.reserveOrJoin.bind(t.reservations);
    vi.spyOn(t.reservations, "reserveOrJoin").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw Error("after reservation");
    });
    await expect(t.customer(t.redeem())).rejects.toThrow("after reservation");
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
    expect(
      (await PackageProgressV2Model.findById(t.progress._id))?.items[0]?.remainingSessions,
    ).toBe(t.progress.items[0]?.remainingSessions);
  });
  it("S5-52 abort after actual Booking insert rolls back every new write", async () => {
    const t = await fixture();
    const original = BookingRepository.prototype.create;
    vi.spyOn(BookingRepository.prototype, "create").mockImplementationOnce(async function (
      this: BookingRepository,
      ...args
    ) {
      await original.apply(this, args);
      throw Error("after Booking");
    });
    await expect(t.customer(t.redeem())).rejects.toThrow("after Booking");
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
  });
  it("S5-53 abort after Progress transition restores all credit", async () => {
    const t = await fixture();
    const original = PackageProgressV2Repository.prototype.claim;
    vi.spyOn(PackageProgressV2Repository.prototype, "claim").mockImplementationOnce(async function (
      this: PackageProgressV2Repository,
      ...args
    ) {
      await original.apply(this, args);
      throw Error("after claim");
    });
    await expect(t.customer(t.redeem())).rejects.toThrow("after claim");
    expect((await PackageProgressV2Model.findById(t.progress._id))?.sessions.length).toBe(
      t.progress.sessions.length,
    );
  });
  it("S5-54 Group release abort restores original Booking and effect", async () => {
    const t = await fixture({ group: true });
    const old = await BookingSlotReservationModel.find().lean();
    const original = t.reservations.release.bind(t.reservations);
    vi.spyOn(t.reservations, "release").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw Error("after release");
    });
    await expect(t.customer(t.intent("CANCEL", { bookingId: t.first._id }))).rejects.toThrow(
      "after release",
    );
    expect(await BookingSlotReservationModel.find().lean()).toEqual(old);
    expect((await BookingModel.findById(t.first._id))?.status).toBe("UPCOMING");
  });
  it("S5-55 delivery failure rolls back Booking/effects/Progress", async () => {
    const t = await fixture();
    vi.spyOn(EmailOutboxRepository.prototype, "enqueue").mockRejectedValueOnce(
      Error("email failure"),
    );
    await expect(t.customer(t.redeem())).rejects.toThrow("email failure");
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
  });
  it("S5-58 controlled lost application return resolves exact committed original identity", async () => {
    const t = await fixture();
    const original = mongoose.startSession.bind(mongoose);
    vi.spyOn(mongoose, "startSession").mockImplementationOnce(async (...args) => {
      const s = await original(...args);
      const tx = s.withTransaction.bind(s);
      s.withTransaction = async (...a) => {
        await tx(...a);
        throw Error("controlled lost return");
      };
      return s;
    });
    const req = t.redeem();
    const r = await t.customer(req);
    expect(r?.booking).toBeTruthy();
    expect(String((await t.customer(req))?.booking?._id)).toBe(String(r?.booking?._id));
  });
  it("S5-59 unknown absent winner remains pinned and never decrements another credit", async () => {
    const t = await fixture();
    vi.spyOn(PackageLifecycleOperations.prototype, "complete").mockRejectedValueOnce(
      Object.assign(Error("unknown"), { errorLabels: ["UnknownTransactionCommitResult"] }),
    );
    const req = t.redeem();
    await expect(t.customer(req)).rejects.toThrow();
    await expect(t.customer(req)).rejects.toThrow();
    expect((await PackageLifecycleOperationModel.findOne())?.phase).toBe("PERSISTING");
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
  });
  it("S5-60 purchase replay ignores additional redemption members while original IDs/origin stay fixed", async () => {
    const t = await fixture({ group: true });
    const r = await t.customer(t.redeem());
    const q = await readOwnedPackageBatchCompletion(t.scope);
    expect(q?.bookings).toHaveLength(t.full.bookings.length);
    expect(String(q?.progress.originBookingId)).toBe(String(t.progress.originBookingId));
    await t.customer(t.intent("CANCEL", { bookingId: must(r?.booking)._id }));
    expect(await readOwnedPackageBatchCompletion(t.scope)).toBeTruthy();
  });
  it("S5-03 mixed purchased items independently redeem their exact Service", async () => {
    const t = await fixture({ group: true });
    await t.customer(t.redeem());
    const original = must(t.full.bookings[1]);
    const item = must(
      t.progress.items.find((i) => i.serviceId.equals(must(original.serviceLines[0]).serviceId)),
    );
    const r = await t.customer(
      t.intent("REDEEM", {
        packageItemId: item.packageItemId,
        staffMembershipId: must(original.serviceLines[0]).responsibleStaffMembershipId,
        startAt: new Date(original.schedule.startAt.getTime() + 2 * 86400000),
      }),
    );
    expect(String(r?.booking?.serviceLines[0]?.serviceId)).toBe(String(item.serviceId));
    expect(r?.progress.sessions.length).toBe(t.progress.sessions.length + 2);
  });
  it("S5-08 real foreign Customer JWT cannot claim another purchased Progress", async () => {
    const t = await fixture();
    const foreign = await UserModel.create({
      normalizedEmail: "foreign@s5.test",
      passwordHash: "unused",
      role: "CUSTOMER",
      status: "ACTIVE",
      security: { passwordUpdatedAt: INTERNAL_TIME },
    });
    const authorization = `Bearer ${await issueTestAccessToken(t.tokens, { userId: foreign._id, role: "CUSTOMER" })}`;
    const capability = await t.authority.authenticate(authorization);
    await expect(t.lifecycle.customer(capability, t.redeem())).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
  });
  it("S5-10 remaining-zero denies without another Booking or seat", async () => {
    const t = await fixture();
    const n = must(t.progress.items[0]).remainingSessions;
    for (let i = 0; i < n; i++)
      await t.customer({
        ...t.redeem(),
        startAt: new Date(t.first.schedule.startAt.getTime() + (i + 1) * 86400000),
      });
    await expect(
      t.customer({
        ...t.redeem(),
        startAt: new Date(t.first.schedule.startAt.getTime() + 8 * 86400000),
      }),
    ).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length + n);
  });
  it("S5-14 final Group seat elects one complete redemption and exact shared target", async () => {
    const t = await fixture({ group: true });
    const req = t.redeem();
    const staff = must(t.first.serviceLines[0]).responsibleStaffMembershipId;
    const start = must(req.startAt);
    const end = new Date(
      start.getTime() + t.first.schedule.endAt.getTime() - t.first.schedule.startAt.getTime(),
    );
    const prior = await t.reservations.reserveOrJoin({
      businessId: t.scope.businessId,
      staffMembershipId: staff,
      serviceId: must(t.first.serviceLines[0]).serviceId,
      timezone: "UTC",
      startAt: start,
      endAt: end,
      capacityMax: 3,
      partySize: 2,
      idempotencyKey: "s5:ordinary-party",
    });
    const results = await Promise.allSettled([
      t.customer(req),
      t.customer({ ...req, key: `s5:${new Types.ObjectId()}` }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = results.find((r) => r.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw Error("winner");
    expect(String(winner.value?.booking?.serviceLines[0]?.reservationId)).toBe(
      String(prior.reservationId),
    );
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length + 1);
  });
  it("S5-23 cancellation versus move has one consistent parent outcome", async () => {
    const t = await fixture({ group: true });
    await Promise.allSettled([
      t.customer(t.intent("CANCEL", { bookingId: t.first._id })),
      t.customer(
        t.intent("RESCHEDULE", {
          bookingId: t.first._id,
          startAt: new Date(t.first.schedule.startAt.getTime() + 86400000),
        }),
      ),
    ]);
    const booking = await BookingModel.findById(t.first._id).orFail();
    const p = await PackageProgressV2Model.findById(t.progress._id).orFail();
    expect(booking.status).toBe("CANCELLED_BY_CUSTOMER");
    expect(p.sessions.find((a) => a.bookingId.equals(booking._id))?.status).toBe("CANCELLED");
    expect(await readOwnedPackageBatchCompletion(t.scope)).toBeTruthy();
  });
  it("S5-24 missing historical Group effect fails closed without releasing any party", async () => {
    const t = await fixture({ group: true });
    const key = must(t.first.serviceLines[0]).reservationOperationKey;
    await BookingSlotReservationClaimModel.collection.updateOne(
      { idempotencyKey: key },
      { $unset: { effect: "" } },
    );
    const old = await BookingSlotReservationModel.find().lean();
    await expect(t.customer(t.intent("CANCEL", { bookingId: t.first._id }))).rejects.toThrow();
    expect(await BookingSlotReservationModel.find().lean()).toEqual(old);
  });
  it("S5-26 reschedule retires old reminders in-parent and stale initial Calendar remains non-dispatching", async () => {
    const t = await fixture({ endReminder: true });
    const r = await t.customer(
      t.intent("RESCHEDULE", {
        bookingId: t.first._id,
        startAt: new Date(t.first.schedule.startAt.getTime() + 86400000),
      }),
    );
    expect(
      await AppointmentReminderModel.countDocuments({
        bookingId: t.first._id,
        status: "CANCELLED",
      }),
    ).toBeGreaterThan(0);
    expect(r?.result.reminders.length).toBe(2);
    expect(
      r?.result.tasks.every(
        (x) =>
          x.lifecycleVersion === 1 &&
          (x.port === "OWNER_EMAIL"
            ? x.state === "PLANNED" && !!x.outboxId
            : x.state === "BLOCKED_UNVERIFIED"),
      ),
    ).toBe(true);
  });
  it("S5-29 zero-cap purchased late cancellation forfeits instead of restoring", async () => {
    const t = await fixture({ policy: true, latePercentage: 50 });
    t.advance(new Date(t.first.schedule.startAt.getTime() - 60000));
    const r = await t.customer(t.intent("CANCEL", { bookingId: t.first._id }));
    expect(r?.booking?.status).toBe("LATE_CANCELLATION");
    expect(r?.progress.sessions.find((a) => a.bookingId.equals(t.first._id))?.status).toBe(
      "FORFEITED",
    );
    expect(r?.progress.items[0]?.remainingSessions).toBe(t.progress.items[0]?.remainingSessions);
    expect(await PaymentAttemptModel.countDocuments()).toBe(0);
  });
  it("S5-37/38 zero-cap no-show marks explicitly then forfeits once after source90 minute deadline", async () => {
    const t = await fixture({ policy: true, categoryWindow: true });
    const w = must(t.first.noShowEligibilitySnapshot);
    t.advance(new Date(t.first.schedule.startAt.getTime() + w.opensAfterMinutes * 60000));
    const marked = await t.business(t.intent("MARK_NO_SHOW", { bookingId: t.first._id }));
    expect(marked?.progress.sessions.find((a) => a.bookingId.equals(t.first._id))?.status).toBe(
      "SCHEDULED",
    );
    t.advance(must(marked?.booking?.noShowDeadlineAt));
    const req = t.intent("NO_SHOW", { bookingId: t.first._id });
    const r = await t.business(req);
    await t.business(req);
    expect(r?.booking?.status).toBe("NO_SHOW_WAIVED");
    expect(r?.progress.sessions.find((a) => a.bookingId.equals(t.first._id))?.status).toBe(
      "FORFEITED",
    );
    expect(await PaymentAttemptModel.countDocuments()).toBe(0);
  });
  it("S5-37 no-show close boundary is exclusive and cannot be fabricated by timing alone", async () => {
    const t = await fixture({ policy: true, categoryWindow: true });
    const w = must(t.first.noShowEligibilitySnapshot);
    t.advance(new Date(t.first.schedule.startAt.getTime() + w.closesAfterMinutes * 60000));
    await expect(
      t.business(t.intent("MARK_NO_SHOW", { bookingId: t.first._id })),
    ).rejects.toThrow();
    expect((await BookingModel.findById(t.first._id))?.status).toBe("UPCOMING");
  });
  it("S5-39 conflicting completion and cancellation resolve at most one terminal attempt", async () => {
    const t = await fixture();
    const r = await Promise.allSettled([
      t.business(t.intent("COMPLETE", { bookingId: t.first._id })),
      t.customer(t.intent("CANCEL", { bookingId: t.first._id })),
    ]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const p = await PackageProgressV2Model.findById(t.progress._id).orFail();
    expect(["CANCELLED", "COMPLETED"]).toContain(
      p.sessions.find((a) => a.bookingId.equals(t.first._id))?.status,
    );
    expect(await readOwnedPackageBatchCompletion(t.scope)).toBeTruthy();
  });
  it("S5-45 expiry and cancellation restoration contend without extra available credits", async () => {
    const t = await fixture({ mode: "FINITE" });
    if (t.progress.purchasedContract?.validity.mode !== "FINITE") throw Error("finite");
    t.advance(t.progress.purchasedContract.validity.expiresAt);
    await Promise.all([
      t.customer(t.intent("EXPIRE")),
      t.business(t.intent("CANCEL", { bookingId: t.first._id })),
    ]);
    const p = await PackageProgressV2Model.findById(t.progress._id).orFail();
    if (p.creditAccountingVersion !== 2) throw Error("accounting2");
    expect(p.items[0]?.remainingSessions).toBe(0);
    expect(p.items[0]?.expiredSessions).toBe(must(t.progress.items[0]).remainingSessions + 1);
  });
  it("S5-46 scheduled attempt can complete after finite boundary without returning expired credit", async () => {
    const t = await fixture({ mode: "FINITE" });
    if (t.progress.purchasedContract?.validity.mode !== "FINITE") throw Error("finite");
    t.advance(t.progress.purchasedContract.validity.expiresAt);
    const r = await t.business(t.intent("COMPLETE", { bookingId: t.first._id }));
    expect(r?.progress.items[0]?.completedSessions).toBe(1);
  });
  it("S5-55 abort after reminder retirement restores old active intents and Booking", async () => {
    const t = await fixture({ endReminder: true });
    const old = await AppointmentReminderModel.find().lean();
    vi.spyOn(AppointmentReminderRepository.prototype, "schedule").mockRejectedValueOnce(
      Error("reminder failure"),
    );
    await expect(
      t.customer(
        t.intent("RESCHEDULE", {
          bookingId: t.first._id,
          startAt: new Date(t.first.schedule.startAt.getTime() + 86400000),
        }),
      ),
    ).rejects.toThrow("reminder failure");
    expect(await AppointmentReminderModel.find().lean()).toEqual(old);
  });
  it("S5-56 actual server112 retries the entire callback with the pinned operation/Booking", async () => {
    const t = await fixture();
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
    const req = t.redeem();
    const pending = t.customer(req);
    await reached;
    try {
      await t.hours.replace(
        t.scope.businessId,
        (
          ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const
        ).map((dayOfWeek) => ({
          dayOfWeek,
          isOpen: true,
          slots: [{ startTime: "09:00", endTime: "18:00" }],
        })),
      );
    } finally {
      release();
    }
    const r = await pending;
    expect(codes).toContain(112);
    serverCodes.push(...codes);
    expect(String(r?.booking?._id)).toBe(
      String((await PackageLifecycleOperationModel.findOne())?.bookingId),
    );
  }, 30000);
  it("S5-57 actual retained redemption _id11000 rolls back without false winner", async () => {
    const t = await fixture();
    const original = PackageLifecycleOperations.prototype.claim;
    vi.spyOn(PackageLifecycleOperations.prototype, "claim").mockImplementationOnce(async function (
      this: PackageLifecycleOperations,
      ...args
    ) {
      const op = await original.apply(this, args);
      if (!op?.bookingId || !mongoose.connection.db) throw Error("owned fixture missing");
      await mongoose.connection.db.collection("bookings").insertOne({ _id: op.bookingId });
      return op;
    });
    const error = await t.customer(t.redeem()).catch((e) => e);
    expect(error.code).toBe(11000);
    serverCodes.push(error.code);
    expect((await PackageProgressV2Model.findById(t.progress._id))?.sessions.length).toBe(
      t.progress.sessions.length,
    );
    expect((await PackageLifecycleOperationModel.findOne())?.phase).toBe("PREPARED");
  });
  it("S5 positive accepted penalty remains fail-closed instead of applying legacy suppression", async () => {
    const t = await fixture({
      policy: true,
      categoryWindow: true,
      latePercentage: 50,
      bundlePriceCents: 100,
    });
    t.advance(new Date(t.first.schedule.startAt.getTime() - 60000));
    await expect(t.customer(t.intent("CANCEL", { bookingId: t.first._id }))).rejects.toThrow(
      "PENALTY_AUTHORITY_REQUIRED",
    );
    expect((await BookingModel.findById(t.first._id))?.status).toBe("UPCOMING");
  });
  it("S5 later travel redemption stays fail-closed without a later-session accepted-charge authority", async () => {
    const t = await fixture({ travel: true });
    await expect(t.customer(t.redeem())).rejects.toThrow("CHARGE_AUTHORITY_REQUIRED");
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
  });
  it("S5 unpaid origin balance keeps remaining redemption locked", async () => {
    const t = await fixture({ bundlePriceCents: 100 });
    await expect(t.customer(t.redeem())).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
  });
  it("S5-33/60 actual fake-paid origin cancellation preserves attempt/ledger/FIRST evidence", async () => {
    const t = await fixture({ first: true, bundlePriceCents: 1000 });
    const before = await PaymentAttemptModel.find().lean();
    const r = await t.customer(t.intent("CANCEL", { bookingId: t.first._id }));
    expect(r?.booking?.financials.depositCents).toBe(500);
    expect(await PaymentAttemptModel.find().lean()).toEqual(before);
    expect(t.gateway.refundInputs).toHaveLength(0);
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
    expect(await readOwnedPackageBatchCompletion(t.scope)).toBeTruthy();
  });
  it("S5 positive no-show penalty resolution stays pending without fabricating a charge", async () => {
    const t = await fixture({ policy: true, categoryWindow: true, bundlePriceCents: 100 });
    const w = must(t.first.noShowEligibilitySnapshot);
    t.advance(new Date(t.first.schedule.startAt.getTime() + w.opensAfterMinutes * 60000));
    const marked = await t.business(t.intent("MARK_NO_SHOW", { bookingId: t.first._id }));
    t.advance(must(marked?.booking?.noShowDeadlineAt));
    await expect(t.business(t.intent("NO_SHOW", { bookingId: t.first._id }))).rejects.toThrow(
      "PENALTY_AUTHORITY_REQUIRED",
    );
    expect((await BookingModel.findById(t.first._id))?.status).toBe("PENDING");
    expect(await PaymentAttemptModel.countDocuments()).toBe(0);
  });
  it("S5 reversing an explicit no-show restores its one credit without rewriting past occupancy", async () => {
    const t = await fixture({ policy: true, categoryWindow: true });
    const w = must(t.first.noShowEligibilitySnapshot);
    t.advance(new Date(t.first.schedule.startAt.getTime() + w.opensAfterMinutes * 60000));
    await t.business(t.intent("MARK_NO_SHOW", { bookingId: t.first._id }));
    const before = await BookingSlotReservationModel.find().lean();
    const r = await t.business(t.intent("REVERSE_NO_SHOW", { bookingId: t.first._id }));
    expect(r?.booking?.status).toBe("NO_SHOW_CANCELLED");
    expect(r?.progress.items[0]?.remainingSessions).toBe(
      must(t.progress.items[0]).remainingSessions + 1,
    );
    expect(await BookingSlotReservationModel.find().lean()).toEqual(before);
  });
  it("S5-04/49 concurrent consumers of the last remaining credit admit exactly one Booking", async () => {
    const t = await fixture();
    const remaining = must(t.progress.items[0]).remainingSessions;
    for (let i = 1; i < remaining; i++)
      await t.customer({
        ...t.redeem(),
        startAt: new Date(t.first.schedule.startAt.getTime() + i * 86400000),
      });
    const before = await BookingModel.countDocuments();
    const results = await Promise.allSettled([
      t.customer({
        ...t.redeem(),
        startAt: new Date(t.first.schedule.startAt.getTime() + 8 * 86400000),
      }),
      t.customer({
        ...t.redeem(),
        startAt: new Date(t.first.schedule.startAt.getTime() + 9 * 86400000),
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await BookingModel.countDocuments()).toBe(before + 1);
    expect(
      (await PackageProgressV2Model.findById(t.progress._id))?.items[0]?.remainingSessions,
    ).toBe(0);
  });
  it("S5-06 concurrent same-key contender stays bounded and converges on original winner", async () => {
    const t = await fixture({ group: true });
    let release = () => {},
      entered = () => {};
    const hold = new Promise<void>((r) => {
        release = r;
      }),
      reached = new Promise<void>((r) => {
        entered = r;
      });
    const reserve = t.reservations.reserveOrJoin.bind(t.reservations);
    vi.spyOn(t.reservations, "reserveOrJoin").mockImplementationOnce(async (...args) => {
      entered();
      await hold;
      return reserve(...args);
    });
    const req = t.redeem(),
      pending = t.customer(req);
    await reached;
    try {
      await expect(t.customer(req)).rejects.toMatchObject({ statusCode: 503 });
    } finally {
      release();
    }
    const winner = await pending;
    expect(String((await t.customer(req))?.booking?._id)).toBe(String(winner?.booking?._id));
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length + 1);
  }, 30000);
  it("S5-47/48 mixed terminal histories preserve the full accounting equation and original batch", async () => {
    const t = await fixture({ group: true });
    const redeemed = await t.customer(t.redeem());
    await t.customer(t.intent("CANCEL", { bookingId: t.first._id }));
    await t.business(t.intent("COMPLETE", { bookingId: must(t.full.bookings[1])._id }));
    const r = await t.customer(t.intent("CANCEL", { bookingId: must(redeemed?.booking)._id }));
    const p = must(r?.progress);
    if (p.creditAccountingVersion !== 2) throw Error("accounting2");
    for (const item of p.items) {
      const attempts = p.sessions.filter((a) => a.packageItemId.equals(item.packageItemId));
      expect(item.totalSessions).toBe(
        item.remainingSessions +
          item.completedSessions +
          item.expiredSessions +
          attempts.filter((a) => a.status === "SCHEDULED" || a.status === "FORFEITED").length,
      );
    }
    expect(new Set(p.sessions.map((a) => String(a.bookingId))).size).toBe(p.sessions.length);
    expect(await readOwnedPackageBatchCompletion(t.scope)).toBeTruthy();
  });
  it("S5 generic operation mutation cannot forge a result or erase pending evidence", async () => {
    const t = await fixture();
    await t.customer(t.redeem());
    await expect(
      PackageLifecycleOperationModel.updateOne({}, { $set: { phase: "COMPLETE", result: {} } }),
    ).rejects.toThrow();
    await expect(PackageLifecycleOperationModel.deleteMany({})).rejects.toThrow();
    await expect(
      new PackageLifecycleOperationModel({ intent: {}, phase: "COMPLETE" }).save({
        validateBeforeSave: false,
      }),
    ).rejects.toThrow();
  });
  it("S5F1 venue FULL on permanent origin unlocks remaining credit without purchase rewrite", async () => {
    const t = await fixture({ bundlePriceCents: 1000 });
    await expect(t.customer(t.redeem())).rejects.toThrow();
    const before = t.first.financials;
    const request = t.intent("VENUE_SETTLEMENT", {
      bookingId: t.progress.originBookingId,
      venuePayment: { settlement: "FULL" },
    });
    const settled = await t.business(request);
    expect(settled?.result.venue?.amountCents).toBe(1000);
    expect(settled?.booking?.toObject().financials).toEqual(before);
    const ledger = await BookingFinancialTransactionModel.findById(settled?.result.venue?.ledgerId);
    expect(ledger?.amountCents).toBe(1000);
    expect(ledger?.metadata?.["collectedAtVenue"]).toBe(true);
    expect((await t.customer(t.redeem()))?.booking?.status).toBe("UPCOMING");
    expect(await readOwnedPackageBatchCompletion(t.scope)).not.toBeNull();
    expect(await PaymentAttemptModel.countDocuments()).toBe(0);
  });
  it("S5F1 venue PARTIAL then FULL records only outstanding delta and replay adds nothing", async () => {
    const t = await fixture({ bundlePriceCents: 1000 });
    const a = t.intent("VENUE_SETTLEMENT", {
      bookingId: t.first._id,
      venuePayment: { settlement: "PARTIAL", amountCents: 400 },
    });
    expect((await t.business(a))?.result.venue?.cumulativeCents).toBe(400);
    await expect(t.customer(t.redeem())).rejects.toThrow();
    const b = t.intent("VENUE_SETTLEMENT", {
      bookingId: t.first._id,
      venuePayment: { settlement: "FULL" },
    });
    expect((await t.business(b))?.result.venue?.amountCents).toBe(600);
    const before = await BookingFinancialTransactionModel.find().lean();
    await t.business(a);
    await t.business(b);
    expect(await BookingFinancialTransactionModel.find().lean()).toEqual(before);
    expect((await t.customer(t.redeem()))?.booking).toBeTruthy();
  });
  it("S5F1 venue NOT_PAID and completion alone never unlock an unpaid origin", async () => {
    const t = await fixture({ bundlePriceCents: 1000 });
    const completed = await t.business(
      t.intent("COMPLETE", { bookingId: t.first._id, venuePayment: { settlement: "NOT_PAID" } }),
    );
    expect(completed?.booking?.status).toBe("COMPLETED");
    expect(completed?.booking?.completionPayment?.paid).toBe(false);
    expect(await BookingFinancialTransactionModel.countDocuments({ type: "PAYMENT" })).toBe(0);
    await expect(t.customer(t.redeem())).rejects.toThrow();
    await t.business(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    expect((await t.customer(t.redeem()))?.booking).toBeTruthy();
  });
  it.each([0, -1, 1000, 1001, 1.5])(
    "S5F1 venue rejects invalid partial %s with no ledger",
    async (amountCents) => {
      const t = await fixture({ bundlePriceCents: 1000 });
      await expect(
        t.business(
          t.intent("VENUE_SETTLEMENT", {
            bookingId: t.first._id,
            venuePayment: { settlement: "PARTIAL", amountCents },
          }),
        ),
      ).rejects.toThrow();
      expect((await BookingModel.findById(t.first._id))?.completionPayment).toBeUndefined();
      expect(await BookingFinancialTransactionModel.countDocuments({ type: "PAYMENT" })).toBe(0);
    },
  );
  it("S5F1 two different full venue attestations cannot collect twice", async () => {
    const t = await fixture({ bundlePriceCents: 1000 });
    const requests = [0, 1].map(() =>
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const results = await Promise.allSettled(requests.map(t.business));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (await BookingFinancialTransactionModel.find({ type: "PAYMENT" })).map((r) => r.amountCents),
    ).toEqual([1000]);
  });
  it("S5F1 venue ledger failure rolls back attestation and credit state", async () => {
    const t = await fixture({ bundlePriceCents: 1000 });
    const original = await PackageProgressV2Model.findById(t.progress._id).lean();
    vi.spyOn(BookingFinancialTransactionService.prototype, "record").mockRejectedValueOnce(
      Error("injected ledger abort"),
    );
    await expect(
      t.business(
        t.intent("COMPLETE", { bookingId: t.first._id, venuePayment: { settlement: "FULL" } }),
      ),
    ).rejects.toThrow("injected ledger abort");
    expect((await BookingModel.findById(t.first._id))?.completionPayment).toBeUndefined();
    expect((await BookingModel.findById(t.first._id))?.status).toBe("UPCOMING");
    expect(await PackageProgressV2Model.findById(t.progress._id).lean()).toEqual(original);
  });
  it("S5F1 Customer cannot attest venue payment or smuggle it into cancellation", async () => {
    const t = await fixture({ bundlePriceCents: 1000 });
    await expect(
      t.customer(
        t.intent("VENUE_SETTLEMENT", {
          bookingId: t.first._id,
          venuePayment: { settlement: "FULL" },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      t.customer(
        t.intent("CANCEL", { bookingId: t.first._id, venuePayment: { settlement: "FULL" } }),
      ),
    ).rejects.toThrow();
    expect(await BookingFinancialTransactionModel.countDocuments({ type: "PAYMENT" })).toBe(0);
  });

  it("S5F1 positive late cancellation captures independently, forfeits once and preserves purchase money", async () => {
    const t = await fixture({
      first: true,
      bundlePriceCents: 1000,
      policy: true,
      categoryWindow: true,
      latePercentage: 50,
    });
    const originalAttempt = await PaymentAttemptModel.findOne().lean();
    t.advance(new Date(t.first.schedule.startAt.getTime() - 60000));
    const request = t.intent("CANCEL", { bookingId: t.first._id });
    const result = await t.moneyLifecycle.customer(t.scope.customer, request);
    expect(result?.booking?.status).toBe("LATE_CANCELLATION");
    expect(
      (
        await EmailOutboxModel.findOne({
          eventKey: `PACKAGE_LIFECYCLE:${request.key}`,
          templateKey: "BOOKING_CANCELLED_CUSTOMER",
        })
      )?.payload,
    ).toMatchObject({
      financialOutcome: {
        hasCancellationFee: true,
        hasAdditionalCharge: true,
        settlementStatus: "SUCCEEDED",
      },
    });
    expect(result?.result.money?.amountCents).toBe(500);
    expect(result?.progress.sessions.find((a) => a.bookingId.equals(t.first._id))?.status).toBe(
      "FORFEITED",
    );
    expect(await PaymentAttemptModel.findById(originalAttempt?._id).lean()).toEqual(
      originalAttempt,
    );
    expect(t.gateway.paymentIntentInputs).toHaveLength(2);
    expect(t.gateway.paymentIntentInputs[1]?.metadata["purpose"]).toBe("PACKAGE_LIFECYCLE_MONEY");
    expect(
      t.gateway.paymentIntentInputs[1]?.metadata["relationshipClassification"],
    ).toBeUndefined();
    const before = await BookingFinancialTransactionModel.find().lean();
    await t.moneyLifecycle.customer(t.scope.customer, request);
    expect(await BookingFinancialTransactionModel.find().lean()).toEqual(before);
    expect(t.gateway.paymentIntentInputs).toHaveLength(2);
    expect(await readOwnedPackageBatchCompletion(t.scope)).toBeTruthy();
  });
  it("S5F1 concurrent assessments share the fixed lifetime budget across original siblings", async () => {
    const t = await fixture({
      count: 2,
      first: true,
      bundlePriceCents: 1000,
      policy: true,
      categoryWindow: true,
      latePercentage: 100,
    });
    t.advance(
      new Date(Math.max(...t.full.bookings.map((b) => b.schedule.startAt.getTime())) - 60000),
    );
    const requests = t.full.bookings.map((b) => t.intent("CANCEL", { bookingId: b._id }));
    await Promise.all(requests.map((req) => t.moneyLifecycle.customer(t.scope.customer, req)));
    const ledgers = await BookingFinancialTransactionModel.find({ type: "CANCELLATION_FEE" });
    expect(ledgers.reduce((sum, r) => sum + r.amountCents, 0)).toBe(500);
    const operations = await PackageLifecycleOperationModel.find({ assessment: { $exists: true } });
    expect(operations.map((o) => o.assessment.amountCents).reduce((a, b) => a + b, 0)).toBe(500);
    expect(t.gateway.paymentIntentInputs).toHaveLength(2);
  });
  it("S5F1 positive no-show captures independent basis after explicit deadline, then replay stays read-only", async () => {
    const t = await fixture({
      first: true,
      bundlePriceCents: 1000,
      policy: true,
      categoryWindow: true,
    });
    const window = must(t.first.noShowEligibilitySnapshot);
    t.advance(new Date(t.first.schedule.startAt.getTime() + window.opensAfterMinutes * 60000));
    const marked = await t.business(t.intent("MARK_NO_SHOW", { bookingId: t.first._id }));
    t.advance(must(marked?.booking?.noShowDeadlineAt));
    const request = t.intent("NO_SHOW", { bookingId: t.first._id });
    const result = await t.moneyLifecycle.business(
      t.f.business.ownerUserId,
      "BUSINESS_OWNER",
      t.f.context.customerUserId,
      request,
    );
    expect(result?.booking?.status).toBe("NO_SHOW_CHARGED");
    expect(
      (
        await EmailOutboxModel.findOne({
          eventKey: `PACKAGE_LIFECYCLE:${request.key}`,
          templateKey: "NO_SHOW_CHARGED",
        })
      )?.payload,
    ).toMatchObject({
      outcome: "CHARGED",
      charged: { upfrontAppliedFormatted: "\u20ac0.00", additionalChargeFormatted: "\u20ac2.00" },
    });
    expect(result?.result.money?.amountCents).toBe(200);
    expect(
      await BookingFinancialTransactionModel.countDocuments({
        type: "NO_SHOW_FEE",
        status: "SUCCEEDED",
      }),
    ).toBe(1);
    await t.moneyLifecycle.business(
      t.f.business.ownerUserId,
      "BUSINESS_OWNER",
      t.f.context.customerUserId,
      request,
    );
    expect(t.gateway.paymentIntentInputs).toHaveLength(2);
  });
  it("S5F1 definite paid lifecycle abort refunds exact new attempt, keeps purchase untouched and allowance spent", async () => {
    const t = await fixture({
      first: true,
      bundlePriceCents: 1000,
      policy: true,
      categoryWindow: true,
      latePercentage: 50,
    });
    t.advance(new Date(t.first.schedule.startAt.getTime() - 60000));
    const request = t.intent("CANCEL", { bookingId: t.first._id });
    vi.spyOn(EmailOutboxRepository.prototype, "enqueue").mockRejectedValueOnce(
      Error("paid parent abort"),
    );
    await expect(t.moneyLifecycle.customer(t.scope.customer, request)).rejects.toThrow(
      "paid parent abort",
    );
    expect((await BookingModel.findById(t.first._id))?.status).toBe("UPCOMING");
    expect(t.gateway.refundInputs).toHaveLength(1);
    expect(t.gateway.refundInputs[0]?.amountCents).toBe(500);
    expect(
      (await PackageLifecycleOperationModel.findOne({ "intent.key": request.key }))?.phase,
    ).toBe("FAILED_FINAL");
    await expect(t.moneyLifecycle.customer(t.scope.customer, request)).rejects.toThrow();
    expect(t.gateway.paymentIntentInputs).toHaveLength(2);
    expect(
      await BookingFinancialTransactionModel.countDocuments({ type: "CANCELLATION_FEE" }),
    ).toBe(0);
    expect(await readOwnedPackageBatchCompletion(t.scope)).toBeTruthy();
  });

  it("S5F1 venue session Add-ons require exact acceptance and remain independent unpaid dues", async () => {
    const t = await fixture({ addon: true, bundlePriceCents: 0 });
    await t.business(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const addonId = must(t.first.serviceLines[0]?.addons[0]).addonId;
    const request = {
      ...t.redeem(),
      dues: { addonIds: [addonId], paymentMethod: "VENUE" as const },
    };
    const offer = await t.sessionOffer(request);
    expect(offer.quote.terms.totalCents).toBe(500);
    expect(offer.quote.disclosure).toContain("Accepted extra");
    expect(offer.quote.disclosure).toContain("does not certify payment received");
    await expect(t.customer(request)).rejects.toThrow();
    await offer.accept();
    const result = await t.customer(request);
    expect(result?.booking?.financials).toMatchObject({
      servicesSubtotalCents: 0,
      addonsSubtotalCents: 500,
      totalCents: 500,
      balanceDueCents: 500,
      depositCents: 0,
      platformFeeCents: 0,
    });
    expect(result?.booking?.serviceLines[0]?.addons[0]?.priceCents).toBe(500);
    expect(await PaymentAttemptModel.countDocuments()).toBe(0);
    expect(await readOwnedPackageBatchCompletion(t.scope)).toBeTruthy();
  });
  it("S5F1 online one-seat Group Add-on dues create an independent settled attempt without bundle/FIRST", async () => {
    const t = await fixture({ group: true, addon: true, first: true, bundlePriceCents: 0 });
    await t.business(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const request = {
      ...t.redeem(),
      dues: {
        addonIds: [must(t.first.serviceLines[0]?.addons[0]).addonId],
        paymentMethod: "ONLINE" as const,
      },
    };
    await (await t.sessionOffer(request)).accept();
    const result = await t.moneyLifecycle.customer(t.scope.customer, request);
    expect(result?.booking?.financials).toMatchObject({
      servicesSubtotalCents: 0,
      addonsSubtotalCents: 500,
      depositCents: 500,
      balanceDueCents: 0,
      platformFeeCents: 0,
    });
    expect(result?.booking?.serviceLines[0]?.schedulingSnapshot?.group?.partySize).toBe(1);
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
    expect(t.gateway.paymentIntentInputs[0]?.offSession).toBe(false);
    expect(t.gateway.paymentIntentInputs[0]?.metadata["booklyLifecycleKind"]).toBe("SESSION_DUES");
    expect(await readOwnedPackageBatchCompletion(t.scope)).toBeTruthy();
    await t.moneyLifecycle.customer(t.scope.customer, request);
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
  });
  it("S5F1 travel redemption binds purchased fee/current coverage/address and venue dues", async () => {
    const t = await fixture({ travel: true });
    await t.business(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const { location: _location, ...travelAddress } = must(t.first.fulfilment.travelAddress);
    const request = {
      ...t.redeem(),
      dues: { addonIds: [], paymentMethod: "VENUE" as const, travelAddress },
    };
    const offer = await t.sessionOffer(request);
    await offer.accept();
    const result = await t.customer(request);
    const fee = must(
      t.progress.items[0]?.travelCities?.find((c) => c.city === travelAddress.city),
    ).feeCents;
    expect(result?.booking?.financials.travelFeeCents).toBe(fee);
    expect(result?.booking?.financials.balanceDueCents).toBe(fee);
    expect(result?.booking?.fulfilment.travelAddress?.streetName).toBe(travelAddress.streetName);
    expect(result?.booking?.financials.servicesSubtotalCents).toBe(0);
  });
  it("S5F1 accepted session Add-on repricing rejects without dropping accepted money or consuming credit", async () => {
    const t = await fixture({ addon: true });
    await t.business(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const addonId = must(t.first.serviceLines[0]?.addons[0]).addonId;
    const request = {
      ...t.redeem(),
      dues: { addonIds: [addonId], paymentMethod: "VENUE" as const },
    };
    await (await t.sessionOffer(request)).accept();
    await AddonModel.updateOne({ _id: addonId }, { $set: { priceCents: 600 } });
    await expect(t.customer(request)).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
    expect(
      (await PackageProgressV2Model.findById(t.progress._id))?.items[0]?.remainingSessions,
    ).toBe(t.progress.items[0]?.remainingSessions);
  });
  it("S5F1 removed Add-on assignment denies exact accepted session", async () => {
    const t = await fixture({ addon: true });
    await t.business(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const addonId = must(t.first.serviceLines[0]?.addons[0]).addonId;
    const request = {
      ...t.redeem(),
      dues: { addonIds: [addonId], paymentMethod: "VENUE" as const },
    };
    await (await t.sessionOffer(request)).accept();
    await AddonServiceAssignmentModel.deleteOne({
      addonId,
      serviceId: must(t.first.serviceLines[0]).serviceId,
    });
    await expect(t.customer(request)).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
  });
  it("S5F1 forged session acceptance challenge or changed selection never grants dues authority", async () => {
    const t = await fixture();
    const request = { ...t.redeem(), dues: { addonIds: [], paymentMethod: "VENUE" as const } };
    const offer = await t.sessionOffer(request);
    await expect(
      new PackageLifecycleOperations().acceptSession(
        t.scope.customer,
        offer.fullIntent,
        {
          quoteId: offer.quote.quoteId,
          termsHash: offer.quote.termsHash,
          disclosureHash: offer.quote.disclosureHash,
          challenge: "forged",
          action: "ACCEPT_SESSION_DUES",
        },
        t.clock(),
      ),
    ).rejects.toThrow();
    await expect(t.customer(request)).rejects.toThrow();
    await offer.accept();
    await expect(
      t.customer({ ...request, startAt: new Date(must(request.startAt).getTime() + 60000) }),
    ).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
  });
  it("S5F1 callable Calendar consumer reconciles only persisted event identity and repeats without another call", async () => {
    const t = await fixture();
    await BookingModel.updateOne(
      { _id: t.first._id },
      { $set: { googleCalendarEventId: "already-existing-offline-event" } },
    );
    const request = t.intent("RESCHEDULE", {
      bookingId: t.first._id,
      startAt: new Date(t.first.schedule.startAt.getTime() + 86400000),
    });
    await t.customer(request);
    const op = await PackageLifecycleOperationModel.findOne({ "intent.key": request.key }).orFail();
    const reconcileExisting = vi.fn(
      async (
        input: Parameters<
          ConstructorParameters<typeof PackageLifecycleDeliveryRecovery>[0]["reconcileExisting"]
        >[0],
      ) => ({ outcome: "MATCHED" as const, ...input }),
    );
    const consumer = new PackageLifecycleDeliveryRecovery({ reconcileExisting }, t.clock);
    await consumer.runOnce(t.scope.customer, op._id);
    await consumer.runOnce(t.scope.customer, op._id);
    expect(reconcileExisting).toHaveBeenCalledTimes(1);
    expect(reconcileExisting.mock.calls[0]?.[0].eventId).toBe("already-existing-offline-event");
    expect(
      (await PackageLifecycleOperationModel.findById(op._id))?.delivery?.[0]?.completionStage,
    ).toBe("EXISTING_EVENT_RECONCILED");
    expect(
      (await PackageLifecycleOperationModel.findById(op._id))?.delivery?.[0]?.externalDelivery,
    ).toBe("NOT_ATTESTED");
    expect((await PackageLifecycleOperationModel.findById(op._id))?.delivery?.[0]?.state).toBe(
      "DONE",
    );
  });
  it("S5F1 missing existing Calendar id stays blocked without dispatch while committed owner email is durable", async () => {
    const t = await fixture();
    const request = t.intent("COMPLETE", { bookingId: t.first._id });
    await t.business(request);
    const op = await PackageLifecycleOperationModel.findOne({ "intent.key": request.key }).orFail();
    const reconcileExisting = vi.fn(async () => ({ outcome: "UNAVAILABLE" as const }));
    await new PackageLifecycleDeliveryRecovery({ reconcileExisting }, t.clock).runOnce(
      t.scope.customer,
      op._id,
    );
    expect(reconcileExisting).not.toHaveBeenCalled();
    expect((await PackageLifecycleOperationModel.findById(op._id))?.delivery?.[0]?.state).toBe(
      "BLOCKED_UNVERIFIED",
    );
    expect((await PackageLifecycleOperationModel.findById(op._id))?.delivery?.[1]?.state).toBe(
      "DONE",
    );
    expect(
      await EmailOutboxModel.exists({
        eventKey: `PACKAGE_LIFECYCLE:${request.key}`,
        recipient: "owner@s5.test",
      }),
    ).toBeTruthy();
  });
  it("S5F1 lease recovery rejects stale tokens and stale lifecycle work skips without Calendar calls", async () => {
    const t = await fixture();
    await BookingModel.updateOne(
      { _id: t.first._id },
      { $set: { googleCalendarEventId: "existing-event" } },
    );
    const request = t.intent("RESCHEDULE", {
      bookingId: t.first._id,
      startAt: new Date(t.first.schedule.startAt.getTime() + 86400000),
    });
    await t.customer(request);
    const op = await PackageLifecycleOperationModel.findOne({ "intent.key": request.key }).orFail(),
      ops = new PackageLifecycleOperations();
    const a = must(await ops.claimDelivery(op._id, op.intent, 0, t.clock()));
    const later = new Date(t.clock().getTime() + 60001);
    const b = must(await ops.claimDelivery(op._id, op.intent, 0, later));
    expect(await ops.settleDelivery(op._id, 0, a.token, "DONE", later)).toBe(false);
    expect(await ops.settleDelivery(op._id, 0, b.token, "RETRY", later)).toBe(true);
    await t.customer(t.intent("CANCEL", { bookingId: t.first._id }));
    const reconcileExisting = vi.fn(async () => ({ outcome: "UNAVAILABLE" as const }));
    await new PackageLifecycleDeliveryRecovery(
      { reconcileExisting },
      () => new Date(later.getTime() + 60001),
    ).runOnce(t.scope.customer, op._id);
    expect(reconcileExisting).not.toHaveBeenCalled();
    expect((await PackageLifecycleOperationModel.findById(op._id))?.delivery?.[0]?.state).toBe(
      "SKIPPED",
    );
  });

  it("S5F1 pending authentication holds lifetime budget; original attempt resumes without a second provider object", async () => {
    const t = await fixture({
      first: true,
      policy: true,
      categoryWindow: true,
      latePercentage: 50,
      bundlePriceCents: 1000,
    });
    t.advance(new Date(t.first.schedule.startAt.getTime() - 60000));
    t.gateway.queueNextChargeOutcome("requires_action");
    const req = t.intent("CANCEL", { bookingId: t.first._id });
    await expect(t.moneyLifecycle.customer(t.scope.customer, req)).rejects.toThrow();
    const attempt = await PaymentAttemptModel.findOne({
      purpose: "PACKAGE_LIFECYCLE_MONEY",
    }).orFail();
    expect(attempt.providerStatus).toBe("REQUIRES_ACTION");
    expect(
      (await PackageLifecycleOperationModel.findOne({ "intent.key": req.key }))?.assessment.state,
    ).toBe("RESERVED");
    await expect(t.business(t.intent("CANCEL", { bookingId: t.first._id }))).rejects.toThrow();
    t.gateway.succeedPaymentIntent(must(attempt.providerPaymentIntentId));
    expect((await t.moneyLifecycle.customer(t.scope.customer, req))?.booking?.status).toBe(
      "LATE_CANCELLATION",
    );
    expect(t.gateway.paymentIntentInputs).toHaveLength(2);
  });
  it("S5F1 lost provider response preserves budget and recovers the same PaymentAttempt/PI", async () => {
    const t = await fixture({
      first: true,
      policy: true,
      categoryWindow: true,
      latePercentage: 50,
      bundlePriceCents: 1000,
    });
    t.advance(new Date(t.first.schedule.startAt.getTime() - 60000));
    const req = t.intent("CANCEL", { bookingId: t.first._id });
    t.gateway.queueNextChargeLostResponse();
    await expect(t.moneyLifecycle.customer(t.scope.customer, req)).rejects.toThrow();
    const attempt = await PaymentAttemptModel.findOne({
      purpose: "PACKAGE_LIFECYCLE_MONEY",
    }).orFail();
    expect(attempt.providerStatus).toBe("UNKNOWN");
    const result = await t.moneyLifecycle.customer(t.scope.customer, req);
    expect(String(result?.result.money?.attemptId)).toBe(String(attempt._id));
    expect(t.gateway.paymentIntentInputs).toHaveLength(2);
    expect(t.gateway.refundInputs).toHaveLength(0);
  });
  it("S5F1 definitive provider cancellation releases reserved allowance, never a failed/requires_action guess", async () => {
    const t = await fixture({
      first: true,
      policy: true,
      categoryWindow: true,
      latePercentage: 50,
      bundlePriceCents: 1000,
    });
    t.advance(new Date(t.first.schedule.startAt.getTime() - 60000));
    const req = t.intent("CANCEL", { bookingId: t.first._id });
    t.gateway.queueNextChargeOutcome("requires_action");
    await expect(t.moneyLifecycle.customer(t.scope.customer, req)).rejects.toThrow();
    const attempt = await PaymentAttemptModel.findOne({
      purpose: "PACKAGE_LIFECYCLE_MONEY",
    }).orFail();
    await expect(
      new PackageLifecycleOperations().releaseUncollected(attempt._id),
    ).rejects.toThrow();
    t.gateway.setPaymentIntentStatus(must(attempt.providerPaymentIntentId), "canceled");
    await expect(t.moneyLifecycle.customer(t.scope.customer, req)).rejects.toThrow();
    const op = await PackageLifecycleOperationModel.findOne({ "intent.key": req.key }).orFail();
    expect(op.phase).toBe("FAILED_FINAL");
    expect(op.assessment.state).toBe("RELEASED");
    expect((await BookingModel.findById(t.first._id))?.status).toBe("UPCOMING");
    const fresh = await t.moneyLifecycle.customer(
      t.scope.customer,
      t.intent("CANCEL", { bookingId: t.first._id }),
    );
    expect(fresh?.result.money?.amountCents).toBe(500);
  });
  it("S5F1 no-show reversal cannot coexist with a pending positive capture reservation", async () => {
    const t = await fixture({
      first: true,
      policy: true,
      categoryWindow: true,
      bundlePriceCents: 1000,
    });
    const w = must(t.first.noShowEligibilitySnapshot);
    t.advance(new Date(t.first.schedule.startAt.getTime() + w.opensAfterMinutes * 60000));
    const marked = await t.business(t.intent("MARK_NO_SHOW", { bookingId: t.first._id }));
    t.advance(must(marked?.booking?.noShowDeadlineAt));
    const req = t.intent("NO_SHOW", { bookingId: t.first._id });
    t.gateway.queueNextChargeOutcome("requires_action");
    await expect(
      t.moneyLifecycle.business(
        t.f.business.ownerUserId,
        "BUSINESS_OWNER",
        t.f.context.customerUserId,
        req,
      ),
    ).rejects.toThrow();
    await expect(
      t.business(t.intent("REVERSE_NO_SHOW", { bookingId: t.first._id })),
    ).rejects.toThrow();
    const attempt = await PaymentAttemptModel.findOne({
      purpose: "PACKAGE_LIFECYCLE_MONEY",
    }).orFail();
    t.gateway.succeedPaymentIntent(must(attempt.providerPaymentIntentId));
    const result = await t.moneyLifecycle.business(
      t.f.business.ownerUserId,
      "BUSINESS_OWNER",
      t.f.context.customerUserId,
      req,
    );
    expect(result?.booking?.status).toBe("NO_SHOW_CHARGED");
    await expect(
      t.business(t.intent("REVERSE_NO_SHOW", { bookingId: t.first._id })),
    ).rejects.toThrow();
  });
  it("S5F1 paid unknown callback abort is pinned: generic recovery cannot refund from an absent lifecycle winner", async () => {
    const t = await fixture({
      first: true,
      policy: true,
      categoryWindow: true,
      latePercentage: 50,
      bundlePriceCents: 1000,
    });
    t.advance(new Date(t.first.schedule.startAt.getTime() - 60000));
    const req = t.intent("CANCEL", { bookingId: t.first._id });
    vi.spyOn(PackageLifecycleOperations.prototype, "complete").mockRejectedValueOnce(
      Object.assign(Error("controlled unknown"), {
        errorLabels: ["UnknownTransactionCommitResult"],
      }),
    );
    await expect(t.moneyLifecycle.customer(t.scope.customer, req)).rejects.toThrow();
    const before = await PackageLifecycleOperationModel.findOne({ "intent.key": req.key }).orFail();
    expect(before.phase).toBe("PERSISTING");
    const attempt = await PaymentAttemptModel.findOne({
      purpose: "PACKAGE_LIFECYCLE_MONEY",
    }).orFail();
    await PaymentAttemptModel.updateOne(
      { _id: attempt._id },
      { $set: { persistenceLeaseExpiresAt: new Date(0) } },
    );
    expect(await t.attempts.claimCompensation(attempt._id)).toBeNull();
    expect(await t.attempts.claimPersistence(attempt._id)).toBeNull();
    const recovery = new MoneyRecoveryService(
      t.payments,
      t.attempts,
      t.refunds,
      new BookingRepository(),
      new BookingFinancialTransactionService(new BookingFinancialTransactionRepository()),
      Object.assign(Object.create(null), { recoverDue: async () => ({ processed: 0, failed: 0 }) }),
    );
    await recovery.runOnce();
    await expect(t.moneyLifecycle.customer(t.scope.customer, req)).rejects.toThrow();
    expect(t.gateway.refundInputs).toHaveLength(0);
    expect(t.gateway.paymentIntentInputs).toHaveLength(2);
    expect((await PackageLifecycleOperationModel.findById(before._id))?.phase).toBe("PERSISTING");
    expect((await BookingModel.findById(t.first._id))?.status).toBe("UPCOMING");
  });
  it("S5F1 mismatched monetary token cannot complete or compensate a legitimate winner", async () => {
    const t = await fixture({
      first: true,
      policy: true,
      categoryWindow: true,
      latePercentage: 50,
      bundlePriceCents: 1000,
    });
    t.advance(new Date(t.first.schedule.startAt.getTime() - 60000));
    const result = await t.moneyLifecycle.customer(
      t.scope.customer,
      t.intent("CANCEL", { bookingId: t.first._id }),
    );
    const id = must(result?.result.money).attemptId;
    expect(await t.attempts.markCompensationRequired(id, "forged", "wrong-token")).toBe(false);
    const s = await mongoose.startSession();
    try {
      await s.withTransaction(async () => {
        expect(await completeLifecyclePaymentAttempt(id, "wrong-token", s)).toBe(false);
      });
    } finally {
      await s.endSession();
    }
    expect((await PaymentAttemptModel.findById(id))?.persistenceStatus).toBe("COMPLETED");
  });
  it("S5F1 two online redemptions for the final Remaining credit have one winner and compensate the paid loser", async () => {
    const t = await fixture({ addon: true, first: true, bundlePriceCents: 0 });
    await t.business(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const addonId = must(t.first.serviceLines[0]?.addons[0]).addonId;
    const remaining = must(t.progress.items[0]).remainingSessions;
    for (let i = 0; i < remaining - 1; i++)
      await t.customer({
        ...t.redeem(),
        startAt: new Date(t.first.schedule.startAt.getTime() + (i + 1) * 86400000),
      });
    const requests = [5, 6].map((day) => ({
      ...t.redeem(),
      startAt: new Date(t.first.schedule.startAt.getTime() + day * 86400000),
      dues: { addonIds: [addonId], paymentMethod: "ONLINE" as const },
    }));
    for (const request of requests) await (await t.sessionOffer(request)).accept();
    const results = await Promise.allSettled(
      requests.map((r) => t.moneyLifecycle.customer(t.scope.customer, r)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (await PackageProgressV2Model.findById(t.progress._id))?.items[0]?.remainingSessions,
    ).toBe(0);
    expect(t.gateway.paymentIntentInputs).toHaveLength(2);
    expect(t.gateway.refundInputs).toHaveLength(1);
    expect(
      await BookingFinancialTransactionModel.countDocuments({
        type: "PAYMENT",
        "metadata.independentPackagePenalty": false,
      }),
    ).toBe(1);
  });
  it("S5F1 unauthorized Staff and foreign Owner cannot attest venue payment", async () => {
    const t = await fixture({ bundlePriceCents: 1000 });
    const staff = must(t.f.providers[0]);
    await expect(
      t.lifecycle.business(
        staff.userId,
        "SUPERVISOR",
        t.f.context.customerUserId,
        t.intent("VENUE_SETTLEMENT", {
          bookingId: t.first._id,
          venuePayment: { settlement: "FULL" },
        }),
      ),
    ).rejects.toThrow();
    const foreign = await UserModel.create({
      normalizedEmail: "foreign-owner@s5f1.test",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      passwordHash: "unused",
      security: { passwordUpdatedAt: INTERNAL_TIME },
    });
    await expect(
      t.lifecycle.business(
        foreign._id,
        "BUSINESS_OWNER",
        t.f.context.customerUserId,
        t.intent("VENUE_SETTLEMENT", {
          bookingId: t.first._id,
          venuePayment: { settlement: "FULL" },
        }),
      ),
    ).rejects.toThrow();
    expect(await BookingFinancialTransactionModel.countDocuments({ type: "PAYMENT" })).toBe(0);
  });
  it("S5F1 actual employed Supervisor can attest venue payment; changed amount under same key rejects", async () => {
    const t = await fixture({ bundlePriceCents: 1000 });
    const user = await UserModel.create({
      normalizedEmail: "supervisor@s5f1.test",
      role: "SUPERVISOR",
      status: "ACTIVE",
      passwordHash: "unused",
      security: { passwordUpdatedAt: INTERNAL_TIME },
    });
    await StaffMembershipModel.create({
      userId: user._id,
      businessId: t.scope.businessId,
      role: "SUPERVISOR",
      employmentActive: true,
      createdByUserId: t.f.business.ownerUserId,
    });
    const req = t.intent("VENUE_SETTLEMENT", {
      bookingId: t.first._id,
      venuePayment: { settlement: "PARTIAL", amountCents: 200 },
    });
    await t.lifecycle.business(user._id, "SUPERVISOR", t.f.context.customerUserId, req);
    await expect(
      t.lifecycle.business(user._id, "SUPERVISOR", t.f.context.customerUserId, {
        ...req,
        venuePayment: { settlement: "PARTIAL", amountCents: 300 },
      }),
    ).rejects.toThrow();
    expect((await BookingModel.findById(t.first._id))?.completionPayment?.amountCents).toBe(200);
  });

  it("S5F1 foreign Customer JWT cannot assess, read or pay another Customer's penalty", async () => {
    const t = await fixture({
      first: true,
      policy: true,
      categoryWindow: true,
      latePercentage: 50,
      bundlePriceCents: 1000,
    });
    const foreign = await UserModel.create({
      normalizedEmail: "penalty-foreign@s5f1.test",
      role: "CUSTOMER",
      status: "ACTIVE",
      passwordHash: "unused",
      security: { passwordUpdatedAt: INTERNAL_TIME },
    });
    const capability = await t.authority.authenticate(
      `Bearer ${await issueTestAccessToken(t.tokens, { userId: foreign._id, role: "CUSTOMER" })}`,
    );
    t.advance(new Date(t.first.schedule.startAt.getTime() - 60000));
    await expect(
      t.moneyLifecycle.customer(capability, t.intent("CANCEL", { bookingId: t.first._id })),
    ).rejects.toThrow();
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
    expect(
      await PackageLifecycleOperationModel.countDocuments({ assessment: { $exists: true } }),
    ).toBe(0);
  });
  it("S5F1 positive Group cancellation releases precisely its one applied seat and never repeats", async () => {
    const t = await fixture({
      group: true,
      first: true,
      policy: true,
      categoryWindow: true,
      latePercentage: 50,
      bundlePriceCents: 1000,
    });
    const line = must(t.first.serviceLines[0]),
      key = must(line.reservationOperationKey);
    t.advance(new Date(t.first.schedule.startAt.getTime() - 60000));
    const request = t.intent("CANCEL", { bookingId: t.first._id });
    await t.moneyLifecycle.customer(t.scope.customer, request);
    expect(
      (await BookingSlotReservationClaimModel.findOne({ idempotencyKey: key }))?.effect?.state,
    ).toBe("RELEASED");
    const before = await BookingSlotReservationModel.find().lean();
    await t.moneyLifecycle.customer(t.scope.customer, request);
    expect(await BookingSlotReservationModel.find().lean()).toEqual(before);
    expect(t.gateway.paymentIntentInputs).toHaveLength(2);
  });
  it("S5F1 abort after real positive Group release restores the old seat, Booking and credit before exact refund", async () => {
    const t = await fixture({
      group: true,
      first: true,
      policy: true,
      categoryWindow: true,
      latePercentage: 50,
      bundlePriceCents: 1000,
    });
    t.advance(new Date(t.first.schedule.startAt.getTime() - 60000));
    const before = await BookingSlotReservationModel.find().lean();
    const original = t.reservations.release.bind(t.reservations);
    vi.spyOn(t.reservations, "release").mockImplementationOnce(async (...a) => {
      await original(...a);
      throw Error("after actual Group release");
    });
    await expect(
      t.moneyLifecycle.customer(t.scope.customer, t.intent("CANCEL", { bookingId: t.first._id })),
    ).rejects.toThrow("after actual Group release");
    expect(await BookingSlotReservationModel.find().lean()).toEqual(before);
    expect((await BookingModel.findById(t.first._id))?.status).toBe("UPCOMING");
    expect(
      (await PackageProgressV2Model.findById(t.progress._id))?.sessions.find((a) =>
        a.bookingId.equals(t.first._id),
      )?.status,
    ).toBe("SCHEDULED");
    expect(t.gateway.refundInputs).toHaveLength(1);
  });
  it("S5F1 abort after monetary attempt completion rolls back the entire paid redemption parent", async () => {
    const t = await fixture({ addon: true, first: true, bundlePriceCents: 0 });
    await t.business(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const request = {
      ...t.redeem(),
      dues: {
        addonIds: [must(t.first.serviceLines[0]?.addons[0]).addonId],
        paymentMethod: "ONLINE" as const,
      },
    };
    await (await t.sessionOffer(request)).accept();
    const original = lifecyclePaymentModel.completeLifecyclePaymentAttempt;
    vi.spyOn(lifecyclePaymentModel, "completeLifecyclePaymentAttempt").mockImplementationOnce(
      async (...a) => {
        expect(await original(...a)).toBe(true);
        throw Error("after completed monetary CAS");
      },
    );
    await expect(t.moneyLifecycle.customer(t.scope.customer, request)).rejects.toThrow(
      "after completed monetary CAS",
    );
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
    expect(
      (await PackageProgressV2Model.findById(t.progress._id))?.items[0]?.remainingSessions,
    ).toBe(t.progress.items[0]?.remainingSessions);
    expect(
      await BookingFinancialTransactionModel.countDocuments({
        "metadata.independentPackagePenalty": false,
      }),
    ).toBe(0);
    expect(
      (await PackageLifecycleOperationModel.findOne({ "intent.key": request.key }))?.result,
    ).toBeUndefined();
    expect(t.gateway.refundInputs).toHaveLength(1);
  });
  it("S5F1 real paid redemption commit with lost application return recovers exact owned monetary result", async () => {
    const t = await fixture({ addon: true, first: true, bundlePriceCents: 0 });
    await t.business(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const request = {
      ...t.redeem(),
      dues: {
        addonIds: [must(t.first.serviceLines[0]?.addons[0]).addonId],
        paymentMethod: "ONLINE" as const,
      },
    };
    await (await t.sessionOffer(request)).accept();
    const original = mongoose.startSession.bind(mongoose);
    vi.spyOn(mongoose, "startSession").mockImplementationOnce(async (...a) => {
      const session = await original(...a),
        tx = session.withTransaction.bind(session);
      session.withTransaction = async (...b) => {
        await tx(...b);
        throw Error("controlled paid lost return");
      };
      return session;
    });
    const result = await t.moneyLifecycle.customer(t.scope.customer, request);
    expect(result?.result.money?.amountCents).toBe(500);
    expect(t.gateway.refundInputs).toHaveLength(0);
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
    expect(
      (await t.moneyLifecycle.customer(t.scope.customer, request))?.result.money?.attemptId,
    ).toEqual(result?.result.money?.attemptId);
  });
  it("S5F1 actual server112 paid callback retry keeps retained Booking, PaymentAttempt and one provider call", async () => {
    const t = await fixture({ addon: true, first: true, bundlePriceCents: 0 });
    await t.business(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const request = {
      ...t.redeem(),
      dues: {
        addonIds: [must(t.first.serviceLines[0]?.addons[0]).addonId],
        paymentMethod: "ONLINE" as const,
      },
    };
    const offer = await t.sessionOffer(request);
    await offer.accept();
    let release = () => {},
      entered = () => {},
      tries = 0;
    const hold = new Promise<void>((r) => {
        release = r;
      }),
      reached = new Promise<void>((r) => {
        entered = r;
      });
    const codes: number[] = [],
      original = eligibility.acquirePackageEligibilityFence;
    vi.spyOn(eligibility, "acquirePackageEligibilityFence").mockImplementation(async (...a) => {
      if (++tries === 1) {
        await BusinessModel.findById(t.scope.businessId).session(a[1]);
        entered();
        await hold;
      }
      try {
        return await original(...a);
      } catch (e) {
        if (e && typeof e === "object" && "code" in e && typeof e.code === "number")
          codes.push(e.code);
        throw e;
      }
    });
    const pending = t.moneyLifecycle.customer(t.scope.customer, request);
    await reached;
    try {
      await t.hours.replace(
        t.scope.businessId,
        (
          ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const
        ).map((dayOfWeek) => ({
          dayOfWeek,
          isOpen: true,
          slots: [{ startTime: "09:00", endTime: "18:00" }],
        })),
      );
    } finally {
      release();
    }
    const result = await pending;
    expect(codes).toContain(112);
    serverCodes.push(...codes);
    expect(String(result?.booking?._id)).toBe(String(offer.quote.terms.bookingId));
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
    expect(
      (await PaymentAttemptModel.findById(result?.result.money?.attemptId))?.persistenceStatus,
    ).toBe("COMPLETED");
  }, 30000);
  it("S5F1 actual paid retained Booking11000 aborts without false replay and compensates its separate payment", async () => {
    const t = await fixture({ addon: true, first: true, bundlePriceCents: 0 });
    await t.business(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const request = {
      ...t.redeem(),
      dues: {
        addonIds: [must(t.first.serviceLines[0]?.addons[0]).addonId],
        paymentMethod: "ONLINE" as const,
      },
    };
    const offer = await t.sessionOffer(request);
    await offer.accept();
    const original = PackageLifecycleOperations.prototype.claim;
    vi.spyOn(PackageLifecycleOperations.prototype, "claim").mockImplementationOnce(async function (
      this: PackageLifecycleOperations,
      ...a
    ) {
      const row = await original.apply(this, a);
      await BookingModel.collection.insertOne({
        ...t.first,
        _id: offer.quote.terms.bookingId,
        reference: `COLLISION-${offer.quote.terms.bookingId}`,
      });
      return row;
    });
    const error = await t.moneyLifecycle.customer(t.scope.customer, request).then(
      () => null,
      (e) => e,
    );
    expect(error.code).toBe(11000);
    serverCodes.push(error.code);
    expect(
      (await PackageProgressV2Model.findById(t.progress._id))?.sessions.some((a) =>
        a.bookingId.equals(offer.quote.terms.bookingId),
      ),
    ).toBe(false);
    expect(t.gateway.refundInputs).toHaveLength(1);
    expect(
      await BookingFinancialTransactionModel.countDocuments({
        "metadata.independentPackagePenalty": false,
      }),
    ).toBe(0);
  });
  it("S5F1 city outside purchased rights or inactive live coverage cannot be accepted", async () => {
    const t = await fixture({ travel: true });
    await t.business(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const { location: _location, ...address } = must(t.first.fulfilment.travelAddress);
    const wrongCity = address.city === "Nicosia" ? ("Limassol" as const) : ("Nicosia" as const);
    await expect(
      t.sessionOffer({
        ...t.redeem(),
        dues: {
          addonIds: [],
          paymentMethod: "VENUE",
          travelAddress: { ...address, city: wrongCity },
        },
      }),
    ).rejects.toThrow();
    await BusinessTravelSettingsModel.updateOne(
      { businessId: t.scope.businessId },
      { $set: { "cities.$[].active": false } },
    );
    await expect(
      t.sessionOffer({
        ...t.redeem(),
        dues: { addonIds: [], paymentMethod: "VENUE", travelAddress: address },
      }),
    ).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
  });
  it("S5F1 missing Owner recipient stays blocked while Customer outbox and purchase remain complete", async () => {
    const t = await fixture();
    await UserModel.deleteOne({ _id: t.f.business.ownerUserId });
    const req = t.redeem(),
      result = await t.customer(req);
    const op = await PackageLifecycleOperationModel.findOne({ "intent.key": req.key }).orFail();
    expect(op.delivery?.find((d) => d.index === 1)?.state).toBe("BLOCKED_UNVERIFIED");
    expect(result?.result.emails).toHaveLength(1);
    expect(await readOwnedPackageBatchCompletion(t.scope)).toBeTruthy();
  });
  it("S5F1 webhook records verified lifecycle provider facts without origin-only purchase completion or FIRST work", async () => {
    const t = await fixture({
      first: true,
      policy: true,
      categoryWindow: true,
      latePercentage: 50,
      bundlePriceCents: 1000,
    });
    t.advance(new Date(t.first.schedule.startAt.getTime() - 60000));
    t.gateway.queueNextChargeOutcome("requires_action");
    const req = t.intent("CANCEL", { bookingId: t.first._id });
    await expect(t.moneyLifecycle.customer(t.scope.customer, req)).rejects.toThrow();
    const attempt = await PaymentAttemptModel.findOne({
        purpose: "PACKAGE_LIFECYCLE_MONEY",
      }).orFail(),
      pi = must(attempt.providerPaymentIntentId);
    t.gateway.succeedPaymentIntent(pi);
    const snapshot = await t.gateway.retrievePaymentIntent(pi);
    const event = {
      id: `evt_lifecycle_${attempt._id}`,
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: pi,
          object: "payment_intent",
          amount: snapshot.amountCents,
          currency: "eur",
          customer: attempt.providerCustomerId,
          metadata: snapshot.metadata,
          status: "succeeded",
        },
      },
    } as unknown as Stripe.Event;
    const webhook = new StripeWebhookService(
      t.gateway,
      new StripeWebhookEventRepository(),
      new BookingFinancialTransactionService(new BookingFinancialTransactionRepository()),
      undefined,
      t.attempts,
      t.refunds,
    );
    expect(await webhook.process(event)).toBe(true);
    expect((await PaymentAttemptModel.findById(attempt._id))?.providerStatus).toBe("SUCCEEDED");
    expect((await PaymentAttemptModel.findById(attempt._id))?.persistenceStatus).toBe(
      "NOT_STARTED",
    );
    expect((await BookingModel.findById(t.first._id))?.status).toBe("UPCOMING");
    expect(
      await BookingFinancialTransactionModel.countDocuments({ type: "CANCELLATION_FEE" }),
    ).toBe(0);
    expect(
      (await t.moneyLifecycle.customer(t.scope.customer, req))?.result.money?.amountCents,
    ).toBe(500);
  });

  it("S5F1 independent basis5000 is capped2500 per appointment and5000 across the sold bundle10000", async () => {
    const t = await fixture({
      count: 3,
      first: true,
      policy: true,
      categoryWindow: true,
      latePercentage: 100,
      penaltyBasisCents: 5000,
      bundlePriceCents: 10000,
    });
    t.advance(
      new Date(Math.max(...t.full.bookings.map((b) => b.schedule.startAt.getTime())) - 60000),
    );
    const amounts: number[] = [];
    for (const booking of t.full.bookings)
      amounts.push(
        (
          await t.moneyLifecycle.customer(
            t.scope.customer,
            t.intent("CANCEL", { bookingId: booking._id }),
          )
        )?.result.money?.amountCents ?? 0,
      );
    expect(amounts).toEqual([2500, 2500, 0]);
    expect(t.gateway.paymentIntentInputs).toHaveLength(3);
    expect(
      (await PackageLifecycleOperationModel.find({ assessment: { $exists: true } })).reduce(
        (sum, o) => sum + o.assessment.amountCents,
        0,
      ),
    ).toBe(5000);
  });
  it("S5F1 a refunded succeeded assessment never replenishes lifetime allowance or tops up a sibling", async () => {
    const t = await fixture({
      first: true,
      policy: true,
      categoryWindow: true,
      latePercentage: 50,
      bundlePriceCents: 1000,
    });
    t.advance(
      new Date(Math.max(...t.full.bookings.map((b) => b.schedule.startAt.getTime())) - 60000),
    );
    vi.spyOn(EmailOutboxRepository.prototype, "enqueue").mockRejectedValueOnce(
      Error("definite paid abort"),
    );
    await expect(
      t.moneyLifecycle.customer(t.scope.customer, t.intent("CANCEL", { bookingId: t.first._id })),
    ).rejects.toThrow();
    const other = must(t.full.bookings[1]),
      req = t.intent("CANCEL", { bookingId: other._id });
    const result = await t.moneyLifecycle.customer(t.scope.customer, req);
    expect(result?.result.money).toBeUndefined();
    expect(result?.booking?.status).toBe("LATE_CANCELLATION");
    expect(t.gateway.refundInputs).toHaveLength(1);
    expect(t.gateway.paymentIntentInputs).toHaveLength(2);
    expect(
      (await PackageLifecycleOperationModel.findOne({ "intent.bookingId": t.first._id }))
        ?.assessment.state,
    ).toBe("CAPTURED");
    await t.moneyLifecycle.customer(t.scope.customer, req);
    expect(t.gateway.paymentIntentInputs).toHaveLength(2);
  });
  it("S5F1 ambiguous no-provider response is never recreated or freed from absence", async () => {
    const t = await fixture({
      first: true,
      policy: true,
      categoryWindow: true,
      latePercentage: 50,
      bundlePriceCents: 1000,
    });
    t.advance(new Date(t.first.schedule.startAt.getTime() - 60000));
    const req = t.intent("CANCEL", { bookingId: t.first._id });
    t.gateway.queueNextChargeThrowBeforeCreate();
    await expect(t.moneyLifecycle.customer(t.scope.customer, req)).rejects.toThrow();
    const original = await PaymentAttemptModel.findOne({
      purpose: "PACKAGE_LIFECYCLE_MONEY",
    }).orFail();
    await expect(t.moneyLifecycle.customer(t.scope.customer, req)).rejects.toThrow();
    expect((await PaymentAttemptModel.findById(original._id))?.providerStatus).toBe("UNKNOWN");
    expect(
      (await PackageLifecycleOperationModel.findOne({ "intent.key": req.key }))?.assessment.state,
    ).toBe("RESERVED");
    expect((await BookingModel.findById(t.first._id))?.status).toBe("UPCOMING");
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
    expect(t.gateway.refundInputs).toHaveLength(0);
  });
  it("S5F1 online session authentication resumes its exact accepted original attempt", async () => {
    const t = await fixture({ first: true, addon: true, bundlePriceCents: 0 });
    await t.business(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const req = {
      ...t.redeem(),
      dues: {
        addonIds: [must(t.first.serviceLines[0]?.addons[0]).addonId],
        paymentMethod: "ONLINE" as const,
      },
    };
    await (await t.sessionOffer(req)).accept();
    t.gateway.queueNextChargeOutcome("requires_action");
    const pending = await t.moneyLifecycle.customer(t.scope.customer, req).then(
      () => null,
      (e) => e,
    );
    expect(pending.code).toBe("PACKAGE_LIFECYCLE_PAYMENT_PENDING");
    expect(pending.clientSecret).toBeTruthy();
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
    const attempt = await PaymentAttemptModel.findById(pending.paymentAttemptId).orFail();
    t.gateway.succeedPaymentIntent(must(attempt.providerPaymentIntentId));
    const result = await t.moneyLifecycle.customer(t.scope.customer, req);
    expect(result?.result.money?.attemptId).toEqual(attempt._id);
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
  });
  it("S5F1 paid reminder persistence failure aborts new Booking/credit/effects and refunds once", async () => {
    const t = await fixture({ first: true, addon: true, bundlePriceCents: 0, endReminder: true });
    await t.business(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const req = {
      ...t.redeem(),
      dues: {
        addonIds: [must(t.first.serviceLines[0]?.addons[0]).addonId],
        paymentMethod: "ONLINE" as const,
      },
    };
    await (await t.sessionOffer(req)).accept();
    const before = await AppointmentReminderModel.find().lean(),
      original = AppointmentReminderRepository.prototype.schedule;
    vi.spyOn(AppointmentReminderRepository.prototype, "schedule").mockImplementationOnce(
      async function (this: AppointmentReminderRepository, ...a) {
        await original.apply(this, a);
        throw Error("after actual paid reminder persistence");
      },
    );
    await expect(t.moneyLifecycle.customer(t.scope.customer, req)).rejects.toThrow(
      "after actual paid reminder persistence",
    );
    expect(await AppointmentReminderModel.find().lean()).toEqual(before);
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
    expect(
      (await PackageProgressV2Model.findById(t.progress._id))?.items[0]?.remainingSessions,
    ).toBe(t.progress.items[0]?.remainingSessions);
    expect(t.gateway.refundInputs).toHaveLength(1);
  });
  it("S5F1 generic PaymentAttempt binding deletion/completion cannot forge lifecycle proof", async () => {
    const t = await fixture({
      first: true,
      policy: true,
      categoryWindow: true,
      latePercentage: 50,
      bundlePriceCents: 1000,
    });
    t.advance(new Date(t.first.schedule.startAt.getTime() - 60000));
    const result = await t.moneyLifecycle.customer(
      t.scope.customer,
      t.intent("CANCEL", { bookingId: t.first._id }),
    );
    const id = must(result?.result.money).attemptId;
    await expect(
      PaymentAttemptModel.updateOne({ _id: id }, { $unset: { packageLifecycleBinding: "" } }),
    ).rejects.toThrow();
    expect(
      (
        await PaymentAttemptModel.updateOne(
          { _id: id },
          { $set: { persistenceStatus: "COMPLETED" } },
        )
      ).matchedCount,
    ).toBe(0);
    const row = await PaymentAttemptModel.findById(id).orFail();
    row.set("packageLifecycleBinding", undefined);
    await expect(row.save({ validateBeforeSave: false })).rejects.toThrow();
    await expect(row.deleteOne()).rejects.toThrow();
    expect((await PaymentAttemptModel.findById(id))?.packageLifecycleBinding).toBeTruthy();
    const operation = await PackageLifecycleOperationModel.findOne({
      "result.money.attemptId": id,
    }).orFail();
    await PackageLifecycleOperationModel.collection.updateOne(
      { _id: operation._id },
      { $set: { "assessment.basisCents": 5000 } },
    );
    await expect(t.moneyLifecycle.customer(t.scope.customer, operation.intent)).rejects.toThrow();
  });
  it("S5F1 accepted venue session replay remains read-only after cancellation and Add-on catalogue change", async () => {
    const t = await fixture({ addon: true });
    await t.business(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const addonId = must(t.first.serviceLines[0]?.addons[0]).addonId;
    const req = { ...t.redeem(), dues: { addonIds: [addonId], paymentMethod: "VENUE" as const } };
    const offer = await t.sessionOffer(req);
    await offer.accept();
    const result = await t.customer(req);
    await t.customer(t.intent("CANCEL", { bookingId: must(result?.booking)._id }));
    await AddonModel.updateOne({ _id: addonId }, { $set: { priceCents: 800, status: "INACTIVE" } });
    const before = await PackageLifecycleOperationModel.find().lean(),
      business = await BusinessModel.findById(t.scope.businessId).lean();
    expect((await t.customer(req))?.booking?.status).toBe("CANCELLED_BY_CUSTOMER");
    await offer.accept();
    expect(await PackageLifecycleOperationModel.find().lean()).toEqual(before);
    expect(await BusinessModel.findById(t.scope.businessId).lean()).toEqual(business);
  });
  it("S5F1 original purchased travel fee remains fixed when live city pricing changes after acceptance", async () => {
    const t = await fixture({ travel: true });
    await t.business(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const { location: _location, ...travelAddress } = must(t.first.fulfilment.travelAddress);
    const req = {
      ...t.redeem(),
      dues: { addonIds: [], paymentMethod: "VENUE" as const, travelAddress },
    };
    const offer = await t.sessionOffer(req);
    await offer.accept();
    await BusinessTravelSettingsModel.updateOne(
      { businessId: t.scope.businessId },
      { $set: { "cities.$[].feeCents": 9999 } },
    );
    const result = await t.customer(req);
    expect(result?.booking?.financials.travelFeeCents).toBe(offer.quote.terms.travelCents);
    expect(await readOwnedPackageBatchCompletion(t.scope)).toBeTruthy();
  });

  it("S5F1 unknown venue commit stays pinned and never duplicates settlement from missing proof", async () => {
    const t = await fixture({ bundlePriceCents: 1000 });
    vi.spyOn(PackageLifecycleOperations.prototype, "complete").mockRejectedValueOnce(
      Object.assign(Error("unknown venue"), { errorLabels: ["UnknownTransactionCommitResult"] }),
    );
    const req = t.intent("VENUE_SETTLEMENT", {
      bookingId: t.first._id,
      venuePayment: { settlement: "FULL" },
    });
    await expect(t.business(req)).rejects.toThrow();
    await expect(t.business(req)).rejects.toThrow();
    expect((await PackageLifecycleOperationModel.findOne({ "intent.key": req.key }))?.phase).toBe(
      "PERSISTING",
    );
    expect((await BookingModel.findById(t.first._id))?.completionPayment).toBeUndefined();
    expect(await BookingFinancialTransactionModel.countDocuments({ type: "PAYMENT" })).toBe(0);
  });
  it("S5F1 pending compensation refund resumes its original RefundOperation without restoring allowance", async () => {
    const t = await fixture({
      first: true,
      policy: true,
      categoryWindow: true,
      latePercentage: 50,
      bundlePriceCents: 1000,
    });
    t.advance(new Date(t.first.schedule.startAt.getTime() - 60000));
    t.gateway.queueNextRefundOutcome("pending");
    vi.spyOn(EmailOutboxRepository.prototype, "enqueue").mockRejectedValueOnce(
      Error("definite compensated abort"),
    );
    const req = t.intent("CANCEL", { bookingId: t.first._id });
    await expect(t.moneyLifecycle.customer(t.scope.customer, req)).rejects.toThrow();
    const refund = await RefundOperationModel.findOne().orFail();
    expect(refund.providerStatus).toBe("PROVIDER_PENDING");
    t.gateway.succeedRefund(must(refund.providerRefundId));
    const worker = new MoneyRecoveryService(
      t.payments,
      t.attempts,
      t.refunds,
      new BookingRepository(),
      new BookingFinancialTransactionService(new BookingFinancialTransactionRepository()),
      Object.assign(Object.create(null), { recoverDue: async () => ({ processed: 0, failed: 0 }) }),
    );
    await worker.runOnce();
    expect((await RefundOperationModel.findById(refund._id))?.providerStatus).toBe("SUCCEEDED");
    expect(
      (await PackageLifecycleOperationModel.findOne({ "intent.key": req.key }))?.assessment.state,
    ).toBe("CAPTURED");
    expect(t.gateway.refundInputs).toHaveLength(1);
    expect(t.gateway.paymentIntentInputs).toHaveLength(2);
  });
  it("S5F1 two paid Group redemptions compete for the final seat: one complete winner, one exact refund", async () => {
    const t = await fixture({ group: true, addon: true, first: true, bundlePriceCents: 0 });
    await t.business(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const line = must(t.first.serviceLines[0]),
      req = t.redeem(),
      startAt = must(req.startAt);
    const duration = must(line.schedulingSnapshot).occupiedDurationMin * 60000;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await t.reservations.reserveOrJoin(
          {
            businessId: t.scope.businessId,
            serviceId: line.serviceId,
            staffMembershipId: line.responsibleStaffMembershipId,
            timezone: t.first.schedule.timezone,
            startAt,
            endAt: new Date(startAt.getTime() + duration),
            partySize: 2,
            capacityMax: 3,
            idempotencyKey: "s5f1-unrelated-party-two",
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    const requests = [1, 2].map(() => ({
      ...t.redeem(),
      dues: { addonIds: [must(line.addons[0]).addonId], paymentMethod: "ONLINE" as const },
    }));
    for (const r of requests) await (await t.sessionOffer(r)).accept();
    const results = await Promise.allSettled(
      requests.map((r) => t.moneyLifecycle.customer(t.scope.customer, r)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(t.gateway.paymentIntentInputs).toHaveLength(2);
    expect(t.gateway.refundInputs).toHaveLength(1);
    const effects = await BookingSlotReservationClaimModel.find({
      idempotencyKey: {
        $in: (await PackageLifecycleOperationModel.find({ "intent.action": "REDEEM" })).map(
          (o) => `bookly:package-redemption:v1:${t.scope.businessId}:${o.bookingId}`,
        ),
      },
    });
    expect(effects).toHaveLength(1);
    expect(effects[0]?.effect?.state).toBe("APPLIED");
    expect(
      (await PackageProgressV2Model.findById(t.progress._id))?.items[0]?.remainingSessions,
    ).toBe(must(t.progress.items[0]).remainingSessions - 1);
  });
  it("S5F1 Calendar response failure leaves purchase and credits intact while another receipt progresses", async () => {
    const t = await fixture();
    const ops: Types.ObjectId[] = [];
    for (const booking of t.full.bookings) {
      await BookingModel.updateOne(
        { _id: booking._id },
        { $set: { googleCalendarEventId: `existing-${booking._id}` } },
      );
      const req = t.intent("RESCHEDULE", {
        bookingId: booking._id,
        startAt: new Date(booking.schedule.startAt.getTime() + 86400000),
      });
      await t.customer(req);
      ops.push(
        (await PackageLifecycleOperationModel.findOne({ "intent.key": req.key }).orFail())._id,
      );
    }
    const before = await PackageProgressV2Model.findById(t.progress._id).lean();
    let calls = 0;
    const consumer = new PackageLifecycleDeliveryRecovery(
      {
        reconcileExisting: async (input) => {
          if (++calls === 1) throw Error("lost fake reconcile response");
          return { outcome: "MATCHED", ...input };
        },
      },
      t.clock,
    );
    for (const id of ops) await consumer.runOnce(t.scope.customer, id);
    expect((await PackageLifecycleOperationModel.findById(ops[0]))?.delivery?.[0]?.state).toBe(
      "RETRY",
    );
    expect((await PackageLifecycleOperationModel.findById(ops[1]))?.delivery?.[0]?.state).toBe(
      "DONE",
    );
    expect(await PackageProgressV2Model.findById(t.progress._id).lean()).toEqual(before);
    expect(t.gateway.refundInputs).toHaveLength(0);
  });
  it("S5F1 compensated assessment retains its original appointment facts through a later legitimate move", async () => {
    const t = await fixture({
      first: true,
      policy: true,
      categoryWindow: true,
      latePercentage: 50,
      bundlePriceCents: 1000,
    });
    t.advance(new Date(t.first.schedule.startAt.getTime() - 60000));
    t.gateway.queueNextRefundOutcome("pending");
    vi.spyOn(EmailOutboxRepository.prototype, "enqueue").mockRejectedValueOnce(
      Error("known penalty abort before delivery"),
    );
    const failed = t.intent("CANCEL", { bookingId: t.first._id });
    await expect(t.moneyLifecycle.customer(t.scope.customer, failed)).rejects.toThrow();
    await t.customer(
      t.intent("RESCHEDULE", {
        bookingId: t.first._id,
        startAt: new Date(t.first.schedule.startAt.getTime() + 86400000),
      }),
    );
    const refund = await RefundOperationModel.findOne().orFail();
    t.gateway.succeedRefund(must(refund.providerRefundId));
    await new MoneyRecoveryService(
      t.payments,
      t.attempts,
      t.refunds,
      new BookingRepository(),
      new BookingFinancialTransactionService(new BookingFinancialTransactionRepository()),
      Object.assign(Object.create(null), { recoverDue: async () => ({ processed: 0, failed: 0 }) }),
    ).runOnce();
    expect((await RefundOperationModel.findById(refund._id))?.providerStatus).toBe("SUCCEEDED");
    expect(
      (await PackageLifecycleOperationModel.findOne({ "intent.key": failed.key }))?.assessment
        .bookingStartAt,
    ).toEqual(t.first.schedule.startAt);
    expect(t.gateway.refundInputs).toHaveLength(1);
    expect(await readOwnedPackageBatchCompletion(t.scope)).toBeTruthy();
  });
});

// P2D reuses the S5 fixtures, real domain, session-bound Customer authority, C1, payment
// fake and replica-set helper. The file's existing authority mock is the only gate opening.
describe("P2D actual lifecycle HTTP composition on synthetic purchases", () => {
  beforeAll(connectIsolatedDatabase, 120000);
  beforeEach(clearIsolatedDatabase);
  afterEach(() => vi.restoreAllMocks());
  afterAll(stopIsolatedReplicaSet);
  async function surface(t: Awaited<ReturnType<typeof fixture>>) {
    // Engineering transport fixtures deliberately substitute ONLY the public ownership
    // boundary, retaining full internal F2 verification. This does not certify production
    // consent. The P2A/P3B suites separately exercise the real rejecting boundary.
    vi.spyOn(purchaseAuthority, "verifyPackagePurchaseClaimCompletion").mockImplementation(
      async (claim, session) => {
        return verifyBatchCompletion(claim, session);
      },
    );
    const services = {
      authority: t.authority,
      tokens: t.tokens,
      users: new UserRepository(),
      staff: new StaffRepository(),
      management: t.booking,
      lifecycle: t.moneyLifecycle,
      operations: new PackageLifecycleOperations(),
      availability: t.availability,
    } as unknown as PackageLifecycleHttpServices;
    const app = express();
    app.use(express.json());
    app.use(
      createAuthenticateAccessTokenMiddleware(t.tokens, new UserRepository()),
      requireActiveUser(),
    );
    app.post(
      "/package-views/actions/:action",
      asyncHandler(new PackageLifecycleHttpController(services, t.clock).execute),
    );
    app.use(createErrorHandler({ isProduction: true }));
    const post = (action: string, body: object, authorization = t.authorization) =>
      httpRequest(app)
        .post(`/package-views/actions/${action}`)
        .set("Authorization", authorization)
        .send(body);
    const body = (input: ReturnType<typeof t.intent>) => {
      const { action: _action, businessClientId: _client, ...wire } = input;
      return wire;
    };
    const owner = `Bearer ${await issueTestAccessToken(t.tokens, { userId: t.f.business.ownerUserId, role: "BUSINESS_OWNER" })}`;
    return { post, body, owner };
  }
  it("redeems, replays, reschedules and cancels through the real service with one credit effect", async () => {
    const t = await fixture(),
      h = await surface(t),
      redeem = h.body(t.redeem());
    const first = await h.post("redeem", redeem).expect(200);
    const replay = await h.post("redeem", redeem).expect(200);
    expect(replay.body.data.bookingId).toBe(first.body.data.bookingId);
    const bookingId = new Types.ObjectId(first.body.data.bookingId);
    await h
      .post(
        "reschedule",
        h.body(
          t.intent("RESCHEDULE", {
            bookingId,
            startAt: new Date(t.first.schedule.startAt.getTime() + 3 * 86400000),
          }),
        ),
      )
      .expect(200);
    const cancel = h.body(t.intent("CANCEL", { bookingId }));
    await h.post("cancel", cancel).expect(200);
    await h.post("cancel", cancel).expect(200);
    expect(
      (await PackageProgressV2Model.findById(t.progress._id))?.items[0]?.remainingSessions,
    ).toBe(t.progress.items[0]?.remainingSessions);
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length + 1);
  });
  it("ordinary HTTP completion rejects a First-Class member with authority open and no effects", async () => {
    // This suite explicitly mocks activation open above. Shipped 503 coverage stays separate.
    const t = await fixture({ bundlePriceCents: 1000 }),
      h = await surface(t);
    // Exercise the real narrow Calendar projection, not only the DTO on a full Booking.
    const summaries = await new BookingRepository().findManyForCalendar(
      t.scope.businessId,
      new Date(t.first.schedule.startAt.getTime() - 1),
      new Date(t.first.schedule.startAt.getTime() + 1),
    );
    expect(
      summaries.map(toBookingCalendarEntryDto).find((row) => row.id === String(t.first._id))
        ?.firstClassPackage,
    ).toBe(true);
    const effects = async () => ({
      bookings: await BookingModel.find().sort({ _id: 1 }).lean(),
      progress: await PackageProgressV2Model.findById(t.progress._id).lean(),
      operations: await PackageLifecycleOperationModel.find().sort({ _id: 1 }).lean(),
      ledger: await BookingFinancialTransactionModel.find().sort({ _id: 1 }).lean(),
      emails: await EmailOutboxModel.find().sort({ _id: 1 }).lean(),
      reminders: await AppointmentReminderModel.find().sort({ _id: 1 }).lean(),
      reservations: await BookingSlotReservationModel.find().sort({ _id: 1 }).lean(),
      payments: await PaymentAttemptModel.find().sort({ _id: 1 }).lean(),
      refunds: await RefundOperationModel.find().sort({ _id: 1 }).lean(),
    });
    const before = await effects();
    const cas = vi.fn(() => {
      throw Error("ordinary status writer reached");
    });
    const ordinary: BookingLifecycleService = Object.assign(
      Object.create(BookingLifecycleService.prototype),
      {
        bookingService: t.booking,
        bookingRepository: {
          findById: new BookingRepository().findById.bind(new BookingRepository()),
          casUpdate: cas,
        },
      },
    );
    const controller = new BookingController(t.booking, {} as never, ordinary);
    const app = express();
    app.use(
      express.json(),
      createAuthenticateAccessTokenMiddleware(t.tokens, new UserRepository()),
      requireActiveUser(),
    );
    app.post(
      "/businesses/:businessId/bookings/:bookingId/complete",
      validateRequest({ params: bookingIdParamsSchema, body: completeBookingBodySchema }),
      asyncHandler(controller.completeBooking),
    );
    app.use(createErrorHandler({ isProduction: true }));
    const transaction = vi.spyOn(mongoose, "startSession");
    for (let i = 0; i < 2; i++) {
      const response = await httpRequest(app)
        .post(`/businesses/${t.scope.businessId}/bookings/${t.first._id}/complete`)
        .set("Authorization", h.owner)
        .send({ venuePayment: { settlement: "FULL" } })
        .expect(409);
      expect(JSON.stringify(response.body)).toContain("BOOKING_PACKAGE_LIFECYCLE_REQUIRED");
      expect(response.body.success).toBe(false);
    }
    await expect(
      ordinary.completeBooking(
        String(t.f.business.ownerUserId),
        "BUSINESS_OWNER",
        String(t.scope.businessId),
        String(t.first._id),
        { settlement: "FULL" },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(transaction).not.toHaveBeenCalled();
    expect(cas).not.toHaveBeenCalled();
    expect(await effects()).toEqual(before);
    expect(
      (await PackageProgressV2Model.findById(t.progress._id))?.sessions.find((attempt) =>
        attempt.bookingId.equals(t.first._id),
      )?.status,
    ).toBe("SCHEDULED");
  });

  it("Owner completion and venue settlement preserve the original purchase authority", async () => {
    const t = await fixture(),
      h = await surface(t);
    await h
      .post(
        "settlement",
        h.body(
          t.intent("VENUE_SETTLEMENT", {
            bookingId: t.first._id,
            venuePayment: { settlement: "NOT_PAID" },
          }),
        ),
        h.owner,
      )
      .expect(200);
    const body = h.body(t.intent("COMPLETE", { bookingId: t.first._id }));
    await h.post("complete", body, h.owner).expect(200);
    await h.post("complete", body, h.owner).expect(200);
    expect(
      (await PackageProgressV2Model.findById(t.progress._id))?.items[0]?.completedSessions,
    ).toBe(1);
    expect(await readOwnedPackageBatchCompletion(t.scope)).toBeTruthy();
  });
  it.each(["no-show", "reverse-no-show"])(
    "Owner %s uses real no-show state and deadline authority",
    async (action) => {
      const t = await fixture({ categoryWindow: true }),
        h = await surface(t),
        window = must(t.first.noShowEligibilitySnapshot);
      t.advance(new Date(t.first.schedule.startAt.getTime() + window.opensAfterMinutes * 60000));
      await h
        .post("mark-no-show", h.body(t.intent("MARK_NO_SHOW", { bookingId: t.first._id })), h.owner)
        .expect(200);
      if (action === "no-show") {
        const booking = await BookingModel.findById(t.first._id).orFail();
        t.advance(must(booking.noShowDeadlineAt));
      }
      const input = h.body(
        t.intent(action === "no-show" ? "NO_SHOW" : "REVERSE_NO_SHOW", { bookingId: t.first._id }),
      );
      await h.post(action, input, h.owner).expect(200);
      await h.post(action, input, h.owner).expect(200);
      expect((await BookingModel.findById(t.first._id))?.status).toBe(
        action === "no-show" ? "NO_SHOW_WAIVED" : "NO_SHOW_CANCELLED",
      );
    },
  );
  it("expiry processing is exact-package, authenticated and idempotent; expired redemption fails", async () => {
    const t = await fixture({ mode: "FINITE" }),
      h = await surface(t);
    if (t.progress.purchasedContract?.validity.mode !== "FINITE") throw Error("finite");
    t.advance(t.progress.purchasedContract.validity.expiresAt);
    await h.post("redeem", h.body(t.redeem())).expect(409);
    const input = h.body(t.intent("EXPIRE"));
    await h.post("expire", input).expect(200);
    await h.post("expire", input).expect(200);
    expect(
      (await PackageProgressV2Model.findById(t.progress._id))?.items.every(
        (i) => i.remainingSessions === 0,
      ),
    ).toBe(true);
  });
  it("invalid service entitlement, foreign tenant and foreign session cannot consume credit", async () => {
    const t = await fixture(),
      h = await surface(t),
      before = await BookingModel.countDocuments();
    await h
      .post("redeem", h.body({ ...t.redeem(), packageItemId: new Types.ObjectId() }))
      .expect(409);
    await h
      .post("redeem", { ...h.body(t.redeem()), businessId: String(new Types.ObjectId()) })
      .expect(404);
    await h
      .post("cancel", h.body(t.intent("CANCEL", { bookingId: new Types.ObjectId() })))
      .expect(404);
    expect(await BookingModel.countDocuments()).toBe(before);
    expect(
      (await PackageProgressV2Model.findById(t.progress._id))?.items[0]?.remainingSessions,
    ).toBe(t.progress.items[0]?.remainingSessions);
  });
  it("failure after the real reservation rolls back Booking and credit through HTTP", async () => {
    const t = await fixture(),
      h = await surface(t),
      reserve = t.reservations.reserveOrJoin.bind(t.reservations);
    vi.spyOn(t.reservations, "reserveOrJoin").mockImplementationOnce(async (...args) => {
      await reserve(...args);
      throw Error("synthetic post-reservation failure");
    });
    await h.post("redeem", h.body(t.redeem())).expect(500);
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
    expect(
      (await PackageProgressV2Model.findById(t.progress._id))?.items[0]?.remainingSessions,
    ).toBe(t.progress.items[0]?.remainingSessions);
  });
  it("concurrent last-credit HTTP redemptions admit at most one Booking", async () => {
    const t = await fixture(),
      h = await surface(t),
      remaining = must(t.progress.items[0]).remainingSessions;
    for (let i = 1; i < remaining; i++)
      await t.customer({
        ...t.redeem(),
        startAt: new Date(t.first.schedule.startAt.getTime() + i * 86400000),
      });
    const before = await BookingModel.countDocuments();
    const results = await Promise.all(
      [8, 9].map((day) =>
        h.post(
          "redeem",
          h.body({
            ...t.redeem(),
            startAt: new Date(t.first.schedule.startAt.getTime() + day * 86400000),
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await BookingModel.countDocuments()).toBe(before + 1);
  });
  it("positive Add-on quote, exact acceptance and venue dues use existing financial authority", async () => {
    const t = await fixture({ addon: true }),
      h = await surface(t);
    await t.business(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const addon = await AddonModel.findOne({ businessId: t.scope.businessId }).orFail();
    const input = h.body({
      ...t.redeem(),
      dues: { addonIds: [addon._id], paymentMethod: "VENUE" },
    });
    const q = (await h.post("session-quote", input).expect(200)).body.data;
    expect(q.totalCents).toBeGreaterThan(0);
    expect(q).not.toHaveProperty("sessionFamilyId");
    await h.post("redeem", input).expect(409);
    const acceptance = {
      quoteId: q.quoteId,
      termsHash: q.termsHash,
      disclosureHash: q.disclosureHash,
      challenge: q.challenge,
      action: "ACCEPT_SESSION_DUES",
    };
    await h
      .post("session-acceptance", {
        ...input,
        acceptance: { ...acceptance, challenge: "wrong-challenge-at-least-32-characters" },
      })
      .expect(409);
    await h.post("session-acceptance", { ...input, acceptance }).expect(200);
    const result = await h.post("redeem", input).expect(200);
    expect(
      (await BookingModel.findById(result.body.data.bookingId))?.financials.addonsSubtotalCents,
    ).toBe(q.addonsCents);
    expect(await PaymentAttemptModel.countDocuments()).toBe(0);
  });
  it("actual pending online dues resume the accepted PaymentAttempt through HTTP", async () => {
    const t = await fixture({ first: true, addon: true, bundlePriceCents: 0 }),
      h = await surface(t);
    await t.business(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const input = h.body({
      ...t.redeem(),
      dues: {
        addonIds: [must(t.first.serviceLines[0]?.addons[0]).addonId],
        paymentMethod: "ONLINE",
      },
    });
    const q = (await h.post("session-quote", input).expect(200)).body.data;
    await h
      .post("session-acceptance", {
        ...input,
        acceptance: {
          quoteId: q.quoteId,
          termsHash: q.termsHash,
          disclosureHash: q.disclosureHash,
          challenge: q.challenge,
          action: "ACCEPT_SESSION_DUES",
        },
      })
      .expect(200);
    t.gateway.queueNextChargeOutcome("requires_action");
    const pending = await h.post("redeem", input).expect(202);
    expect(pending.body.data.state).toBe("PAYMENT_PENDING");
    expect(pending.body.data.clientSecret).toBeTruthy();
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
    const attempt = await PaymentAttemptModel.findById(pending.body.data.paymentAttemptId).orFail();
    t.gateway.succeedPaymentIntent(must(attempt.providerPaymentIntentId));
    await h.post("redeem", input).expect(200);
    await h.post("redeem", input).expect(200);
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length + 1);
  });
  it("selection reuses C1 and returns staff/slots only for an owned included service", async () => {
    const t = await fixture(),
      h = await surface(t),
      redeem = t.redeem();
    const day = must(redeem.startAt).toISOString().slice(0, 10);
    const res = await h
      .post("selection", {
        businessId: String(t.scope.businessId),
        packageProgressId: String(t.progress._id),
        packageItemId: String(redeem.packageItemId),
        fromDate: day,
        toDate: day,
      })
      .expect(200);
    expect(res.body.data.timezone).toBe(t.first.schedule.timezone);
    expect(res.body.data.providers.length).toBeGreaterThan(0);
    expect(res.body.data.days.flatMap((d: { slots: unknown[] }) => d.slots).length).toBeGreaterThan(
      0,
    );
    expect(await BookingModel.countDocuments()).toBe(t.full.bookings.length);
  });
  // P4K-3: read-only recovery of an exact Customer redemption (reload / lost response).
  const effects = async (progressId: Types.ObjectId) => ({
    bookings: await BookingModel.countDocuments(),
    operations: await PackageLifecycleOperationModel.countDocuments(),
    attempts: await PaymentAttemptModel.countDocuments(),
    reservations: await BookingSlotReservationModel.countDocuments(),
    remaining: (await PackageProgressV2Model.findById(progressId).orFail()).items.map(
      (i) => i.remainingSessions,
    ),
  });
  it("P4K-3 session-status recovers the committed redemption read-only and identically", async () => {
    const t = await fixture(),
      h = await surface(t),
      redeem = h.body(t.redeem());
    const committed = (await h.post("redeem", redeem).expect(200)).body.data;
    const after = await effects(t.progress._id);
    for (let i = 0; i < 2; i++) {
      const status = (await h.post("session-status", redeem).expect(200)).body.data;
      expect(status).toMatchObject({
        state: "COMMITTED",
        bookingId: committed.bookingId,
        status: committed.status,
      });
      expect(status).not.toHaveProperty("tasks");
      expect(status).not.toHaveProperty("money");
    }
    expect(await effects(t.progress._id)).toEqual(after);
    expect(after.remaining[0]).toBe(must(t.progress.items[0]).remainingSessions - 1);
    expect(after.bookings).toBe(t.full.bookings.length + 1);
  });
  it("P4K-3 lost response after commit: status returns the same Booking without replaying", async () => {
    const t = await fixture(),
      h = await surface(t),
      request = t.redeem();
    // The HTTP response is lost: the service committed but the Client never saw the result.
    const committed = await t.moneyLifecycle.customer(t.scope.customer, request);
    const before = await effects(t.progress._id);
    const status = (await h.post("session-status", h.body(request)).expect(200)).body.data;
    expect(status.bookingId).toBe(String(must(committed?.booking)._id));
    expect(await effects(t.progress._id)).toEqual(before);
    // An explicit identical retry converges on the same Booking and credit effect.
    expect((await h.post("redeem", h.body(request)).expect(200)).body.data.bookingId).toBe(
      status.bookingId,
    );
    expect(await effects(t.progress._id)).toEqual(before);
  });
  it("P4K-3 uncertain commit stays UNRESOLVED and status never advances or cleans it up", async () => {
    const t = await fixture(),
      h = await surface(t),
      request = t.redeem();
    vi.spyOn(PackageLifecycleOperations.prototype, "complete").mockRejectedValueOnce(
      Object.assign(Error("unknown"), { errorLabels: ["UnknownTransactionCommitResult"] }),
    );
    await expect(t.moneyLifecycle.customer(t.scope.customer, request)).rejects.toThrow();
    const before = await effects(t.progress._id);
    expect((await h.post("session-status", h.body(request)).expect(202)).body.data).toEqual({
      state: "UNRESOLVED",
    });
    expect((await PackageLifecycleOperationModel.findOne().orFail()).phase).toBe("PERSISTING");
    expect(await effects(t.progress._id)).toEqual(before);
    expect(before.bookings).toBe(t.full.bookings.length);
  });
  it("P4K-3 status creates no operation and binds the exact Customer, key and fields", async () => {
    const t = await fixture(),
      h = await surface(t),
      redeem = h.body(t.redeem());
    await h.post("session-status", redeem).expect(404);
    expect(await PackageLifecycleOperationModel.countDocuments()).toBe(0);
    await h.post("redeem", redeem).expect(200);
    const after = await effects(t.progress._id);
    // Same key with a changed time is not this operation (no disclosure of the original).
    await h
      .post("session-status", {
        ...redeem,
        startAt: new Date(t.first.schedule.startAt.getTime() + 5 * 86400000),
      })
      .expect(404);
    await h.post("session-status", { ...redeem, key: `s5:${new Types.ObjectId()}` }).expect(404);
    await h.post("session-status", redeem, h.owner).expect(403);
    const foreign = await UserModel.create({
      normalizedEmail: "p4k3-foreign@s5.test",
      passwordHash: "unused",
      role: "CUSTOMER",
      status: "ACTIVE",
      security: { passwordUpdatedAt: INTERNAL_TIME },
    });
    const other = `Bearer ${await issueTestAccessToken(t.tokens, { userId: foreign._id, role: "CUSTOMER" })}`;
    expect((await h.post("session-status", redeem, other)).status).toBeGreaterThanOrEqual(400);
    expect(await effects(t.progress._id)).toEqual(after);
  });
  it("P4K-3 simultaneous identical submissions commit one Booking and one credit", async () => {
    const t = await fixture(),
      h = await surface(t),
      redeem = h.body(t.redeem());
    const replies = await Promise.all([h.post("redeem", redeem), h.post("redeem", redeem)]);
    for (const reply of replies) expect([200, 202]).toContain(reply.status);
    const status = (await h.post("session-status", redeem).expect(200)).body.data;
    for (const reply of replies)
      if (reply.status === 200) expect(reply.body.data.bookingId).toBe(status.bookingId);
    const after = await effects(t.progress._id);
    expect(after.bookings).toBe(t.full.bookings.length + 1);
    expect(after.remaining[0]).toBe(must(t.progress.items[0]).remainingSessions - 1);
    expect(after.operations).toBe(1);
  });
  it("P4K-3 different keys competing for the last credit commit exactly one", async () => {
    const t = await fixture(),
      h = await surface(t),
      n = must(t.progress.items[0]).remainingSessions;
    const at = (days: number) => new Date(t.first.schedule.startAt.getTime() + days * 86400000);
    for (let i = 1; i < n; i++)
      await h.post("redeem", h.body({ ...t.redeem(), startAt: at(i) })).expect(200);
    const replies = await Promise.all(
      [n + 1, n + 2].map((d) => h.post("redeem", h.body({ ...t.redeem(), startAt: at(d) }))),
    );
    expect(replies.filter((r) => r.status === 200)).toHaveLength(1);
    const after = await effects(t.progress._id);
    expect(after.remaining[0]).toBe(0);
    expect(after.bookings).toBe(t.full.bookings.length + n);
  });
  // P4K-4: read-only recovery of exact Customer cancellation and reschedule operations.
  const redeemed = async (
    t: Awaited<ReturnType<typeof fixture>>,
    h: Awaited<ReturnType<typeof surface>>,
    days = 1,
  ) => {
    const r = await h
      .post(
        "redeem",
        h.body({
          ...t.redeem(),
          startAt: new Date(t.first.schedule.startAt.getTime() + days * 86400000),
        }),
      )
      .expect(200);
    return new Types.ObjectId(r.body.data.bookingId);
  };
  const moved = (t: Awaited<ReturnType<typeof fixture>>, days: number) =>
    new Date(t.first.schedule.startAt.getTime() + days * 86400000);
  it("P4K-4 cancel-status returns the committed cancellation read-only and credit restores once", async () => {
    const t = await fixture(),
      h = await surface(t),
      bookingId = await redeemed(t, h);
    const cancel = h.body(t.intent("CANCEL", { bookingId }));
    const committed = (await h.post("cancel", cancel).expect(200)).body.data;
    const after = await effects(t.progress._id);
    expect(after.remaining[0]).toBe(must(t.progress.items[0]).remainingSessions);
    for (let i = 0; i < 2; i++)
      expect((await h.post("cancel-status", cancel).expect(200)).body.data).toMatchObject({
        state: "COMMITTED",
        status: committed.status,
      });
    expect(await effects(t.progress._id)).toEqual(after);
    expect((await BookingModel.findById(bookingId).orFail()).status).toBe(committed.status);
  });
  it("P4K-4 lost cancellation response: status recovers it and the explicit retry converges", async () => {
    const t = await fixture(),
      h = await surface(t),
      bookingId = await redeemed(t, h),
      request = t.intent("CANCEL", { bookingId });
    const committed = await t.moneyLifecycle.customer(t.scope.customer, request);
    const before = await effects(t.progress._id);
    const status = (await h.post("cancel-status", h.body(request)).expect(200)).body.data;
    expect(status.status).toBe(committed?.result.status);
    expect(await effects(t.progress._id)).toEqual(before);
    expect((await h.post("cancel", h.body(request)).expect(200)).body.data.status).toBe(
      status.status,
    );
    expect(await effects(t.progress._id)).toEqual(before);
  });
  it("P4K-4 reschedule-status returns the same canonical Booking and new time without another reservation", async () => {
    const t = await fixture(),
      h = await surface(t),
      bookingId = await redeemed(t, h);
    const move = h.body(t.intent("RESCHEDULE", { bookingId, startAt: moved(t, 3) }));
    const committed = (await h.post("reschedule", move).expect(200)).body.data;
    const after = await effects(t.progress._id);
    const status = (await h.post("reschedule-status", move).expect(200)).body.data;
    expect(status).toMatchObject({
      state: "COMMITTED",
      bookingId: String(bookingId),
      startAt: committed.startAt,
    });
    expect(await effects(t.progress._id)).toEqual(after);
    expect((await BookingModel.findById(bookingId).orFail()).schedule.startAt.toISOString()).toBe(
      moved(t, 3).toISOString(),
    );
  });
  it("P4K-4 lost reschedule response: status recovers the original move without duplicating it", async () => {
    const t = await fixture(),
      h = await surface(t),
      bookingId = await redeemed(t, h);
    const request = t.intent("RESCHEDULE", { bookingId, startAt: moved(t, 4) });
    await t.moneyLifecycle.customer(t.scope.customer, request);
    const before = await effects(t.progress._id);
    expect(
      (await h.post("reschedule-status", h.body(request)).expect(200)).body.data.bookingId,
    ).toBe(String(bookingId));
    expect(await effects(t.progress._id)).toEqual(before);
    await h.post("reschedule", h.body(request)).expect(200);
    expect(await effects(t.progress._id)).toEqual(before);
  });
  it("P4K-4 uncertain cancellation stays UNRESOLVED and the Booking stays upcoming", async () => {
    const t = await fixture(),
      h = await surface(t),
      bookingId = await redeemed(t, h),
      request = t.intent("CANCEL", { bookingId });
    vi.spyOn(PackageLifecycleOperations.prototype, "complete").mockRejectedValueOnce(
      Object.assign(Error("unknown"), { errorLabels: ["UnknownTransactionCommitResult"] }),
    );
    await expect(t.moneyLifecycle.customer(t.scope.customer, request)).rejects.toThrow();
    const before = await effects(t.progress._id);
    expect((await h.post("cancel-status", h.body(request)).expect(202)).body.data).toEqual({
      state: "UNRESOLVED",
    });
    expect(
      (await PackageLifecycleOperationModel.findById(lifecycleOperationId(request.key)).orFail())
        .phase,
    ).toBe("PERSISTING");
    expect((await BookingModel.findById(bookingId).orFail()).status).toBe("UPCOMING");
    expect(await effects(t.progress._id)).toEqual(before);
  });
  it("P4K-4 one action's key never reveals another action's result", async () => {
    const t = await fixture(),
      h = await surface(t),
      redeem = h.body(t.redeem());
    const bookingId = new Types.ObjectId(
      (await h.post("redeem", redeem).expect(200)).body.data.bookingId,
    );
    const cancel = h.body(t.intent("CANCEL", { bookingId }));
    await h.post("cancel", cancel).expect(200);
    const after = await effects(t.progress._id);
    // Same key with another action or other fields: indistinguishable from a missing operation.
    await h
      .post("cancel-status", {
        businessId: redeem.businessId,
        packageProgressId: redeem.packageProgressId,
        key: redeem.key,
        bookingId,
      })
      .expect(404);
    await h.post("reschedule-status", { ...cancel, startAt: moved(t, 3) }).expect(404);
    await h
      .post("expire-status", {
        businessId: cancel.businessId,
        packageProgressId: cancel.packageProgressId,
        key: cancel.key,
      })
      .expect(404);
    await h.post("session-status", { ...redeem, key: cancel.key }).expect(404);
    await h.post("cancel-status", { ...cancel, bookingId: t.first._id }).expect(404);
    await h.post("cancel-status", { ...cancel, key: `s5:${new Types.ObjectId()}` }).expect(404);
    expect(await effects(t.progress._id)).toEqual(after);
  });
  it("P4K-4 simultaneous identical cancellations restore one credit and release once", async () => {
    const t = await fixture(),
      h = await surface(t),
      bookingId = await redeemed(t, h);
    const cancel = h.body(t.intent("CANCEL", { bookingId }));
    const replies = await Promise.all([h.post("cancel", cancel), h.post("cancel", cancel)]);
    for (const reply of replies) expect([200, 202]).toContain(reply.status);
    expect((await h.post("cancel-status", cancel).expect(200)).body.data.state).toBe("COMMITTED");
    const after = await effects(t.progress._id);
    expect(after.remaining[0]).toBe(must(t.progress.items[0]).remainingSessions);
    expect(after.bookings).toBe(t.full.bookings.length + 1);
  });
  it("P4K-4 different keys moving two Bookings into one slot admit exactly one", async () => {
    const t = await fixture(),
      h = await surface(t);
    const a = await redeemed(t, h, 1),
      b = await redeemed(t, h, 2);
    const target = moved(t, 5);
    const replies = await Promise.all(
      [a, b].map((bookingId) =>
        h.post("reschedule", h.body(t.intent("RESCHEDULE", { bookingId, startAt: target }))),
      ),
    );
    expect(replies.filter((r) => r.status === 200)).toHaveLength(1);
    expect(
      await BookingModel.countDocuments({ _id: { $in: [a, b] }, "schedule.startAt": target }),
    ).toBe(1);
  });
  it("P4K-4 Owner, foreign Customer and an unlinked relationship cannot read Customer status", async () => {
    const t = await fixture(),
      h = await surface(t),
      bookingId = await redeemed(t, h);
    const cancel = h.body(t.intent("CANCEL", { bookingId }));
    await h.post("cancel", cancel).expect(200);
    const after = await effects(t.progress._id);
    // P4K-5: the Owner may use status actions, but only for the Owner's own operations.
    await h.post("cancel-status", cancel, h.owner).expect(404);
    const foreign = await UserModel.create({
      normalizedEmail: "p4k4-foreign@s5.test",
      passwordHash: "unused",
      role: "CUSTOMER",
      status: "ACTIVE",
      security: { passwordUpdatedAt: INTERNAL_TIME },
    });
    const other = `Bearer ${await issueTestAccessToken(t.tokens, { userId: foreign._id, role: "CUSTOMER" })}`;
    const denied = await h.post("cancel-status", cancel, other);
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(denied.body)).not.toContain(String(bookingId));
    await new ClientRepository().setLinkState(t.scope.businessClientId, { linkState: "UNLINKED" });
    expect((await h.post("cancel-status", cancel)).status).toBe(409);
    expect(await effects(t.progress._id)).toEqual(after);
  });
  // P4K-5: read-only recovery of exact Owner/Supervisor management operations.
  const managementEffects = async (progressId: Types.ObjectId) => ({
    ...(await effects(progressId)),
    ledger: await BookingFinancialTransactionModel.countDocuments(),
    emails: await EmailOutboxModel.countDocuments(),
    reminders: await AppointmentReminderModel.countDocuments(),
    refunds: await RefundOperationModel.countDocuments(),
    completed: (await PackageProgressV2Model.findById(progressId).orFail()).items.map(
      (i) => i.completedSessions,
    ),
    bookingStates: (await BookingModel.find().sort({ _id: 1 }).lean()).map((b) => [
      String(b._id),
      b.status,
      b.completionPayment?.amountCents ?? 0,
    ]),
  });
  const managementSupervisor = async (t: Awaited<ReturnType<typeof fixture>>) => {
    const user = await UserModel.create({
      normalizedEmail: `approved-c-${new Types.ObjectId()}@s5.test`,
      passwordHash: "unused",
      role: "SUPERVISOR",
      status: "ACTIVE",
      security: { passwordUpdatedAt: INTERNAL_TIME },
    });
    const membership = await StaffMembershipModel.create({
      userId: user._id,
      businessId: t.scope.businessId,
      role: "SUPERVISOR",
      employmentActive: true,
      createdByUserId: t.f.business.ownerUserId,
    });
    const authorization = `Bearer ${await issueTestAccessToken(t.tokens, { userId: user._id, role: "SUPERVISOR" })}`;
    return { user, membership, authorization };
  };

  it("approved Fix C denies inactive Supervisor mutation and own/Owner status while preserving committed evidence", async () => {
    const t = await fixture({ bundlePriceCents: 1000 }),
      h = await surface(t),
      s = await managementSupervisor(t);
    // null is explicitly non-removed under the shared repository/index contract.
    await StaffMembershipModel.updateOne({ _id: s.membership._id }, { $set: { removedAt: null } });
    const own = t.intent("VENUE_SETTLEMENT", {
      bookingId: t.first._id,
      venuePayment: { settlement: "PARTIAL", amountCents: 200 },
    });
    await h.post("settlement", h.body(own), s.authorization).expect(200);
    const owner = t.intent("VENUE_SETTLEMENT", {
      bookingId: t.first._id,
      venuePayment: { settlement: "PARTIAL", amountCents: 100 },
    });
    await h.post("settlement", h.body(owner), h.owner).expect(200);
    await h.post("settlement-status", h.body(own), s.authorization).expect(200);
    await h.post("settlement-status", h.body(owner), s.authorization).expect(404);
    const evidence = await PackageLifecycleOperationModel.find().sort({ _id: 1 }).lean();
    const after = await managementEffects(t.progress._id);
    await StaffMembershipModel.updateOne(
      { _id: s.membership._id },
      { $set: { employmentActive: false } },
    );
    await h.post("settlement-status", h.body(own), s.authorization).expect(404);
    await h.post("settlement-status", h.body(owner), s.authorization).expect(404);
    await h
      .post("complete", h.body(t.intent("COMPLETE", { bookingId: t.first._id })), s.authorization)
      .expect(404);
    await h.post("settlement", h.body(own), s.authorization).expect(404); // even committed replay must be authorized
    await expect(
      t.moneyLifecycle.businessOperationStatus(
        s.user._id,
        "SUPERVISOR",
        t.f.context.customerUserId,
        own,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      t.moneyLifecycle.business(s.user._id, "SUPERVISOR", t.f.context.customerUserId, own),
    ).rejects.toMatchObject({ statusCode: 404 });
    await h.post("settlement-status", h.body(owner), h.owner).expect(200);
    expect(await managementEffects(t.progress._id)).toEqual(after);
    expect(await PackageLifecycleOperationModel.find().sort({ _id: 1 }).lean()).toEqual(evidence);
    // Evidence survives deactivation. Reauthorization recovers only this exact actor's result.
    await StaffMembershipModel.updateOne(
      { _id: s.membership._id },
      { $set: { employmentActive: true } },
    );
    await h.post("settlement-status", h.body(own), s.authorization).expect(200);
    await h.post("settlement-status", h.body(owner), s.authorization).expect(404);
    expect(await managementEffects(t.progress._id)).toEqual(after);
  });

  it.each(["removed", "foreign", "wrong-role", "suspended", "revoked"] as const)(
    "approved Fix C preserves %s denial on management mutation and status",
    async (denial) => {
      const t = await fixture(),
        h = await surface(t),
        s = await managementSupervisor(t);
      const request = t.intent("COMPLETE", { bookingId: t.first._id });
      await h.post("complete", h.body(request), s.authorization).expect(200);
      const after = await managementEffects(t.progress._id);
      if (denial === "revoked") await t.tokens.revokeAllSessionsForUser(s.user._id);
      else if (denial === "suspended")
        await UserModel.updateOne({ _id: s.user._id }, { $set: { status: "SUSPENDED" } });
      else
        await StaffMembershipModel.updateOne(
          { _id: s.membership._id },
          {
            $set:
              denial === "removed"
                ? { removedAt: new Date() }
                : denial === "foreign"
                  ? { businessId: new Types.ObjectId() }
                  : { role: "STAFF" },
          },
        );
      for (const action of ["complete", "complete-status"] as const) {
        const response = await h.post(action, h.body(request), s.authorization);
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(response.body)).not.toContain('"state":"COMMITTED"');
      }
      // Direct domain methods have no token parameter; sid revocation is the HTTP boundary.
      if (denial !== "revoked")
        await expect(
          t.lifecycle.businessOperationStatus(
            s.user._id,
            "SUPERVISOR",
            t.f.context.customerUserId,
            request,
          ),
        ).rejects.toThrow();
      expect(await managementEffects(t.progress._id)).toEqual(after);
    },
  );

  it("package transaction rechecks deactivation that commits after shared entry authorization", async () => {
    const t = await fixture(),
      s = await managementSupervisor(t);
    const request = t.intent("COMPLETE", { bookingId: t.first._id });
    const before = (await PackageProgressV2Model.findById(t.progress._id).orFail()).toObject();
    const original = PackageLifecycleOperations.prototype.claim;
    vi.spyOn(PackageLifecycleOperations.prototype, "claim").mockImplementationOnce(async function (
      this: PackageLifecycleOperations,
      id,
    ) {
      const claimed = await original.call(this, id);
      await withPackageEligibility(t.scope.businessId, undefined, async (session) => {
        await StaffMembershipModel.updateOne(
          { _id: s.membership._id },
          { $set: { employmentActive: false } },
        ).session(session);
      });
      return claimed;
    });
    await expect(
      t.lifecycle.business(s.user._id, "SUPERVISOR", t.f.context.customerUserId, request),
    ).rejects.toThrow();
    expect((await BookingModel.findById(t.first._id))?.status).toBe("UPCOMING");
    expect((await PackageProgressV2Model.findById(t.progress._id).orFail()).toObject()).toEqual(
      before,
    );
    expect(
      (await PackageLifecycleOperationModel.findById(lifecycleOperationId(request.key)))?.phase,
    ).not.toBe("COMPLETE");
  });

  it("P4K-5 Owner completion: complete-status returns the committed result read-only", async () => {
    const t = await fixture(),
      h = await surface(t);
    const body = h.body(t.intent("COMPLETE", { bookingId: t.first._id }));
    const committed = (await h.post("complete", body, h.owner).expect(200)).body.data;
    const after = await managementEffects(t.progress._id);
    for (let i = 0; i < 2; i++)
      expect((await h.post("complete-status", body, h.owner).expect(200)).body.data).toMatchObject({
        state: "COMMITTED",
        status: committed.status,
      });
    expect(await managementEffects(t.progress._id)).toEqual(after);
    expect(after.completed[0]).toBe(1);
  });
  it("P4K-5 lost completion response: status recovers it and the identical retry converges", async () => {
    const t = await fixture(),
      h = await surface(t),
      request = t.intent("COMPLETE", { bookingId: t.first._id });
    const committed = await t.business(request);
    const before = await managementEffects(t.progress._id);
    expect(
      (await h.post("complete-status", h.body(request), h.owner).expect(200)).body.data.status,
    ).toBe(committed?.result.status);
    await h.post("complete", h.body(request), h.owner).expect(200);
    expect(await managementEffects(t.progress._id)).toEqual(before);
  });
  it("P4K-5 venue settlement status is COMMITTED only with ledger proof and never settles again", async () => {
    const t = await fixture(),
      h = await surface(t);
    const body = h.body(
      t.intent("VENUE_SETTLEMENT", {
        bookingId: t.first._id,
        venuePayment: { settlement: "FULL" },
      }),
    );
    await h.post("settlement", body, h.owner).expect(200);
    const after = await managementEffects(t.progress._id);
    for (let i = 0; i < 2; i++)
      expect((await h.post("settlement-status", body, h.owner).expect(200)).body.data.state).toBe(
        "COMMITTED",
      );
    expect(await managementEffects(t.progress._id)).toEqual(after);
    // Removing the ledger proof makes the same operation unprovable: UNRESOLVED, never success.
    const operation = await PackageLifecycleOperationModel.findById(
      lifecycleOperationId(body.key),
    ).orFail();
    if (operation.result?.venue?.ledgerId) {
      await BookingFinancialTransactionModel.deleteOne({ _id: operation.result.venue.ledgerId });
      expect((await h.post("settlement-status", body, h.owner).expect(202)).body.data).toEqual({
        state: "UNRESOLVED",
      });
    }
  });
  it("P4K-5 mark-no-show and no-show statuses recover deterministic-time transitions", async () => {
    const t = await fixture({ policy: true, categoryWindow: true }),
      h = await surface(t),
      w = must(t.first.noShowEligibilitySnapshot);
    t.advance(new Date(t.first.schedule.startAt.getTime() + w.opensAfterMinutes * 60000));
    const mark = h.body(t.intent("MARK_NO_SHOW", { bookingId: t.first._id }));
    await h.post("mark-no-show", mark, h.owner).expect(200);
    expect((await h.post("mark-no-show-status", mark, h.owner).expect(200)).body.data.state).toBe(
      "COMMITTED",
    );
    t.advance(must((await BookingModel.findById(t.first._id).orFail()).noShowDeadlineAt));
    const resolve = h.body(t.intent("NO_SHOW", { bookingId: t.first._id }));
    await h.post("no-show", resolve, h.owner).expect(200);
    const after = await managementEffects(t.progress._id);
    expect((await h.post("no-show-status", resolve, h.owner).expect(200)).body.data.state).toBe(
      "COMMITTED",
    );
    expect(await managementEffects(t.progress._id)).toEqual(after);
  });
  it("P4K-5 uncertain completion stays UNRESOLVED and is not advanced", async () => {
    const t = await fixture(),
      h = await surface(t),
      request = t.intent("COMPLETE", { bookingId: t.first._id });
    vi.spyOn(PackageLifecycleOperations.prototype, "complete").mockRejectedValueOnce(
      Object.assign(Error("unknown"), { errorLabels: ["UnknownTransactionCommitResult"] }),
    );
    await expect(t.business(request)).rejects.toThrow();
    const before = await managementEffects(t.progress._id);
    expect(
      (await h.post("complete-status", h.body(request), h.owner).expect(202)).body.data,
    ).toEqual({ state: "UNRESOLVED" });
    expect(
      (await PackageLifecycleOperationModel.findById(lifecycleOperationId(request.key)).orFail())
        .phase,
    ).toBe("PERSISTING");
    expect(await managementEffects(t.progress._id)).toEqual(before);
  });
  it("P4K-5 management status binds actor, action and Booking; Customers, foreign owners and inactive owners are denied", async () => {
    const t = await fixture(),
      h = await surface(t);
    const cancel = h.body(t.intent("CANCEL", { bookingId: t.first._id }));
    await h.post("cancel", cancel, h.owner).expect(200);
    const after = await managementEffects(t.progress._id);
    expect((await h.post("cancel-status", cancel, h.owner).expect(200)).body.data.state).toBe(
      "COMMITTED",
    );
    await h.post("cancel-status", cancel).expect(404); // the Customer cannot read the Owner's operation
    await h.post("complete-status", { ...cancel }, h.owner).expect(404); // another action, same key
    await h.post("complete-status", cancel).expect(403); // management-only status
    const foreign = await UserModel.create({
      normalizedEmail: "p4k5-owner@s5.test",
      passwordHash: "unused",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      security: { passwordUpdatedAt: INTERNAL_TIME },
    });
    const foreignOwner = `Bearer ${await issueTestAccessToken(t.tokens, { userId: foreign._id, role: "BUSINESS_OWNER" })}`;
    const denied = await h.post("cancel-status", cancel, foreignOwner);
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(denied.body)).not.toContain("COMMITTED");
    await UserModel.updateOne({ _id: t.f.business.ownerUserId }, { $set: { status: "SUSPENDED" } });
    expect((await h.post("cancel-status", cancel, h.owner)).status).toBeGreaterThanOrEqual(400);
    expect(await managementEffects(t.progress._id)).toEqual(after);
  });
  // P4K-5 deterministic time boundaries (fixture clock only; no host clock is touched).
  it.each([6, 12] as const)(
    "P4K-5 FINITE%s expiry reconciliation is refused 1 ms before expiresAt and applies exactly at it",
    async (months) => {
      const t = await fixture({ mode: "FINITE", months });
      if (t.progress.purchasedContract?.validity.mode !== "FINITE") throw Error("finite fixture");
      const expiresAt = t.progress.purchasedContract.validity.expiresAt;
      t.advance(new Date(expiresAt.getTime() - 1));
      const early = t.intent("EXPIRE");
      await expect(t.customer(early)).rejects.toThrow();
      const unchanged = await PackageProgressV2Model.findById(t.progress._id).orFail();
      expect(unchanged.expiryReconciledAt).toBeUndefined();
      expect(unchanged.items.map((i) => i.remainingSessions)).toEqual(
        t.progress.items.map((i) => i.remainingSessions),
      );
      t.advance(expiresAt);
      const r = await t.customer(t.intent("EXPIRE"));
      expect(r?.progress.items.every((i) => i.remainingSessions === 0)).toBe(true);
    },
  );
  it("P4K-5 mark-no-show is refused 1 ms before the window opens and allowed exactly at it", async () => {
    const t = await fixture({ policy: true, categoryWindow: true }),
      w = must(t.first.noShowEligibilitySnapshot);
    const opens = t.first.schedule.startAt.getTime() + w.opensAfterMinutes * 60000;
    t.advance(new Date(opens - 1));
    await expect(
      t.business(t.intent("MARK_NO_SHOW", { bookingId: t.first._id })),
    ).rejects.toThrow();
    expect((await BookingModel.findById(t.first._id).orFail()).status).toBe("UPCOMING");
    t.advance(new Date(opens));
    const marked = await t.business(t.intent("MARK_NO_SHOW", { bookingId: t.first._id }));
    expect(marked?.booking?.status).toBe("PENDING");
  });
});
