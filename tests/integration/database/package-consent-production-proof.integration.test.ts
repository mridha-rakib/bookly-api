import { randomUUID } from "node:crypto";
import express from "express";
import mongoose, { Types } from "mongoose";
import httpRequest from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asyncHandler } from "../../../src/common/middleware/async-handler.js";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
} from "../../../src/modules/auth/auth.middleware.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { createCustomerBookingRoute } from "../../../src/modules/booking/booking.route.js";
import { BookingCreationClaimModel } from "../../../src/modules/booking/booking-creation-claim.model.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import { verifyBatchCompletion } from "../../../src/modules/booking/package-batch-completion.js";
import { PackageBatchFinancialPersistence } from "../../../src/modules/booking/package-batch-financial-persistence.js";
import { verifyCertifiedPackageConsent } from "../../../src/modules/booking/package-consent-certification.js";
import {
  PackageConsentEvidenceModel,
  readConsentEvidence,
} from "../../../src/modules/booking/package-consent-evidence.js";
import { PackageConsentProtocol } from "../../../src/modules/booking/package-consent-protocol.js";
import { PackageLifecycleService } from "../../../src/modules/booking/package-lifecycle.service.js";
import { PackageLifecycleHttpController } from "../../../src/modules/booking/package-lifecycle-http.controller.js";
import type { PackageLifecycleHttpServices } from "../../../src/modules/booking/package-lifecycle-http.factory.js";
import { PackageLifecycleOperations } from "../../../src/modules/booking/package-lifecycle-operation.js";
import { PackagePurchaseService } from "../../../src/modules/booking/package-purchase.service.js";
import { verifyPackagePurchaseClaimCompletion } from "../../../src/modules/booking/package-purchase-authority.js";
import { observeConsentHost } from "../../../src/modules/booking/trusted-time/host-clock.js";
import { requireQualifiedConsentHost } from "../../../src/modules/booking/trusted-time/qualified-host.js";
import { BookingFinancialTransactionModel } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
import { BookingFinancialTransactionRepository } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { BookingSlotReservationModel } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.model.js";
import { BusinessClientModel } from "../../../src/modules/client/client.model.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { createFinancialRelationshipService } from "../../../src/modules/client/financial-relationship.factory.js";
import { PackageProgressV2Model } from "../../../src/modules/package-progress/package-progress-v2.model.js";
import { createPackageViewRoute } from "../../../src/modules/package-progress/package-view.route.js";
import { readPackagePurchaseCompletion } from "../../../src/modules/package-progress/package-view.service.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { PaymentAttemptModel } from "../../../src/modules/payment/payment-attempt.model.js";
import { PaymentAttemptRepository } from "../../../src/modules/payment/payment-attempt.repository.js";
import { RefundOperationModel } from "../../../src/modules/payment/refund-operation.model.js";
import { RefundOperationRepository } from "../../../src/modules/payment/refund-operation.repository.js";
import { SessionModel } from "../../../src/modules/session/session.model.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { createStaffScheduleRoute } from "../../../src/modules/staff/staff.route.js";
import { StripeWebhookService } from "../../../src/modules/stripe-webhook/stripe-webhook.service.js";
import { StripeWebhookEventRepository } from "../../../src/modules/stripe-webhook/stripe-webhook-event.repository.js";
import { createSuperAdminRoute } from "../../../src/modules/super-admin/super-admin.route.js";
import { UserModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import {
  syntheticConsentHost,
  syntheticHostObservation,
} from "../../helpers/consent-host-fixture.js";
import { FakePaymentGateway } from "../../helpers/fake-payment-gateway.js";
import { INTERNAL_TIME, packageBatchFixture } from "../../helpers/package-batch-fixture.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

// Only rollout and the explicitly synthetic clock are substituted. The actual protocol,
// majority transaction, evidence verifier, F2 financial parent and public proof remain real.
vi.mock("../../../src/modules/booking/package-batch-authority.js", async (original) => ({
  ...(await original<object>()),
  verifyPackageBatchActivation: vi.fn(async () => undefined),
}));
vi.mock("../../../src/modules/booking/trusted-time/qualified-host.js", () => ({
  requireQualifiedConsentHost: vi.fn(() => syntheticConsentHost),
  requireConsentHostVerificationProfile: () => syntheticConsentHost,
}));
vi.mock("../../../src/modules/booking/trusted-time/host-clock.js", async (original) => ({
  ...(await original<object>()),
  observeConsentHost: vi.fn(async (witness: string) => syntheticHostObservation(witness)),
}));

describe("P3B actual consent certification and genuine atomic completion", () => {
  beforeAll(connectIsolatedDatabase, 120000);
  beforeEach(async () => {
    await clearIsolatedDatabase();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(INTERNAL_TIME);
    vi.mocked(observeConsentHost).mockImplementation(async (witness) =>
      syntheticHostObservation(witness),
    );
    vi.mocked(requireQualifiedConsentHost).mockImplementation(() => syntheticConsentHost);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  afterAll(stopIsolatedReplicaSet);
  async function fixture(first = false, bundlePriceCents?: number) {
    const t = await packageBatchFixture({
      certifiedConsent: true,
      operationId: randomUUID(),
      first,
      ...(bundlePriceCents !== undefined ? { bundlePriceCents } : {}),
    });
    if (!first)
      await BusinessClientModel.updateOne(
        { _id: t.scope.businessClientId },
        { $set: { activatedAt: INTERNAL_TIME } },
      );
    const attempts = new PaymentAttemptRepository(),
      refunds = new RefundOperationRepository(),
      gateway = new FakePaymentGateway();
    const profiles = new CustomerPaymentProfileRepository();
    if (first) {
      await profiles.createIfMissing(t.f.context.customerUserId, "cus_p3b_synthetic");
      await profiles.savePaymentMethod({
        userId: t.f.context.customerUserId,
        defaultPaymentMethodId: "pm_p3b_synthetic",
        cardBrand: "visa",
        cardLast4: "4242",
        cardExpMonth: 12,
        cardExpYear: 2035,
      });
    }
    const payments = new PaymentService(gateway, profiles, new UserRepository(), attempts, refunds);
    const relationships = createFinancialRelationshipService({
      paymentAttemptRepository: attempts,
      refundOperationRepository: refunds,
      bookingRepository: new BookingRepository(),
      claimRepository: new BookingCreationClaimRepository(),
      clientRepository: new ClientRepository(),
    });
    const writer = new PackageBatchFinancialPersistence(
      t.writer,
      relationships,
      payments,
      () => INTERNAL_TIME,
    );
    return { ...t, writer, gateway, attempts, refunds, relationships };
  }
  it("P4I verifies the original durable certificate while current issuance authority is unavailable", async () => {
    await fixture();
    const claim = await BookingCreationClaimModel.findOne().orFail();
    const original = await verifyCertifiedPackageConsent(claim.toObject());
    const observationCount = vi.mocked(observeConsentHost).mock.calls.length;
    vi.mocked(requireQualifiedConsentHost).mockImplementation(() => {
      throw Error("current boot unqualified");
    });
    await expect(verifyCertifiedPackageConsent(claim.toObject())).resolves.toEqual(original);
    await expect(
      new PackageConsentProtocol().certify(claim.idempotencyKey),
    ).resolves.toBeUndefined();
    expect(vi.mocked(observeConsentHost).mock.calls.length).toBe(observationCount);
    expect(await PackageConsentEvidenceModel.countDocuments({ phase: "CERTIFICATION" })).toBe(1);
    expect(await BookingModel.countDocuments()).toBe(0);
    expect(await PaymentAttemptModel.countDocuments()).toBe(0);
  });
  it.each([false, true])(
    "paid=%s genuine proof binds certified consent and verifies ownership, without promoting v1",
    async (first) => {
      const t = await fixture(first),
        claimBefore = await BookingCreationClaimModel.findOne().orFail();
      const certified = await verifyCertifiedPackageConsent(claimBefore.toObject());
      const result = await t.writer.complete(t.scope);
      expect(result.completion.version).toBe(2);
      expect(result.completion.state).toBe("GENUINE_COMPLETE_BATCH");
      if (result.completion.version !== 2) throw Error("genuine proof required");
      expect(result.completion.consentCertificateId).toEqual(certified.certificateId);
      const claim = await BookingCreationClaimModel.findOne().orFail();
      await expect(verifyPackagePurchaseClaimCompletion(claim.toObject())).resolves.toBeTruthy();
      expect(await readPackagePurchaseCompletion(result.progress)).toBe("VERIFIED");
      await t.writer.complete(t.scope);
      expect(await PackageProgressV2Model.countDocuments()).toBe(1);
      expect(t.gateway.paymentIntentInputs).toHaveLength(first ? 1 : 0);
      expect(await PackageConsentEvidenceModel.countDocuments({ phase: "CERTIFICATION" })).toBe(1);
    },
  );
  it("lost post-commit observation remains uncertified and exact-operation recovery can certify", async () => {
    vi.mocked(observeConsentHost)
      .mockImplementationOnce(async (w) => syntheticHostObservation(w))
      .mockRejectedValueOnce(Error("clock unavailable"));
    await expect(packageBatchFixture({ certifiedConsent: true })).rejects.toThrow(
      "clock unavailable",
    );
    const claim = await BookingCreationClaimModel.findOne().orFail();
    expect(claim.packageCheckoutAcceptance).toBeTruthy();
    expect(await readConsentEvidence(claim.idempotencyKey, "ACCEPTANCE")).toBeTruthy();
    expect(await readConsentEvidence(claim.idempotencyKey, "CERTIFICATION")).toBeNull();
    expect(await BookingModel.countDocuments()).toBe(0);
    await new PackageConsentProtocol().certify(claim.idempotencyKey);
    await expect(verifyCertifiedPackageConsent(claim.toObject())).resolves.toBeTruthy();
  });
  it("issuance retry retains the original anchor, identities and deadline, even with a later proposed window", async () => {
    const t = await fixture(),
      protocol = new PackageConsentProtocol(),
      original = t.retention.seed;
    const before = await readConsentEvidence(original.idempotencyKey, "ISSUANCE");
    const retried = await protocol.issue(
      {
        ...original,
        issuedAt: new Date(Date.now() + 3600000),
        expiresAt: new Date(Date.now() + 5400000),
      },
      t.retention.intent,
    );
    expect(retried).toEqual(original);
    expect((await readConsentEvidence(original.idempotencyKey, "ISSUANCE"))?.contentHash).toBe(
      before?.contentHash,
    );
    await expect(
      protocol.issue(original, {
        ...t.retention.intent,
        expectedRevision: t.retention.intent.expectedRevision + 1,
      }),
    ).rejects.toThrow();
    expect(await PackageConsentEvidenceModel.countDocuments({ phase: "ISSUANCE" })).toBe(1);
  });
  it("genuine ownership admits an authenticated P2D lifecycle action through the real proof boundary", async () => {
    const t = await fixture(),
      full = await t.writer.complete(t.scope);
    const services = {
      authority: t.authority,
      tokens: t.tokens,
      users: new UserRepository(),
      staff: new StaffRepository(),
      management: t.booking,
      operations: new PackageLifecycleOperations(),
      availability: t.availability,
      lifecycle: new PackageLifecycleService(
        t.availability,
        t.reservations,
        t.booking,
        () => INTERNAL_TIME,
      ),
    } satisfies PackageLifecycleHttpServices;
    const app = express();
    app.use(express.json());
    app.use(
      createAuthenticateAccessTokenMiddleware(t.tokens, new UserRepository()),
      requireActiveUser(),
    );
    app.post(
      "/package-views/actions/:action",
      asyncHandler(new PackageLifecycleHttpController(services, () => INTERNAL_TIME).execute),
    );
    app.use(createErrorHandler({ isProduction: true }));
    const result = await httpRequest(app)
      .post("/package-views/actions/expire")
      .set("Authorization", t.authorization)
      .send({
        businessId: String(t.scope.businessId),
        packageProgressId: String(full.progress._id),
        key: randomUUID(),
      })
      .expect(200);
    expect(result.body.data.state).toBe("COMMITTED");
    expect(await readPackagePurchaseCompletion(full.progress)).toBe("VERIFIED");
    expect(await BookingModel.countDocuments()).toBe(full.bookings.length);
  });

  it("6B certified purchase supports HTTP redemption, move, cancellation and exact replay", async () => {
    const t = await fixture(false, 0);
    const full = await t.writer.complete(t.scope);
    const initial = full.bookings[0];
    const item = full.progress.items[0];
    if (!initial || !item || !initial.serviceLines[0]) throw Error("missing purchase fixture");
    const services = {
      authority: t.authority,
      tokens: t.tokens,
      users: new UserRepository(),
      staff: new StaffRepository(),
      management: t.booking,
      operations: new PackageLifecycleOperations(),
      availability: t.availability,
      lifecycle: new PackageLifecycleService(
        t.availability,
        t.reservations,
        t.booking,
        () => INTERNAL_TIME,
      ),
    } satisfies PackageLifecycleHttpServices;
    const app = express();
    app.use(express.json());
    app.use(
      createAuthenticateAccessTokenMiddleware(t.tokens, new UserRepository()),
      requireActiveUser(),
    );
    app.post(
      "/package-views/actions/:action",
      asyncHandler(new PackageLifecycleHttpController(services, () => INTERNAL_TIME).execute),
    );
    app.use("/package-views", createPackageViewRoute());
    app.use("/me", createCustomerBookingRoute());
    app.use("/super-admin", createSuperAdminRoute());
    app.use("/businesses", createStaffScheduleRoute());
    app.use(createErrorHandler({ isProduction: true }));
    const post = (action: string, body: object, authorization = t.authorization) =>
      httpRequest(app)
        .post(`/package-views/actions/${action}`)
        .set("Authorization", authorization)
        .send(body);
    const base = {
      businessId: String(t.scope.businessId),
      packageProgressId: String(full.progress._id),
    };
    const startAt = new Date(initial.schedule.startAt.getTime() + 86400000);
    const redeem = {
      ...base,
      key: randomUUID(),
      packageItemId: String(item.packageItemId),
      staffMembershipId: String(initial.serviceLines[0].responsibleStaffMembershipId),
      startAt,
    };
    const other = await UserModel.create({
      normalizedEmail: "foreign-6b@example.test",
      passwordHash: "unused",
      role: "CUSTOMER",
      status: "ACTIVE",
      security: { passwordUpdatedAt: new Date() },
    });
    const foreign = `Bearer ${await issueTestAccessToken(t.tokens, { userId: other._id, role: "CUSTOMER" })}`;
    await post("redeem", redeem, foreign).expect(404);
    await post("redeem", { ...redeem, businessId: String(new Types.ObjectId()) }).expect(404);
    const baselineReservations = await BookingSlotReservationModel.find().lean();
    const reserve = t.reservations.reserveOrJoin.bind(t.reservations);
    const failedReserve = vi
      .spyOn(t.reservations, "reserveOrJoin")
      .mockImplementationOnce(async (...args) => {
        await reserve(...args);
        throw Error("synthetic post-reservation failure");
      });
    await post("redeem", { ...redeem, key: randomUUID() }).expect(500);
    failedReserve.mockRestore();
    expect(await BookingSlotReservationModel.find().lean()).toEqual(baselineReservations);
    expect(await BookingModel.countDocuments()).toBe(full.bookings.length);
    expect(
      (await PackageProgressV2Model.findById(full.progress._id).orFail()).items[0]
        ?.remainingSessions,
    ).toBe(item.remainingSessions);
    const created = await post("redeem", redeem).expect(200);
    const replay = await post("redeem", redeem).expect(200);
    expect(replay.body.data.bookingId).toBe(created.body.data.bookingId);
    const bookingId = created.body.data.bookingId as string;
    await httpRequest(app)
      .get(`/package-views/owned/${full.progress._id}`)
      .set("Authorization", t.authorization)
      .expect(200);
    await httpRequest(app)
      .get(`/package-views/owned/${full.progress._id}`)
      .set("Authorization", foreign)
      .expect(404);
    const customerBooking = await httpRequest(app)
      .get(`/me/bookings/${bookingId}`)
      .set("Authorization", t.authorization)
      .expect(200);
    expect(customerBooking.body.data.id).toBe(bookingId);
    await httpRequest(app)
      .get(`/me/bookings/${bookingId}`)
      .set("Authorization", foreign)
      .expect(404);
    const admin = await UserModel.create({
      normalizedEmail: `admin-${randomUUID()}@example.test`,
      passwordHash: "unused",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
      security: { passwordUpdatedAt: new Date() },
    });
    const adminToken = `Bearer ${await issueTestAccessToken(t.tokens, { userId: admin._id, role: "SUPER_ADMIN" })}`;
    const adminBooking = await httpRequest(app)
      .get(`/super-admin/bookings/${bookingId}`)
      .set("Authorization", adminToken)
      .expect(200);
    expect(adminBooking.body.data.businessId).toBe(String(t.scope.businessId));
    const owner = await UserModel.create({
      _id: t.f.business.ownerUserId,
      normalizedEmail: `owner-${randomUUID()}@example.test`,
      passwordHash: "unused",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      security: { passwordUpdatedAt: new Date() },
    });
    const supervisor = await UserModel.create({
      normalizedEmail: `supervisor-${randomUUID()}@example.test`,
      passwordHash: "unused",
      role: "SUPERVISOR",
      status: "ACTIVE",
      security: { passwordUpdatedAt: new Date() },
    });
    await new StaffRepository().create({
      userId: supervisor._id,
      businessId: t.scope.businessId,
      role: "SUPERVISOR",
      createdByUserId: owner._id,
    });
    const ownerToken = `Bearer ${await issueTestAccessToken(t.tokens, { userId: owner._id, role: "BUSINESS_OWNER" })}`;
    const supervisorToken = `Bearer ${await issueTestAccessToken(t.tokens, { userId: supervisor._id, role: "SUPERVISOR" })}`;
    const settlementUrl = `/package-views/settlement/${t.scope.businessId}/${bookingId}`;
    for (const authorization of [ownerToken, supervisorToken]) {
      const view = await httpRequest(app)
        .get(settlementUrl)
        .set("Authorization", authorization)
        .expect(200);
      expect(view.body.data.packageProgressId).toBe(String(full.progress._id));
      expect(view.body.data.session.bookingId).toBe(bookingId);
      if (authorization === ownerToken) {
        expect(view.body.data).toHaveProperty("purchaseFinancials");
        expect(view.body.data).toHaveProperty("payments");
      } else {
        for (const field of ["purchaseFinancials", "payments", "operations", "historyLimit"])
          expect(view.body.data).not.toHaveProperty(field);
        expect(view.body.data.session.booking).not.toHaveProperty("outstandingBalanceCents");
      }
    }
    await httpRequest(app)
      .get(`/package-views/owned/${full.progress._id}`)
      .set("Authorization", supervisorToken)
      .expect(403);
    await httpRequest(app)
      .post("/package-views/actions/redeem")
      .set("Authorization", supervisorToken)
      .send(redeem)
      .expect(403);
    const assignedId = initial.serviceLines[0]?.responsibleStaffMembershipId;
    const assigned = t.f.providers.find((provider) => provider._id.equals(assignedId));
    if (assigned?.role !== "STAFF") throw Error("expected assigned staff");
    await UserModel.create({
      _id: assigned.userId,
      normalizedEmail: `staff-${randomUUID()}@example.test`,
      passwordHash: "unused",
      role: "STAFF",
      status: "ACTIVE",
      security: { passwordUpdatedAt: new Date() },
    });
    const staffToken = `Bearer ${await issueTestAccessToken(t.tokens, { userId: assigned.userId, role: "STAFF" })}`;
    const staffRead = await httpRequest(app)
      .get(`/businesses/${t.scope.businessId}/staff/me/appointments/${bookingId}`)
      .set("Authorization", staffToken)
      .expect(200);
    expect(staffRead.body.data.services).toHaveLength(1);
    expect(JSON.stringify(staffRead.body.data)).not.toMatch(
      /financials|amountCents|purchaseFinancials|paymentIntent/,
    );
    const consumed = await PackageProgressV2Model.findById(full.progress._id).orFail();
    expect(consumed.items[0]?.remainingSessions).toBe(item.remainingSessions - 1);
    expect(consumed.sessions.length).toBe(full.progress.sessions.length + 1);
    const hasSlot = async (at: Date) =>
      (await BookingSlotReservationModel.find().lean()).some((day) =>
        day.intervals.some((interval) => interval.startAt.getTime() === at.getTime()),
      );
    expect(await hasSlot(startAt)).toBe(true);
    const beforeMove = await BookingSlotReservationModel.find().lean();
    const moveAt = new Date(initial.schedule.startAt.getTime() + 3 * 86400000);
    const move = { ...base, key: randomUUID(), bookingId, startAt: moveAt };
    await post("reschedule", move).expect(200);
    await post("reschedule", move).expect(200);
    const moved = await BookingModel.findById(bookingId).orFail();
    expect(moved.schedule.startAt).toEqual(moveAt);
    expect(
      (await PackageProgressV2Model.findById(full.progress._id).orFail()).items[0]
        ?.remainingSessions,
    ).toBe(item.remainingSessions - 1);
    expect(await BookingSlotReservationModel.find().lean()).not.toEqual(beforeMove);
    expect(await hasSlot(startAt)).toBe(false);
    expect(await hasSlot(moveAt)).toBe(true);
    const cancel = { ...base, key: randomUUID(), bookingId };
    await post("cancel", cancel).expect(200);
    await post("cancel", cancel).expect(200);
    const final = await PackageProgressV2Model.findById(full.progress._id).orFail();
    expect(final.items[0]?.remainingSessions).toBe(item.remainingSessions);
    expect((await BookingModel.findById(bookingId).orFail()).status).toBe("CANCELLED_BY_CUSTOMER");
    expect(await hasSlot(moveAt)).toBe(false);
    expect(await BookingModel.countDocuments()).toBe(full.bookings.length + 1);
    expect(await PaymentAttemptModel.countDocuments()).toBe(0);
  });

  it("3.7F supervisor cancellation exposes only operational outcome with persisted purchase and refund records", async () => {
    const t = await fixture(true);
    const operationId = t.scope.idempotencyKey.split(":").at(-1);
    if (!operationId) throw Error("missing operation");
    const purchased = await new PackagePurchaseService(t.authority, t.writer).complete(
      t.authorization,
      t.scope.businessId,
      operationId,
    );
    if (purchased.state !== "COMPLETE") throw Error("expected certified purchase");
    const [supervisorBooking, ownerBooking] = purchased.bookingIds;
    if (!supervisorBooking || !ownerBooking) throw Error("expected two package bookings");
    const progress = await PackageProgressV2Model.findById(purchased.packageProgressId).orFail();
    const attempt = await PaymentAttemptModel.findOne({ packageProgressId: progress._id }).orFail();
    if (!attempt.providerPaymentIntentId) throw Error("missing synthetic payment intent");
    const refund = await RefundOperationModel.create({
      logicalIdempotencyKey: `synthetic-history-${randomUUID()}`,
      sourcePaymentAttemptId: attempt._id,
      sourcePaymentIntentId: attempt.providerPaymentIntentId,
      bookingId: supervisorBooking,
      packageProgressId: progress._id,
      businessId: t.scope.businessId,
      customerUserId: progress.customerUserId,
      businessClientId: progress.businessClientId,
      expectedRefundAmountCents: 123,
      currency: "EUR",
      reason: "synthetic historical refund",
      providerStatus: "SUCCEEDED",
    });
    const owner = await UserModel.create({
      _id: t.f.business.ownerUserId,
      normalizedEmail: `owner-${randomUUID()}@example.test`,
      passwordHash: "unused",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
      security: { passwordUpdatedAt: new Date() },
    });
    const supervisor = await UserModel.create({
      normalizedEmail: `supervisor-${randomUUID()}@example.test`,
      passwordHash: "unused",
      role: "SUPERVISOR",
      status: "ACTIVE",
      security: { passwordUpdatedAt: new Date() },
    });
    await new StaffRepository().create({
      userId: supervisor._id,
      businessId: t.scope.businessId,
      role: "SUPERVISOR",
      createdByUserId: owner._id,
    });
    const services = {
      authority: t.authority,
      tokens: t.tokens,
      users: new UserRepository(),
      staff: new StaffRepository(),
      management: t.booking,
      operations: new PackageLifecycleOperations(),
      availability: t.availability,
      lifecycle: new PackageLifecycleService(
        t.availability,
        t.reservations,
        t.booking,
        () => INTERNAL_TIME,
      ),
    } satisfies PackageLifecycleHttpServices;
    const app = express();
    app.use(express.json());
    app.use(
      createAuthenticateAccessTokenMiddleware(t.tokens, new UserRepository()),
      requireActiveUser(),
    );
    app.post(
      "/package-views/actions/:action",
      asyncHandler(new PackageLifecycleHttpController(services, () => INTERNAL_TIME).execute),
    );
    app.use(createErrorHandler({ isProduction: true }));
    const base = {
      businessId: String(t.scope.businessId),
      packageProgressId: String(progress._id),
    };
    const cancel = async (
      actor: typeof supervisor,
      role: "SUPERVISOR" | "BUSINESS_OWNER",
      bookingId: string,
    ) =>
      httpRequest(app)
        .post("/package-views/actions/cancel")
        .set(
          "Authorization",
          `Bearer ${await issueTestAccessToken(t.tokens, { userId: actor._id, role })}`,
        )
        .send({ ...base, bookingId, key: randomUUID() })
        .expect(200);
    const ledgerBefore = await BookingFinancialTransactionModel.find().lean();
    const response = await cancel(supervisor, "SUPERVISOR", supervisorBooking);
    expect(response.body.data).toMatchObject({
      state: "COMMITTED",
      status: "CANCELLED_BY_BUSINESS",
      bookingId: supervisorBooking,
    });
    expect(Object.keys(response.body.data).sort()).toEqual(
      ["bookingId", "committedAt", "endAt", "startAt", "state", "status"].sort(),
    );
    expect(JSON.stringify(response.body)).not.toMatch(
      /refund|payment|amount|settlement|provider/iu,
    );
    expect((await BookingModel.findById(supervisorBooking).orFail()).status).toBe(
      "CANCELLED_BY_BUSINESS",
    );
    const afterCancel = await PackageProgressV2Model.findById(progress._id).orFail();
    expect(
      afterCancel.sessions.find((session) => String(session.bookingId) === supervisorBooking)
        ?.status,
    ).toBe("CANCELLED");
    expect(await PaymentAttemptModel.findById(attempt._id).lean()).toEqual(attempt.toObject());
    expect(await RefundOperationModel.findById(refund._id).lean()).toEqual(refund.toObject());
    expect(await BookingFinancialTransactionModel.find().lean()).toEqual(ledgerBefore);
    const ownerResponse = await cancel(owner, "BUSINESS_OWNER", ownerBooking);
    expect(ownerResponse.body.data).toMatchObject({
      state: "COMMITTED",
      status: "CANCELLED_BY_BUSINESS",
    });
    expect(Object.keys(ownerResponse.body.data).sort()).toEqual(
      Object.keys(response.body.data).sort(),
    );
  });

  it("6B concurrent last-credit redemptions on certified purchase commit only one booking", async () => {
    const t = await fixture(false, 0);
    const full = await t.writer.complete(t.scope);
    const first = full.bookings[0];
    const item = full.progress.items[0];
    if (!first || !item || !first.serviceLines[0]) throw Error("missing purchase fixture");
    const staffId = first.serviceLines[0].responsibleStaffMembershipId;
    const lifecycle = new PackageLifecycleService(
      t.availability,
      t.reservations,
      t.booking,
      () => INTERNAL_TIME,
    );
    const redeem = (day: number) =>
      lifecycle.customer(t.scope.customer, {
        key: `6b:${randomUUID()}`,
        action: "REDEEM",
        businessId: t.scope.businessId,
        businessClientId: t.scope.businessClientId,
        packageProgressId: full.progress._id,
        packageItemId: item.packageItemId,
        staffMembershipId: staffId,
        startAt: new Date(first.schedule.startAt.getTime() + day * 86400000),
      });
    for (let day = 1; day < item.remainingSessions; day++) await redeem(day);
    const before = await BookingModel.countDocuments();
    const results = await Promise.allSettled([redeem(8), redeem(9)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await BookingModel.countDocuments()).toBe(before + 1);
    expect(
      (await PackageProgressV2Model.findById(full.progress._id).orFail()).items[0]
        ?.remainingSessions,
    ).toBe(0);
  });
  it.each([0, 1])(
    "post-commit bound at deadline+%ims cannot certify or imply a late commit",
    async (extra) => {
      const deadline = Date.parse("2030-08-19T08:30:00Z") + extra;
      vi.mocked(observeConsentHost)
        .mockImplementationOnce(async (w) => syntheticHostObservation(w))
        .mockImplementationOnce(async (w) =>
          syntheticHostObservation(w, { earliestMs: deadline - 1, latestMs: deadline }),
        );
      await expect(packageBatchFixture({ certifiedConsent: true })).rejects.toThrow();
      expect(await PackageConsentEvidenceModel.countDocuments({ phase: "CERTIFICATION" })).toBe(0);
      expect(await PaymentAttemptModel.countDocuments()).toBe(0);
    },
  );
  it("clock reboot between issuance and observation quarantines the exact committed acceptance", async () => {
    vi.mocked(observeConsentHost)
      .mockImplementationOnce(async (w) => syntheticHostObservation(w))
      .mockImplementationOnce(async (w) =>
        syntheticHostObservation(w, { bootId: "bbbb1111-1111-4111-8111-111111111111" }),
      );
    await expect(packageBatchFixture({ certifiedConsent: true })).rejects.toThrow();
    expect(await PackageConsentEvidenceModel.countDocuments({ phase: "CERTIFICATION" })).toBe(0);
  });
  it("session expiry at the trusted post-commit bound cannot satisfy commit-time validity", async () => {
    await expect(
      packageBatchFixture({
        certifiedConsent: true,
        beforeConsentCommit: async () => {
          await SessionModel.updateOne(
            { revokedAt: { $exists: false } },
            { $set: { expiresAt: new Date(Date.now() + 1) } },
          );
        },
      }),
    ).rejects.toThrow();
    // C can be durable, but strict post-time equality with expiry cannot certify it.
    expect((await BookingCreationClaimModel.findOne())?.packageCheckoutAcceptance).toBeTruthy();
    expect(await PackageConsentEvidenceModel.countDocuments({ phase: "CERTIFICATION" })).toBe(0);
  });
  it("link/archive ABA advances generation and prevents any F2 charge", async () => {
    const t = await fixture(true),
      clients = new ClientRepository();
    await clients.archiveById(t.scope.businessId, t.scope.businessClientId);
    await clients.restoreById(t.scope.businessId, t.scope.businessClientId);
    await expect(t.writer.complete(t.scope)).rejects.toThrow("continuity");
    expect(t.gateway.paymentIntentInputs).toHaveLength(0);
    expect(await BookingModel.countDocuments()).toBe(0);
  });
  it("same-row unlink/relink never resets the original generation", async () => {
    const t = await fixture(true),
      clients = new ClientRepository();
    await clients.setLinkState(t.scope.businessClientId, { linkState: "UNLINKED" });
    await clients.setLinkState(t.scope.businessClientId, {
      linkState: "LINKED",
      linkedUserId: t.f.context.customerUserId,
    });
    expect((await BusinessClientModel.findById(t.scope.businessClientId))?.linkGeneration).toBe(2);
    await expect(t.writer.complete(t.scope)).rejects.toThrow();
    expect(t.gateway.paymentIntentInputs).toHaveLength(0);
  });
  it("certified historical acceptance survives later logout but a new request cannot authenticate that revoked family", async () => {
    const t = await fixture();
    const claim = await BookingCreationClaimModel.findOne().orFail(),
      record = await readConsentEvidence(claim.idempotencyKey, "ACCEPTANCE");
    if (!record || record.payload.phase !== "ACCEPTANCE") throw Error("required acceptance");
    await new SessionRepository().revokeFamily(record.payload.sessionFamilyId);
    await expect(t.authority.authenticate(t.authorization)).rejects.toThrow();
    await expect(verifyCertifiedPackageConsent(claim.toObject())).resolves.toBeTruthy();
  });
  it("raw evidence tampering cannot authorize a genuine completion", async () => {
    const t = await fixture();
    await PackageConsentEvidenceModel.collection.updateOne(
      { phase: "CERTIFICATION" },
      { $set: { "payload.deadlineMs": Date.now() + 999999999 } },
    );
    await expect(t.writer.complete(t.scope)).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(0);
  });
  it("generic generation reset and evidence deletion are denied", async () => {
    const t = await fixture();
    await expect(
      BusinessClientModel.updateOne(
        { _id: t.scope.businessClientId },
        { $set: { linkGeneration: 0 } },
      ),
    ).rejects.toThrow("model-owned");
    await expect(PackageConsentEvidenceModel.deleteMany({})).rejects.toThrow();
    const before = await PackageConsentEvidenceModel.countDocuments();
    expect(before).toBe(4);
  });
  it.each(["logout", "expired-session", "revoked-user", "unlink", "archive"])(
    "%s before acceptance prevents C and certification",
    async (mode) => {
      await expect(
        packageBatchFixture({
          certifiedConsent: true,
          beforeConsentCommit: async () => {
            const live = await SessionModel.findOne().orFail();
            if (mode === "logout") await new SessionRepository().revokeFamily(live.tokenFamilyId);
            else if (mode === "expired-session")
              await SessionModel.updateOne(
                { _id: live._id },
                { $set: { expiresAt: new Date(Date.now() - 1) } },
              );
            else if (mode === "revoked-user")
              await UserModel.updateOne({ _id: live.userId }, { $set: { status: "DELETED" } });
            else {
              const client = await BusinessClientModel.findOne().orFail(),
                repo = new ClientRepository();
              if (mode === "unlink") await repo.setLinkState(client._id, { linkState: "UNLINKED" });
              else await repo.archiveById(client.businessId, client._id);
            }
          },
        }),
      ).rejects.toThrow();
      expect(
        (await BookingCreationClaimModel.findOne())?.packageCheckoutAcceptance,
      ).toBeUndefined();
      expect(await PackageConsentEvidenceModel.countDocuments({ phase: "CERTIFICATION" })).toBe(0);
    },
  );
  it("failed majority observation never obtains post-commit time; recovery reuses original C", async () => {
    // A failed observation is injected after C via the evidence reader, leaving raw records
    // unchanged. No clock sample can be used as proof until a positive M is recovered.
    const evidence = await import("../../../src/modules/booking/package-consent-evidence.js");
    const read = evidence.readConsentEvidence;
    let refuse = true;
    vi.spyOn(evidence, "readConsentEvidence").mockImplementation(async (key, phase, session) => {
      if (phase === "ACCEPTANCE" && !session && refuse) {
        refuse = false;
        throw new mongoose.mongo.MongoServerError({ message: "synthetic majority-read outage" });
      }
      return read(key, phase, session);
    });
    await expect(packageBatchFixture({ certifiedConsent: true })).rejects.toThrow(
      "synthetic majority-read outage",
    );
    expect(observeConsentHost).toHaveBeenCalledTimes(1);
    const claim = await BookingCreationClaimModel.findOne().orFail();
    await new PackageConsentProtocol().certify(claim.idempotencyKey);
    expect(observeConsentHost).toHaveBeenCalledTimes(2);
    await expect(verifyCertifiedPackageConsent(claim.toObject())).resolves.toBeTruthy();
  });
  it("duplicate certification/recovery retains one exact immutable decision", async () => {
    const t = await fixture(),
      key = t.scope.idempotencyKey;
    const before = await readConsentEvidence(key, "CERTIFICATION");
    await Promise.all([
      new PackageConsentProtocol().certify(key),
      new PackageConsentProtocol().certify(key),
    ]);
    expect((await readConsentEvidence(key, "CERTIFICATION"))?.contentHash).toBe(
      before?.contentHash,
    );
    expect(await PackageConsentEvidenceModel.countDocuments({ operationKey: key })).toBe(4);
  });
  it("lost majority commit acknowledgement recovers the original accepted event without recommitting", async () => {
    await expect(
      packageBatchFixture({
        certifiedConsent: true,
        beforeConsentCommit: async () => {
          const start = mongoose.startSession.bind(mongoose);
          vi.spyOn(mongoose, "startSession").mockImplementationOnce(async () => {
            const session = await start(),
              commit = session.commitTransaction.bind(session);
            vi.spyOn(session, "commitTransaction").mockImplementationOnce(async () => {
              await commit();
              throw new mongoose.mongo.MongoServerError({
                message: "synthetic lost commit acknowledgement",
              });
            });
            return session;
          });
        },
      }),
    ).rejects.toThrow("synthetic lost commit acknowledgement");
    const claim = await BookingCreationClaimModel.findOne().orFail();
    const accepted = claim.packageCheckoutAcceptance;
    expect(accepted).toBeTruthy();
    expect(await readConsentEvidence(claim.idempotencyKey, "ACCEPTANCE")).toBeTruthy();
    expect(await readConsentEvidence(claim.idempotencyKey, "CERTIFICATION")).toBeNull();
    await new PackageConsentProtocol().certify(claim.idempotencyKey);
    expect(
      (await BookingCreationClaimModel.findById(claim._id))?.packageCheckoutAcceptance,
    ).toEqual(accepted);
    await expect(verifyCertifiedPackageConsent(claim.toObject())).resolves.toBeTruthy();
    expect(await PaymentAttemptModel.countDocuments()).toBe(0);
  });
  it.each(["session", "client"])(
    "%s invalidation after the transaction snapshot conflicts with the acceptance fence",
    async (mode) => {
      await expect(
        packageBatchFixture({
          certifiedConsent: true,
          beforeConsentCommit: async () => {
            if (mode === "session") {
              const update = SessionModel.findOneAndUpdate.bind(SessionModel);
              vi.spyOn(SessionModel, "findOneAndUpdate").mockImplementationOnce((...args) => {
                // The User fence already established this transaction's snapshot. Invalidate
                // the shared session row before its physical write, forcing a write conflict.
                return (async () => {
                  const live = await SessionModel.findOne().orFail();
                  await new SessionRepository().revokeFamily(live.tokenFamilyId);
                  return update(...args);
                })() as never;
              });
            } else {
              const update = BusinessClientModel.findOneAndUpdate.bind(BusinessClientModel);
              vi.spyOn(BusinessClientModel, "findOneAndUpdate").mockImplementationOnce(
                (...args) => {
                  return (async () => {
                    const row = await BusinessClientModel.findOne().orFail();
                    // Use updateOne to avoid reentering the intercepted query method.
                    await BusinessClientModel.updateOne(
                      { _id: row._id },
                      { $set: { archivedAt: new Date() } },
                    );
                    return update(...args);
                  })() as never;
                },
              );
            }
          },
        }),
      ).rejects.toThrow();
      expect(
        (await BookingCreationClaimModel.findOne())?.packageCheckoutAcceptance,
      ).toBeUndefined();
      expect(await PackageConsentEvidenceModel.countDocuments({ phase: "ACCEPTANCE" })).toBe(0);
      expect(await PackageConsentEvidenceModel.countDocuments({ phase: "CERTIFICATION" })).toBe(0);
    },
  );
  it("genuine 3DS resumes its original attempt and commits version-2 evidence only after payment", async () => {
    const t = await fixture(true);
    t.gateway.queueNextChargeOutcome("requires_action");
    await expect(t.writer.complete(t.scope)).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(0);
    const attempt = await PaymentAttemptModel.findOne().orFail();
    expect(attempt.providerStatus).toBe("REQUIRES_ACTION");
    if (!attempt.providerPaymentIntentId) throw Error("expected original synthetic PI");
    t.gateway.succeedPaymentIntent(attempt.providerPaymentIntentId);
    const complete = await t.writer.complete(t.scope);
    expect(complete.completion.version).toBe(2);
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
    expect(await readPackagePurchaseCompletion(complete.progress)).toBe("VERIFIED");
  });

  it("6A purchase service binds real certified consent, persists entitlements and replays one paid purchase", async () => {
    const t = await fixture(true);
    const service = new PackagePurchaseService(t.authority, t.writer);
    const operationId = t.scope.idempotencyKey.split(":").at(-1)!;
    const claim = await BookingCreationClaimModel.findOne().orFail();
    const certificate = await verifyCertifiedPackageConsent(claim.toObject());
    expect(certificate.certificateId).toBeDefined();
    expect(
      await PackageConsentEvidenceModel.countDocuments({
        operationKey: t.scope.idempotencyKey,
        phase: "CERTIFICATION",
      }),
    ).toBe(1);
    const first = await service.complete(t.authorization, t.scope.businessId, operationId);
    const replay = await service.complete(t.authorization, t.scope.businessId, operationId);
    expect(first.state).toBe("COMPLETE");
    expect(replay).toEqual(first);
    if (first.state !== "COMPLETE") throw Error("expected verified purchase");
    const progress = await PackageProgressV2Model.findById(first.packageProgressId).orFail();
    expect(String(progress.businessId)).toBe(String(t.scope.businessId));
    expect(String(progress.customerUserId)).toBe(String(t.f.context.customerUserId));
    expect(progress.items.length).toBeGreaterThan(0);
    expect(
      progress.items.every(
        (item) =>
          item.totalSessions > 0 &&
          item.remainingSessions >= 0 &&
          item.remainingSessions <= item.totalSessions,
      ),
    ).toBe(true);
    expect(await PackageProgressV2Model.countDocuments()).toBe(1);
    expect(await BookingModel.countDocuments()).toBe(first.bookingIds.length);
    expect(await PaymentAttemptModel.countDocuments()).toBe(1);
    expect(t.gateway.createdPaymentIntentIds()).toHaveLength(1);
    expect(t.gateway.paymentIntentInputs[0]?.amountCents).toBe(
      t.quote.payload.financials.requiredUpfrontCents,
    );
    expect(progress.purchaseSnapshot.bundlePriceCents).toBe(
      t.quote.payload.financials.bundlePriceCents,
    );
    expect((await PaymentAttemptModel.findOne().orFail()).providerStatus).toBe("SUCCEEDED");
  });

  it("6A repeated payment callback cannot duplicate a certified purchase", async () => {
    const t = await fixture(true);
    const operationId = t.scope.idempotencyKey.split(":").at(-1);
    if (!operationId) throw Error("missing operation ID");
    const purchase = await new PackagePurchaseService(t.authority, t.writer).complete(
      t.authorization,
      t.scope.businessId,
      operationId,
    );
    expect(purchase.state).toBe("COMPLETE");
    const attempt = await PaymentAttemptModel.findOne().orFail();
    if (!attempt.providerPaymentIntentId) throw Error("missing fake payment intent");
    const source = await t.gateway.retrievePaymentIntent(attempt.providerPaymentIntentId);
    const webhook = new StripeWebhookService(
      t.gateway,
      new StripeWebhookEventRepository(),
      new BookingFinancialTransactionService(new BookingFinancialTransactionRepository()),
      undefined,
      t.attempts,
      t.refunds,
      undefined,
      new BookingRepository(),
      t.relationships,
    );
    const event = {
      id: "evt_6a_duplicate",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: source.paymentIntentId,
          amount: source.amountCents,
          currency: "eur",
          customer: source.customerId,
          metadata: source.metadata,
        },
      },
    };
    expect(await Reflect.apply(webhook.process, webhook, [event])).toBe(true);
    expect(await Reflect.apply(webhook.process, webhook, [event])).toBe(false);
    expect(await PackageProgressV2Model.countDocuments()).toBe(1);
    expect(await PaymentAttemptModel.countDocuments()).toBe(1);
    if (purchase.state === "COMPLETE")
      expect(await BookingModel.countDocuments()).toBe(purchase.bookingIds.length);
  });

  it.each(["requires_action", "failed"] as const)(
    "6A %s payment remains unissued at the purchase service boundary",
    async (outcome) => {
      const t = await fixture(true);
      t.gateway.queueNextChargeOutcome(outcome);
      const service = new PackagePurchaseService(t.authority, t.writer);
      const operationId = t.scope.idempotencyKey.split(":").at(-1)!;
      const result = await service.complete(t.authorization, t.scope.businessId, operationId);
      expect(result.state).toBe("PAYMENT_PENDING");
      if (result.state !== "PAYMENT_PENDING") throw Error("expected pending purchase");
      expect(result.providerStatus).toBe(outcome === "failed" ? "FAILED" : "REQUIRES_ACTION");
      expect(await PackageProgressV2Model.countDocuments()).toBe(0);
      expect(await BookingModel.countDocuments()).toBe(0);
      expect(await PaymentAttemptModel.countDocuments()).toBe(1);
      expect(t.gateway.createdPaymentIntentIds()).toHaveLength(1);
    },
  );

  it("6A foreign customer and business cannot use a certified purchase operation", async () => {
    const t = await fixture(true);
    const service = new PackagePurchaseService(t.authority, t.writer);
    const operationId = t.scope.idempotencyKey.split(":").at(-1)!;
    const other = await UserModel.create({
      normalizedEmail: "foreign-6a@example.test",
      passwordHash: "unused",
      role: "CUSTOMER",
      status: "ACTIVE",
      security: { passwordUpdatedAt: new Date() },
    });
    const foreign = `Bearer ${await issueTestAccessToken(t.tokens, { userId: other._id, role: "CUSTOMER" })}`;
    await expect(service.complete(foreign, t.scope.businessId, operationId)).rejects.toThrow();
    await expect(
      service.complete(t.authorization, new Types.ObjectId(), operationId),
    ).rejects.toThrow();
    expect(await PackageProgressV2Model.countDocuments()).toBe(0);
    expect(await PaymentAttemptModel.countDocuments()).toBe(0);
    expect(t.gateway.createdPaymentIntentIds()).toHaveLength(0);
  });

  it.each(["missing", "tampered", "wrong-package"] as const)(
    "6A %s certification cannot initiate payment or issue entitlements",
    async (mode) => {
      const t = await fixture(true);
      const service = new PackagePurchaseService(t.authority, t.writer);
      const operationId = t.scope.idempotencyKey.split(":").at(-1);
      if (!operationId) throw Error("missing operation ID");
      if (mode === "missing") {
        await PackageConsentEvidenceModel.collection.deleteOne({
          operationKey: t.scope.idempotencyKey,
          phase: "CERTIFICATION",
        });
      } else if (mode === "tampered") {
        await PackageConsentEvidenceModel.collection.updateOne(
          { operationKey: t.scope.idempotencyKey, phase: "CERTIFICATION" },
          { $set: { "payload.deadlineMs": Date.now() + 999999999 } },
        );
      } else {
        await BookingCreationClaimModel.collection.updateOne(
          { idempotencyKey: t.scope.idempotencyKey },
          { $set: { "packageCheckoutAcceptance.packageId": new Types.ObjectId() } },
        );
      }
      await expect(
        service.complete(t.authorization, t.scope.businessId, operationId),
      ).rejects.toThrow();
      expect(await PaymentAttemptModel.countDocuments()).toBe(0);
      expect(await PackageProgressV2Model.countDocuments()).toBe(0);
      expect(await BookingModel.countDocuments()).toBe(0);
      expect(t.gateway.createdPaymentIntentIds()).toHaveLength(0);
    },
  );

  it("P4F pending purchase status retains original certification and link-generation fences before revealing 3DS recovery", async () => {
    const t = await fixture(true);
    t.gateway.queueNextChargeOutcome("requires_action");
    await expect(t.writer.complete(t.scope)).rejects.toThrow();
    const complete = vi.fn();
    const service = new PackagePurchaseService(t.authority, { complete });
    const operationId = t.scope.idempotencyKey.split(":").at(-1)!;
    const pending = await service.status(t.authorization, t.scope.businessId, operationId);
    expect(pending.state).toBe("PAYMENT_PENDING");
    expect(pending).toHaveProperty("clientSecret");
    const clients = new ClientRepository();
    await clients.setLinkState(t.scope.businessClientId, { linkState: "UNLINKED" });
    await clients.setLinkState(t.scope.businessClientId, {
      linkState: "LINKED",
      linkedUserId: t.f.context.customerUserId,
    });
    // Same row and Customer are now linked again, but the original generation is invalid.
    await expect(
      service.status(t.authorization, t.scope.businessId, operationId),
    ).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
    expect(await BookingModel.countDocuments()).toBe(0);
  });

  it.each(["archived", "unlinked"])(
    "P4F %s relationship cannot retrieve pending purchase recovery state",
    async (mode) => {
      const t = await fixture(true);
      t.gateway.queueNextChargeOutcome("requires_action");
      await expect(t.writer.complete(t.scope)).rejects.toThrow();
      if (mode === "archived")
        await BusinessClientModel.updateOne(
          { _id: t.scope.businessClientId },
          { $set: { archivedAt: new Date() } },
        );
      else
        await new ClientRepository().setLinkState(t.scope.businessClientId, {
          linkState: "UNLINKED",
        });
      const complete = vi.fn();
      const service = new PackagePurchaseService(t.authority, { complete });
      await expect(
        service.status(
          t.authorization,
          t.scope.businessId,
          t.scope.idempotencyKey.split(":").at(-1)!,
        ),
      ).rejects.toThrow();
      expect(complete).not.toHaveBeenCalled();
      expect(t.gateway.paymentIntentInputs).toHaveLength(1);
    },
  );
  it("unknown provider result does not create entitlement, then recovers one genuine purchase", async () => {
    const t = await fixture(true);
    t.gateway.queueNextChargeLostResponse();
    await expect(t.writer.complete(t.scope)).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(0);
    const result = await t.writer.complete(t.scope);
    expect(result.completion.version).toBe(2);
    expect(t.gateway.paymentIntentInputs).toHaveLength(1);
  });
  it("genuine last-slot contenders retain exactly one complete atomic package", async () => {
    const t = await fixture();
    const other = await t.another(false, false, randomUUID());
    const results = await Promise.allSettled([
      t.writer.complete(t.scope),
      t.writer.complete(other.scope),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await PackageProgressV2Model.countDocuments()).toBe(1);
    expect(await BookingModel.countDocuments()).toBe(2);
    expect(await PackageConsentEvidenceModel.countDocuments({ phase: "CERTIFICATION" })).toBe(2);
  });
  it("rollback after payment creates no genuine completion and keeps compensation pending", async () => {
    const outbox = await import("../../../src/modules/email-outbox/email-outbox.repository.js");
    const t = await fixture(true);
    t.gateway.queueNextRefundOutcome("pending");
    vi.spyOn(outbox.EmailOutboxRepository.prototype, "enqueue").mockRejectedValueOnce(
      Error("synthetic parent abort"),
    );
    await expect(t.writer.complete(t.scope)).rejects.toThrow();
    expect(await BookingModel.countDocuments()).toBe(0);
    expect(await PackageProgressV2Model.countDocuments()).toBe(0);
    expect((await BookingCreationClaimModel.findOne())?.packageBatchCompletion).toBeUndefined();
    expect((await PaymentAttemptModel.findOne())?.compensationStatus).not.toBe("REFUNDED");
  });
});
