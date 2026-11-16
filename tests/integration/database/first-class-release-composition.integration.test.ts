import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import { verifyPackageBatchActivation } from "../../../src/modules/booking/package-batch-authority.js";
import { PackageBatchFinancialPersistence } from "../../../src/modules/booking/package-batch-financial-persistence.js";
import { readPackageCheckoutReadiness } from "../../../src/modules/booking/package-checkout-availability.js";
import { createPackageConsentRoute } from "../../../src/modules/booking/package-consent.route.js";
import { PackagePurchaseService } from "../../../src/modules/booking/package-purchase.service.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { createFinancialRelationshipService } from "../../../src/modules/client/financial-relationship.factory.js";
import { PackageProgressV2Model } from "../../../src/modules/package-progress/package-progress-v2.model.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { PaymentAttemptRepository } from "../../../src/modules/payment/payment-attempt.repository.js";
import { RefundOperationRepository } from "../../../src/modules/payment/refund-operation.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { syntheticHostObservation } from "../../helpers/consent-host-fixture.js";
import { FakePaymentGateway } from "../../helpers/fake-payment-gateway.js";
import { syntheticAuthority } from "../../helpers/first-class-authority-fixture.js";
import { INTERNAL_TIME, packageBatchFixture } from "../../helpers/package-batch-fixture.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

// Only operating-system inputs are synthetic: the root-provisioned authority files, the
// API's own boot/artifact observation and the protected audit key. The deployment-attestation
// verifier, Ed25519 release verification, approved readers, host registry, consent protocol,
// certificate, payment service and purchase transaction are all the shipped modules.
const authority = vi.hoisted(() => ({
  state: { liveOverride: undefined as undefined | Record<string, Buffer> },
}));
vi.mock(
  "../../../src/modules/booking/trusted-time/protected-authority-files.js",
  async (original) => {
    const { syntheticAuthority } = await import("../../helpers/first-class-authority-fixture.js");
    return {
      ...(await original<object>()),
      readFirstClassAuthorityFiles: (_directory: string, names?: string[]) => {
        const files = { ...syntheticAuthority.files, ...authority.state.liveOverride };
        return names
          ? Object.fromEntries(names.map((name) => [name, files[name as keyof typeof files]]))
          : files;
      },
      observeRunningArtifact: () => syntheticAuthority.observed,
    };
  },
);
vi.mock("../../../src/modules/booking/trusted-time/file-audit-key-resolver.js", async () => {
  const { SYNTHETIC_KEY_ROOT } = await import("../../helpers/first-class-authority-fixture.js");
  const { syntheticConsentHost } = await import("../../helpers/consent-host-fixture.js");
  return {
    createFileAuditKeyResolver: (root: string, group: number) => {
      if (root !== SYNTHETIC_KEY_ROOT || group !== 4242) throw new Error("unexpected key root");
      return () => Buffer.from(syntheticConsentHost.auditKey);
    },
  };
});
vi.mock("../../../src/modules/booking/trusted-time/require-qualified-linux-boot.js", () => ({
  requireQualifiedLinuxBoot: async () => undefined,
}));
vi.mock("../../../src/modules/booking/trusted-time/host-clock.js", async (original) => ({
  ...(await original<object>()),
  observeConsentHost: async (witness: string) => syntheticHostObservation(witness),
}));

describe("synthetic deployment authority through actual readers, gates and purchase", () => {
  beforeAll(connectIsolatedDatabase, 120000);
  beforeEach(async () => {
    await clearIsolatedDatabase();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(INTERNAL_TIME);
  });
  afterEach(() => {
    vi.useRealTimers();
    authority.state.liveOverride = undefined;
  });
  afterAll(stopIsolatedReplicaSet);

  async function preparePurchase() {
    const operationId = randomUUID();
    const t = await packageBatchFixture({ certifiedConsent: true, operationId, first: true });
    const attempts = new PaymentAttemptRepository(),
      refunds = new RefundOperationRepository();
    const profiles = new CustomerPaymentProfileRepository(),
      gateway = new FakePaymentGateway();
    await profiles.createIfMissing(t.f.context.customerUserId, "cus_synthetic_release");
    await profiles.savePaymentMethod({
      userId: t.f.context.customerUserId,
      defaultPaymentMethodId: "pm_synthetic_release",
      cardBrand: "visa",
      cardLast4: "4242",
      cardExpMonth: 12,
      cardExpYear: 2035,
    });
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
    const service = new PackagePurchaseService(t.authority, writer);
    return { t, writer, service, gateway, operationId };
  }

  it("certifies consent and issues a paid purchase exactly once on replay", async () => {
    await expect(readPackageCheckoutReadiness()).resolves.toEqual({
      available: true,
      reason: null,
    });
    const app = express();
    app.use("/consent", createPackageConsentRoute());
    app.use(createErrorHandler({ isProduction: true }));
    expect((await request(app).get("/consent/anything")).status).toBe(401);
    const { t, service, gateway, operationId } = await preparePurchase();
    const first = await service.complete(t.authorization, t.scope.businessId, operationId);
    const replay = await service.complete(t.authorization, t.scope.businessId, operationId);
    expect(first.state).toBe("COMPLETE");
    expect(replay).toEqual(first);
    expect(await PackageProgressV2Model.countDocuments()).toBe(1);
    expect(await BookingModel.countDocuments()).toBeGreaterThan(0);
    expect(gateway.createdPaymentIntentIds()).toHaveLength(1);
  });

  it("never issues a package for a failed provider charge", async () => {
    const { t, writer, gateway } = await preparePurchase();
    gateway.queueNextChargeOutcome("failed");
    await expect(writer.complete(t.scope)).rejects.toThrow();
    expect(await PackageProgressV2Model.countDocuments()).toBe(0);
    expect(await BookingModel.countDocuments()).toBe(0);
    expect(gateway.createdPaymentIntentIds()).toHaveLength(1);
  });

  it("resumes a pending payment on its original attempt", async () => {
    const { t, writer, gateway } = await preparePurchase();
    gateway.queueNextChargeOutcome("requires_action");
    await expect(writer.complete(t.scope)).rejects.toThrow();
    expect(await PackageProgressV2Model.countDocuments()).toBe(0);
    const [paymentIntentId] = gateway.createdPaymentIntentIds();
    if (!paymentIntentId) throw new Error("missing synthetic payment intent");
    gateway.succeedPaymentIntent(paymentIntentId);
    const complete = await writer.complete(t.scope);
    expect(complete.completion.version).toBe(2);
    expect(await PackageProgressV2Model.countDocuments()).toBe(1);
    expect(gateway.createdPaymentIntentIds()).toHaveLength(1);
  });

  it("concurrent retries cannot create duplicate charges or packages", async () => {
    const { t, service, gateway, operationId } = await preparePurchase();
    const results = await Promise.allSettled([
      service.complete(t.authorization, t.scope.businessId, operationId),
      service.complete(t.authorization, t.scope.businessId, operationId),
    ]);
    const winner = results.find((result) => result.status === "fulfilled");
    expect(winner?.status).toBe("fulfilled");
    expect(await PackageProgressV2Model.countDocuments()).toBe(1);
    expect(gateway.createdPaymentIntentIds()).toHaveLength(1);
  });
  it("all four gates close together on expiry, tampering or rollback, and reopen on renewal", async () => {
    const { t, service, gateway, operationId } = await preparePurchase();
    const app = express();
    app.use("/consent", createPackageConsentRoute());
    app.use(createErrorHandler({ isProduction: true }));
    const closed = async () => {
      await expect(readPackageCheckoutReadiness()).resolves.toMatchObject({ available: false });
      await expect(verifyPackageBatchActivation()).rejects.toMatchObject({
        code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE",
      });
      const response = await request(app).get("/consent/anything");
      expect(response.status).toBe(503);
      expect(JSON.stringify(response.body)).toContain("PACKAGE_CONSENT_UNAVAILABLE");
    };
    vi.setSystemTime(syntheticAuthority.expiresAtMs);
    await closed();
    vi.setSystemTime(INTERNAL_TIME);
    authority.state.liveOverride = {
      attestationSignature: Buffer.alloc(64),
    };
    await closed();
    authority.state.liveOverride = syntheticAuthority.renewed;
    await expect(readPackageCheckoutReadiness()).resolves.toEqual({
      available: true,
      reason: null,
    });
    // The startup attestation (lower sequence) may not be replayed after renewal.
    authority.state.liveOverride = undefined;
    await closed();
    // Purchase authority is re-checked at completion time.
    await expect(
      service.complete(t.authorization, t.scope.businessId, operationId),
    ).rejects.toBeDefined();
    expect(await PackageProgressV2Model.countDocuments()).toBe(0);
    expect(gateway.createdPaymentIntentIds()).toHaveLength(0);
  });
});
