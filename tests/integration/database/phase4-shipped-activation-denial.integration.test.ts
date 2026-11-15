/**
 * Phase 4.0 — ACTUAL shipped First-Class activation composition against a disposable replica set.
 *
 * Unlike the conditional 6A/6B suites, this file substitutes NO activation, consent-host,
 * historical-verifier or Consent HTTP module. The only mock is the external Stripe client
 * boundary, which must never be reached. It proves that the real mounted routes and services
 * deny every First-Class purchase/checkout entry point and leave the database unchanged.
 * It is NOT evidence of activation readiness.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import mongoose, { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import {
  BookingCreationClaimModel,
  claimInternalPackageBatch,
  prepareInternalPackageBatch,
} from "../../../src/modules/booking/booking-creation-claim.model.js";
import { PackageBatchActivationUnavailableError } from "../../../src/modules/booking/package-batch-authority.js";
import { createPackageConsentRoute } from "../../../src/modules/booking/package-consent.route.js";
import { verifyPackagePurchaseConsentCertification } from "../../../src/modules/booking/package-purchase-authority.js";
import { buildPackagePurchaseService } from "../../../src/modules/booking/package-purchase-http.js";
import { createPackageViewRoute } from "../../../src/modules/package-progress/package-view.route.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { getStripeClient } from "../../../src/modules/payment/stripe-client.js";
import { StripePaymentGateway } from "../../../src/modules/payment/stripe-payment-gateway.js";
import { ServiceCategoryRepository } from "../../../src/modules/services/service-category.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { packageBatchFixture } from "../../helpers/package-batch-fixture.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

// External provider boundary only. Any call is a test failure, never a real request.
vi.mock("../../../src/modules/payment/stripe-client.js", () => ({
  getStripeClient: vi.fn(() => {
    throw new Error("Stripe must not be reached by a denied First-Class operation");
  }),
}));

type Snapshot = Record<string, number>;
const snapshot = async (): Promise<Snapshot> => {
  const db = mongoose.connection.db;
  if (!db) throw Error("Disposable database not connected");
  const rows: Snapshot = {};
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray())
    rows[name] = await db.collection(name).countDocuments();
  return Object.fromEntries(Object.entries(rows).sort(([a], [b]) => a.localeCompare(b)));
};
const claimState = async () =>
  JSON.stringify(await BookingCreationClaimModel.find().sort({ _id: 1 }).lean());

describe("Phase 4.0 actual shipped composition denies First-Class activation", () => {
  const app = express();
  app.use(express.json());
  app.use("/package-views", createPackageViewRoute());
  app.use("/package-consent", createPackageConsentRoute());
  app.use(createErrorHandler({ isProduction: true }));
  let databaseName = "";

  beforeAll(async () => {
    databaseName = await connectIsolatedDatabase();
  }, 120000);
  beforeEach(async () => {
    await clearIsolatedDatabase();
    vi.mocked(getStripeClient).mockClear();
  });
  afterAll(stopIsolatedReplicaSet);

  it("runs only against a disposable loopback replica set with a random database", async () => {
    expect(databaseName).toMatch(/^bookly_auth_\d+_[a-f0-9]{32}$/);
    expect(databaseName).not.toBe("bookly_DB");
    expect(mongoose.connection.host).toBe("127.0.0.1");
    const hello = await mongoose.connection.db?.admin().command({ hello: 1 });
    expect(hello?.["setName"]).toBeTruthy();
  });

  it("mounted routes deny purchase, status, consent and checkout with no persisted change", async () => {
    const operationId = randomUUID();
    const t = await packageBatchFixture({ count: 2, bundlePriceCents: 4000, operationId });
    // Same catalogue eligibility setup as the existing S6 customer-view suite.
    const category = await new ServiceCategoryRepository().create({
      businessId: t.f.business._id,
      name: "Phase 4",
      nameKey: "phase-4",
    });
    t.f.business.set("subcategories", ["F1"]);
    await t.f.business.save();
    t.f.definition.set("serviceCategoryId", category._id);
    await t.f.definition.save();
    const businessId = String(t.f.business._id);
    const before = await snapshot();
    const claimsBefore = await claimState();
    expect(Object.keys(before).length).toBeGreaterThan(0);

    const catalogue = await request(app)
      .get(`/package-views/catalog/${businessId}`)
      .set("Authorization", t.authorization)
      .expect(200);
    expect(catalogue.body.data.packages.length).toBeGreaterThan(0);
    for (const offer of catalogue.body.data.packages) expect(offer.checkoutAvailable).toBe(false);

    // Duplicate submissions are part of the matrix: each is denied identically, none issues.
    for (const action of [
      "purchase",
      "purchase-status",
      "purchase",
      "consent",
      "purchase-status",
    ]) {
      const response = await request(app)
        .post(`/package-views/actions/${action}`)
        .set("Authorization", t.authorization)
        .send(action === "consent" ? {} : { businessId, operationId })
        .expect(503);
      expect(response.body.errors[0].code).toBe("PACKAGE_BATCH_ACTIVATION_UNAVAILABLE");
    }
    // Consent HTTP is gated before auth, composition, reads or writes on every path.
    for (const path of [
      "quotes",
      `operations/${operationId}`,
      `operations/${operationId}/accept`,
    ]) {
      for (const send of [
        () => request(app).post(`/package-consent/${businessId}/${path}`).send({}),
        () => request(app).get(`/package-consent/${businessId}/${path}`),
      ]) {
        const response = await send().set("Authorization", t.authorization).expect(404);
        expect(response.body.errors[0].code).toBe("PACKAGE_CONSENT_DISABLED");
      }
    }

    expect(await snapshot()).toEqual(before);
    expect(await claimState()).toBe(claimsBefore);
    expect(getStripeClient).not.toHaveBeenCalled();
  });

  it("service, persistence and payment entry points deny before any read, write or provider call", async () => {
    const operationId = randomUUID();
    const t = await packageBatchFixture({ count: 2, bundlePriceCents: 4000, operationId });
    const before = await snapshot();
    const claimsBefore = await claimState();
    const purchase = buildPackagePurchaseService();

    await expect(
      purchase.complete(t.authorization, t.f.business._id, operationId),
    ).rejects.toBeInstanceOf(PackageBatchActivationUnavailableError);
    await expect(
      purchase.status(t.authorization, t.f.business._id, operationId),
    ).rejects.toBeInstanceOf(PackageBatchActivationUnavailableError);
    await expect(prepareInternalPackageBatch(t.scope, new Date())).rejects.toBeInstanceOf(
      PackageBatchActivationUnavailableError,
    );
    await expect(claimInternalPackageBatch(t.scope, {} as never)).rejects.toBeInstanceOf(
      PackageBatchActivationUnavailableError,
    );
    // Accepted-but-uncertified consent cannot be promoted: the unqualified host denies first.
    await expect(verifyPackagePurchaseConsentCertification(t.scope)).rejects.toMatchObject({
      statusCode: 503,
      details: [expect.objectContaining({ code: "PACKAGE_CONSENT_HOST_UNQUALIFIED" })],
    });

    const profiles = new CustomerPaymentProfileRepository();
    const profileRead = vi.spyOn(profiles, "findByUserId");
    const payments = new PaymentService(new StripePaymentGateway(), profiles, new UserRepository());
    await expect(
      payments.chargeBookingDeposit({
        userId: t.f.context.customerUserId,
        amountCents: 4000,
        idempotencyKey: `phase4-${new Types.ObjectId()}`,
        metadata: {},
        packageBatchBinding: {} as never,
      }),
    ).rejects.toBeInstanceOf(PackageBatchActivationUnavailableError);
    await expect(payments.chargePackageLifecycle({} as never)).rejects.toBeInstanceOf(
      PackageBatchActivationUnavailableError,
    );
    expect(profileRead).not.toHaveBeenCalled();

    expect(await snapshot()).toEqual(before);
    expect(await claimState()).toBe(claimsBefore);
    expect(getStripeClient).not.toHaveBeenCalled();
  });
});
