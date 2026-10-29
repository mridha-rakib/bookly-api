import { randomUUID } from "node:crypto";
import express from "express";
import mongoose from "mongoose";
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
import { BusinessClientModel } from "../../../src/modules/client/client.model.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { createFinancialRelationshipService } from "../../../src/modules/client/financial-relationship.factory.js";
import { PackageProgressV2Model } from "../../../src/modules/package-progress/package-progress-v2.model.js";
import { readPackagePurchaseCompletion } from "../../../src/modules/package-progress/package-view.service.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { PaymentAttemptModel } from "../../../src/modules/payment/payment-attempt.model.js";
import { PaymentAttemptRepository } from "../../../src/modules/payment/payment-attempt.repository.js";
import { RefundOperationRepository } from "../../../src/modules/payment/refund-operation.repository.js";
import { SessionModel } from "../../../src/modules/session/session.model.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { UserModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
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
  async function fixture(first = false) {
    const t = await packageBatchFixture({
      certifiedConsent: true,
      operationId: randomUUID(),
      first,
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
    return { ...t, writer, gateway };
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
