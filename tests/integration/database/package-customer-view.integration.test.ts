import express from "express";
import mongoose, { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BusinessModel } from "../../../src/modules/business/business.model.js";
import { PackageProgressV2Model } from "../../../src/modules/package-progress/package-progress-v2.model.js";
import { createPackageViewRoute } from "../../../src/modules/package-progress/package-view.route.js";
import { PackageModel } from "../../../src/modules/packages/package.model.js";
import { PaymentAttemptModel } from "../../../src/modules/payment/payment-attempt.model.js";
import { ServiceCategoryRepository } from "../../../src/modules/services/service-category.repository.js";
import { StaffMembershipModel } from "../../../src/modules/staff/staff.model.js";
import { UserModel } from "../../../src/modules/user/user.model.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import { packageBatchFixture } from "../../helpers/package-batch-fixture.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

// Only this isolated persistence fixture can materialize records. Shipped routes have no grant.
vi.mock("../../../src/modules/booking/package-batch-authority.js", () => ({
  verifyPackageBatchActivation: vi.fn(async () => undefined),
}));
describe("S6 authenticated customer/management transport with disposable records", () => {
  const app = express();
  app.use(express.json());
  app.use("/package-views", createPackageViewRoute());
  app.use(createErrorHandler({ isProduction: true }));
  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120000);
  beforeEach(clearIsolatedDatabase);
  afterAll(stopIsolatedReplicaSet);
  async function fixture(populated = false) {
    const t = await packageBatchFixture({ count: 2, bundlePriceCents: 0, group: true });
    const category = await new ServiceCategoryRepository().create({
      businessId: t.f.business._id,
      name: "S6",
      nameKey: "s6",
    });
    t.f.business.set("subcategories", ["F1"]);
    await t.f.business.save();
    t.f.definition.set("serviceCategoryId", category._id);
    await t.f.definition.save();
    if (populated) await t.writer.materialize(t.scope);
    return t;
  }
  async function other(
    t: Awaited<ReturnType<typeof fixture>>,
    role: "CUSTOMER" | "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF",
    id = new Types.ObjectId(),
  ) {
    await UserModel.create({
      _id: id,
      normalizedEmail: `${id}@s6.test`,
      role,
      status: "ACTIVE",
      security: { passwordUpdatedAt: new Date() },
    });
    return `Bearer ${await issueTestAccessToken(t.tokens, { userId: id, role })}`;
  }
  it("A01/A02/A06: published eligible details include quantities and one-seat data; drafts stay hidden", async () => {
    const t = await fixture();
    const base = `/package-views/catalog/${t.f.business._id}`;
    const response = await request(app).get(base).set("Authorization", t.authorization).expect(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body.data.packages).toHaveLength(1);
    expect(response.body.data.packages[0].checkoutAvailable).toBe(false);
    expect(
      response.body.data.packages[0].items.some(
        (i: { group?: { partySize: number } }) => i.group?.partySize === 1,
      ),
    ).toBe(true);
    await PackageModel.updateOne({ _id: t.f.definition._id }, { $set: { status: "DRAFT" } });
    await request(app)
      .get(`${base}/${t.f.definition._id}`)
      .set("Authorization", t.authorization)
      .expect(404);
  });
  it("A02: inactive dependency hides an active definition", async () => {
    const t = await fixture();
    await BusinessModel.updateOne({ _id: t.f.business._id }, { $set: { status: "SUSPENDED" } });
    await request(app)
      .get(`/package-views/catalog/${t.f.business._id}`)
      .set("Authorization", t.authorization)
      .expect(404);
  });
  it("A03: cross-customer progress cannot be enumerated", async () => {
    const t = await fixture(true);
    const progress = await PackageProgressV2Model.findOne().orFail();
    await request(app)
      .get(`/package-views/owned/${progress._id}`)
      .set("Authorization", await other(t, "CUSTOMER"))
      .expect(404);
  });
  it("S6-FINAL inconsistent stored accounting fails safely for both owned reads", async () => {
    const t = await fixture(true);
    const progress = await PackageProgressV2Model.findOne().orFail();
    // Negative integrity fixture only, inside this owned disposable database.
    await PackageProgressV2Model.collection.updateOne(
      { _id: progress._id },
      { $inc: { "items.0.totalSessions": 1 } },
    );
    for (const url of ["/package-views/owned", `/package-views/owned/${progress._id}`]) {
      const response = await request(app)
        .get(url)
        .set("Authorization", t.authorization)
        .expect(409);
      expect(JSON.stringify(response.body)).toContain("PACKAGE_ACCOUNTING_UNAVAILABLE");
      expect(response.body.data).toBeUndefined();
    }
  });
  it("A04/A05/A07/A08/A17: authoritative accounting, original membership and separate safe financial DTO", async () => {
    const t = await fixture(true);
    const progress = await PackageProgressV2Model.findOne().orFail();
    const response = await request(app)
      .get(`/package-views/owned/${progress._id}`)
      .set("Authorization", t.authorization)
      .expect(200);
    const dto = response.body.data.packages[0];
    expect(dto.items.reduce((n: number, i: { scheduled: number }) => n + i.scheduled, 0)).toBe(2);
    expect(
      dto.sessions.every((s: { booking: { role: string } }) => s.booking.role === "PURCHASE"),
    ).toBe(true);
    expect(dto.purchaseFinancials).toHaveProperty("outstandingBalanceCents");
    expect(dto.sessions[0].booking).toHaveProperty("travelFeeCents");
    for (const forbidden of [
      "challenge",
      "sessionFamilyId",
      "paymentIntentId",
      "clientSecret",
      "intentHash",
      "acceptance",
    ])
      expect(JSON.stringify(dto)).not.toContain(forbidden);
    // Corrupt nested tenant association cannot disclose its Booking, even under owned Progress.
    await BookingModel.collection.updateOne(
      { _id: progress.sessions[0]!.bookingId },
      { $set: { businessId: new Types.ObjectId() } },
    );
    const masked = await request(app)
      .get(`/package-views/owned/${progress._id}`)
      .set("Authorization", t.authorization)
      .expect(200);
    expect(masked.body.data.packages[0].sessions[0].booking).toBeNull();
  });
  it("A09/A10: current persisted Owner can read settlement; Staff and foreign Owner cannot", async () => {
    const t = await fixture(true);
    const booking = await BookingModel.findOne().orFail();
    const url = `/package-views/settlement/${booking.businessId}/${booking._id}`;
    const owner = await other(t, "BUSINESS_OWNER", t.f.business.ownerUserId);
    expect(
      (await request(app).get(url).set("Authorization", owner).expect(200)).body.data
        .actionsAvailable,
    ).toBe(false);
    await request(app)
      .get(url)
      .set("Authorization", await other(t, "STAFF"))
      .expect(403);
    await request(app)
      .get(url)
      .set("Authorization", await other(t, "BUSINESS_OWNER"))
      .expect(403);
    await request(app)
      .get(`/package-views/settlement/${new Types.ObjectId()}/${booking._id}`)
      .set("Authorization", owner)
      .expect(403);
  });
  it("A12/A16: actions deny before any booking/progress/payment effects; identity fields rejected", async () => {
    const t = await fixture();
    for (const action of ["purchase", "consent", "redeem", "reschedule", "cancel", "settlement"]) {
      const res = await request(app)
        .post(`/package-views/actions/${action}`)
        .set("Authorization", t.authorization)
        .send({})
        .expect(503);
      expect(res.body.errors[0].code).toBe("PACKAGE_BATCH_ACTIVATION_UNAVAILABLE");
    }
    await request(app)
      .post("/package-views/actions/purchase")
      .set("Authorization", t.authorization)
      .send({ customerUserId: String(t.f.context.customerUserId) })
      .expect(400);
    expect(await BookingModel.countDocuments()).toBe(0);
    expect(await PackageProgressV2Model.countDocuments()).toBe(0);
    expect(await PaymentAttemptModel.countDocuments()).toBe(0);
  });
  it("persisted Supervisor membership is required and revocation takes effect", async () => {
    const t = await fixture(true);
    const booking = await BookingModel.findOne().orFail();
    const membership = t.f.providers.find((p) => p.role === "SUPERVISOR");
    if (!membership) throw Error("Missing supervisor fixture");
    const bearer = await other(t, "SUPERVISOR", membership.userId);
    const url = `/package-views/settlement/${booking.businessId}/${booking._id}`;
    await request(app).get(url).set("Authorization", bearer).expect(200);
    await StaffMembershipModel.updateOne(
      { _id: membership._id },
      { $set: { employmentActive: false } },
    );
    await request(app).get(url).set("Authorization", bearer).expect(403);
  });
  it("safe payment projection distinguishes action-required and unknown without secrets or foreign money", async () => {
    const t = await fixture(true);
    const progress = await PackageProgressV2Model.findOne().orFail();
    const scope = {
      businessId: progress.businessId,
      businessClientId: progress.businessClientId,
      customerUserId: progress.customerUserId,
      packageProgressId: progress._id,
    };
    const binding = {
      businessId: String(scope.businessId),
      businessClientId: String(scope.businessClientId),
      customerUserId: String(scope.customerUserId),
      packageProgressId: String(scope.packageProgressId),
      kind: "SESSION_DUES",
    };
    for (const providerStatus of ["REQUIRES_ACTION", "UNKNOWN"])
      await PaymentAttemptModel.collection.insertOne({
        ...scope,
        logicalIdempotencyKey: `s6-projection-${providerStatus}`,
        purpose: "PACKAGE_LIFECYCLE_MONEY",
        packageLifecycleBinding: binding,
        expectedAmountCents: 1700,
        currency: "EUR",
        providerStatus,
        persistenceStatus: "PERSISTING",
        compensationStatus: "NOT_REQUIRED",
        clientSecret: "sensitive-secret",
        providerPaymentIntentId: `sensitive-provider-id-${providerStatus}`,
      });
    await PaymentAttemptModel.collection.insertOne({
      ...scope,
      logicalIdempotencyKey: "s6-projection-foreign",
      customerUserId: new Types.ObjectId(),
      purpose: "PACKAGE_LIFECYCLE_MONEY",
      packageLifecycleBinding: binding,
      expectedAmountCents: 99999,
    });
    const response = await request(app)
      .get(`/package-views/owned/${progress._id}`)
      .set("Authorization", t.authorization)
      .expect(200);
    expect(
      response.body.data.packages[0].payments
        .map((p: { providerState: string }) => p.providerState)
        .sort(),
    ).toEqual(["REQUIRES_ACTION", "UNKNOWN"]);
    expect(JSON.stringify(response.body)).not.toContain("sensitive");
    expect(JSON.stringify(response.body)).not.toContain("99999");
  });
  it("A14/A15/A17: unknown receipts and payment states never become success or disclose control tokens", async () => {
    const t = await fixture(true);
    const progress = await PackageProgressV2Model.findOne().orFail();
    await mongoose.connection.collection("packagelifecycleoperations").insertOne({
      intent: {
        businessId: progress.businessId,
        customerUserId: progress.customerUserId,
        businessClientId: progress.businessClientId,
        packageProgressId: progress._id,
        action: "REDEEM",
      },
      phase: "PERSISTING",
      token: "secret-cas",
      result: { status: "fake-success" },
    });
    const response = await request(app)
      .get(`/package-views/owned/${progress._id}`)
      .set("Authorization", t.authorization)
      .expect(200);
    expect(response.body.data.packages[0].operations[0].resultStatus).toBeNull();
    expect(JSON.stringify(response.body)).not.toContain("secret-cas");
    expect(JSON.stringify(response.body)).not.toContain("fake-success");
  });
  it("real JWT/live family required; empty list is honest; malformed ids and posted identities fail", async () => {
    const t = await fixture();
    await request(app).get("/package-views/owned").expect(401);
    await request(app)
      .get("/package-views/owned")
      .set("Authorization", "Bearer invalid")
      .expect(401);
    const empty = await request(app)
      .get("/package-views/owned")
      .set("Authorization", t.authorization)
      .expect(200);
    expect(empty.body.data.packages).toEqual([]);
    await request(app)
      .get("/package-views/owned/not-an-id")
      .set("Authorization", t.authorization)
      .expect(400);
    await request(app)
      .get("/package-views/owned?customerUserId=forged")
      .set("Authorization", t.authorization)
      .expect(400);
  });
  it("session acceptance is displayed only for the exact owned quote without exposing evidence", async () => {
    const t = await fixture(true);
    const progress = await PackageProgressV2Model.findOne().orFail();
    const quoteId = new Types.ObjectId();
    const common = {
      quoteId,
      termsHash: "a".repeat(64),
      disclosureHash: "b".repeat(64),
      sessionFamilyId: "private-family",
    };
    const acceptedAt = new Date("2030-08-19T08:02:00Z");
    await mongoose.connection.collection("packagelifecycleoperations").insertOne({
      intent: {
        businessId: progress.businessId,
        customerUserId: progress.customerUserId,
        businessClientId: progress.businessClientId,
        packageProgressId: progress._id,
        action: "REDEEM",
      },
      phase: "PREPARED",
      sessionQuote: {
        ...common,
        disclosure: "Exact independent session terms",
        terms: { totalCents: 1700 },
      },
      sessionAcceptance: {
        ...common,
        customerUserId: progress.customerUserId,
        acceptedAt,
        action: "ACCEPT_SESSION_DUES",
      },
    });
    const url = `/package-views/owned/${progress._id}`;
    const accepted = await request(app).get(url).set("Authorization", t.authorization).expect(200);
    expect(accepted.body.data.packages[0].operations[0].sessionAcceptanceRecordedAt).toBe(
      acceptedAt.toISOString(),
    );
    expect(JSON.stringify(accepted.body)).not.toContain("private-family");
    await mongoose.connection
      .collection("packagelifecycleoperations")
      .updateOne({}, { $set: { "sessionAcceptance.quoteId": new Types.ObjectId() } });
    const changed = await request(app).get(url).set("Authorization", t.authorization).expect(200);
    expect(changed.body.data.packages[0].operations[0].sessionAcceptanceRecordedAt).toBeNull();
  });
});
