import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { BookingCreationClaimModel } from "../../../src/modules/booking/booking-creation-claim.model.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import {
  PackageBatchActivationUnavailableError,
  verifyPackageBatchActivation,
} from "../../../src/modules/booking/package-batch-authority.js";
import { verifyBatchCompletion } from "../../../src/modules/booking/package-batch-completion.js";
import { PackageBatchFinancialPersistence } from "../../../src/modules/booking/package-batch-financial-persistence.js";
import { BusinessClientModel } from "../../../src/modules/client/client.model.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { FinancialRelationshipRepository } from "../../../src/modules/client/financial-relationship.repository.js";
import { FinancialRelationshipService } from "../../../src/modules/client/financial-relationship.service.js";
import { PackageProgressV2Model } from "../../../src/modules/package-progress/package-progress-v2.model.js";
import { createPackageViewRoute } from "../../../src/modules/package-progress/package-view.route.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { PaymentAttemptRepository } from "../../../src/modules/payment/payment-attempt.repository.js";
import { RefundOperationRepository } from "../../../src/modules/payment/refund-operation.repository.js";
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

/**
 * P2A — owned/settlement package views report `purchaseCompletion` from the same read-only
 * authority that gates REDEEM (`verifyBatchCompletion`). A V2 Progress written at internal
 * materialization is NOT a completed purchase and must never be presented as one.
 * Isolated disposable database; activation mocked ONLY for this engineering fixture (the
 * shipped gate is unchanged and still denies every write).
 */
vi.mock("../../../src/modules/booking/package-batch-authority.js", async (original) => ({
  ...(await original<object>()),
  verifyPackageBatchActivation: vi.fn(async () => undefined),
}));
// Permit existing synthetic F2 construction only; the public genuine-proof verifier remains
// real and must reject those rows in the assertions below.
vi.mock("../../../src/modules/booking/package-purchase-authority.js", async (original) => ({
  ...(await original<object>()),
  verifyPackagePurchaseConsentCertification: vi.fn(async () => undefined),
}));

describe("P2A purchase completion in package views", () => {
  const app = express();
  app.use(express.json());
  app.use("/package-views", createPackageViewRoute());
  app.use(createErrorHandler({ isProduction: true }));
  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120000);
  beforeEach(clearIsolatedDatabase);
  afterEach(() => vi.restoreAllMocks());
  afterAll(stopIsolatedReplicaSet);

  /** A RETURNING (€0 online) purchase, either only internally materialized or completed. */
  async function fixture(complete: boolean) {
    const t = await packageBatchFixture({ bundlePriceCents: 0 });
    await BusinessClientModel.updateOne(
      { _id: t.scope.businessClientId },
      { $set: { activatedAt: new Date("2026-01-01T00:00:00.000Z") } },
    );
    if (complete) {
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
      const payments = new PaymentService(
        new FakePaymentGateway(),
        new CustomerPaymentProfileRepository(),
        new UserRepository(),
        attempts,
        refunds,
      );
      // The fixture's quote lives at INTERNAL_TIME (2030); the real clock would be outside it.
      await new PackageBatchFinancialPersistence(
        t.writer,
        relationships,
        payments,
        () => INTERNAL_TIME,
      ).complete(t.scope);
    } else {
      await t.writer.materialize(t.scope);
    }
    const progress = await PackageProgressV2Model.findOne().orFail();
    return { t, progress };
  }

  const ownedViews = async (authorization: string, progressId: string) => {
    const list = await request(app)
      .get("/package-views/owned")
      .set("Authorization", authorization)
      .expect(200);
    const detail = await request(app)
      .get(`/package-views/owned/${progressId}`)
      .set("Authorization", authorization)
      .expect(200);
    return [list.body.data.packages[0], detail.body.data.packages[0]];
  };

  it("an internally materialized but commercially incomplete purchase is NOT_ESTABLISHED", async () => {
    const { t, progress } = await fixture(false);
    for (const view of await ownedViews(t.authorization, String(progress._id)))
      expect(view.purchaseCompletion).toBe("NOT_ESTABLISHED");
  });

  it("complete synthetic F2 evidence verifies internally but cannot establish genuine Customer ownership", async () => {
    const { t, progress } = await fixture(true);
    const claim = await BookingCreationClaimModel.findOne().orFail();
    const internal = await verifyBatchCompletion(claim);
    expect(internal.completion.activation).toBe("SYNTHETIC_AUTHORITY_NOT_PRODUCTION_CONSENT");
    for (const view of await ownedViews(t.authorization, String(progress._id)))
      expect(view.purchaseCompletion).toBe("NOT_ESTABLISHED");
  });

  it("a tampered completion proof fails closed to NOT_ESTABLISHED", async () => {
    const { t, progress } = await fixture(true);
    // Negative integrity fixture only (raw collection write inside the disposable database).
    await BookingCreationClaimModel.collection.updateOne(
      { "packageBatchPreparation.packageProgressId": progress._id },
      { $set: { "packageBatchCompletion.financeHash": "tampered" } },
    );
    for (const view of await ownedViews(t.authorization, String(progress._id)))
      expect(view.purchaseCompletion).toBe("NOT_ESTABLISHED");
  });

  it("a Progress without its originating claim is NOT_ESTABLISHED, never VERIFIED", async () => {
    const { t, progress } = await fixture(true);
    await BookingCreationClaimModel.collection.updateOne(
      { "packageBatchPreparation.packageProgressId": progress._id },
      { $set: { actorUserId: new mongoose.Types.ObjectId() } },
    );
    const list = await request(app)
      .get("/package-views/owned")
      .set("Authorization", t.authorization)
      .expect(200);
    expect(list.body.data.packages[0].purchaseCompletion).toBe("NOT_ESTABLISHED");
  });

  it("settlement view carries the same completion state for the business", async () => {
    for (const complete of [false, true]) {
      await clearIsolatedDatabase();
      const { t, progress } = await fixture(complete);
      await UserModel.create({
        _id: t.f.business.ownerUserId,
        normalizedEmail: `owner-${complete}@p2a.test`,
        role: "BUSINESS_OWNER",
        status: "ACTIVE",
        security: { passwordUpdatedAt: new Date() },
      });
      const owner = `Bearer ${await issueTestAccessToken(t.tokens, {
        userId: t.f.business.ownerUserId,
        role: "BUSINESS_OWNER",
      })}`;
      const booking = await BookingModel.findOne({
        "serviceLines.pricingInput.packageProgressId": progress._id,
      }).orFail();
      const response = await request(app)
        .get(`/package-views/settlement/${t.f.business._id}/${booking._id}`)
        .set("Authorization", owner)
        .expect(200);
      // Both internal-only and synthetic financially completed rows lack genuine authority.
      expect(response.body.data.purchaseCompletion).toBe("NOT_ESTABLISHED");
      expect(response.body.data.actionsAvailable).toBe(false);
    }
  });

  it("a database failure during verification is a 503, not a silent NOT_ESTABLISHED", async () => {
    const { t, progress } = await fixture(true);
    vi.spyOn(BookingCreationClaimModel, "findOne").mockImplementation(() => {
      throw new mongoose.mongo.MongoServerError({ message: "P2A synthetic outage" });
    });
    await request(app)
      .get(`/package-views/owned/${progress._id}`)
      .set("Authorization", t.authorization)
      .expect(503);
  });

  it("lifecycle actions stay denied by the shipped route regardless of completion", async () => {
    const { t } = await fixture(true);
    vi.mocked(verifyPackageBatchActivation).mockRejectedValueOnce(
      new PackageBatchActivationUnavailableError(),
    );
    await request(app)
      .post("/package-views/actions/redeem")
      .set("Authorization", t.authorization)
      .send({})
      .expect(503);
  });
});
