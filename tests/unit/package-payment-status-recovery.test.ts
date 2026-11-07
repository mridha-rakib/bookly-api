import { Types } from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PackagePurchaseService } from "../../src/modules/booking/package-purchase.service.js";
import { verifyPackagePurchaseConsentCertification } from "../../src/modules/booking/package-purchase-authority.js";
import type { PaymentService } from "../../src/modules/payment/payment.service.js";
import { PaymentAttemptModel } from "../../src/modules/payment/payment-attempt.model.js";

vi.mock("../../src/modules/booking/package-batch-authority.js", () => ({
  verifyPackageBatchActivation: vi.fn(async () => undefined),
}));
vi.mock("../../src/modules/booking/package-batch-completion.js", () => ({
  readOwnedPackageBatchCompletion: vi.fn(async () => undefined),
}));
vi.mock("../../src/modules/booking/package-purchase-authority.js", () => ({
  verifyPackagePurchaseConsentCertification: vi.fn(async () => undefined),
}));
vi.mock("../../src/modules/payment/payment-batch-binding.js", () => ({
  assertPaymentBatchBinding: (attempt: { packageBatchBinding: unknown }) =>
    attempt.packageBatchBinding,
}));
afterEach(() => vi.restoreAllMocks());

function fixture(providerStatus: string) {
  const businessId = new Types.ObjectId(),
    customerId = new Types.ObjectId();
  const operationId = "original-operation";
  const scope = { businessId, businessClientId: new Types.ObjectId() };
  const preparation = {
    batchId: new Types.ObjectId(),
    termsHash: "original-terms",
    acceptanceId: new Types.ObjectId(),
    packageProgressId: new Types.ObjectId(),
    originBookingId: new Types.ObjectId(),
  };
  const row = {
    _id: new Types.ObjectId(),
    actorUserId: customerId,
    packageBatchPreparation: preparation,
  };
  const canonical = {
    quote: { quoteId: new Types.ObjectId(), issuedAt: 100, expiresAt: 1800100 },
    retention: { quote: { termsHash: "original-terms" } },
    accepted: { disclosureHash: "original-disclosure" },
  };
  const binding = {
    version: 1,
    claimId: String(row._id),
    batchId: String(preparation.batchId),
    quoteId: String(canonical.quote.quoteId),
    termsHash: preparation.termsHash,
    acceptanceId: String(preparation.acceptanceId),
    packageProgressId: String(preparation.packageProgressId),
    originBookingId: String(preparation.originBookingId),
    businessId: String(businessId),
    customerUserId: String(customerId),
    businessClientId: String(scope.businessClientId),
  };
  const attempt = {
    _id: new Types.ObjectId(),
    packageBatchBinding: binding,
    providerPaymentIntentId: "pi_original",
    providerStatus: "REQUIRES_ACTION",
    clientSecret: "stale_secret",
    compensationStatus: "NOT_REQUIRED",
    persistenceStatus: "NOT_STARTED",
  };
  const query = { select: () => query, read: () => query, maxTimeMS: async () => attempt };
  vi.spyOn(PaymentAttemptModel, "findOne").mockReturnValue(query as never);
  const payments = {
    reconcilePaymentAttempt: vi.fn(async () => ({
      attempt: { ...attempt, providerStatus },
      snapshot: { clientSecret: "original_secret" },
    })),
  };
  const service = new PackagePurchaseService(
    {} as never,
    {} as never,
    payments as unknown as Pick<PaymentService, "reconcilePaymentAttempt">,
  );
  // Authorization/retained-quote loading is exercised separately by the production gate tests.
  vi.spyOn(service as unknown as { owned: () => Promise<unknown> }, "owned").mockResolvedValue({
    row,
    canonical,
    scope,
  });
  return { service, payments, attempt, businessId, operationId, canonical };
}

describe("First-Class original-payment status recovery", () => {
  it.each(["REQUIRES_ACTION", "PROCESSING", "SUCCEEDED"])(
    "refreshes %s while retaining the original consent and unconfirmed purchase",
    async (status) => {
      const f = fixture(status);
      const result = await f.service.status("original-session", f.businessId, f.operationId);
      expect(f.payments.reconcilePaymentAttempt).toHaveBeenCalledExactlyOnceWith(f.attempt._id);
      expect(result).toMatchObject({
        operationId: f.operationId,
        quoteId: String(f.canonical.quote.quoteId),
        issuedAt: 100,
        expiresAt: 1800100,
        termsHash: "original-terms",
        disclosureHash: "original-disclosure",
        state: "PAYMENT_PENDING",
        providerStatus: status,
        canStartNewQuote: false,
      });
      expect("clientSecret" in result ? result.clientSecret : undefined).toBe(
        status === "REQUIRES_ACTION" ? "original_secret" : undefined,
      );
    },
  );

  it("keeps the consent certification fence before provider access", async () => {
    const f = fixture("PROCESSING");
    vi.mocked(verifyPackagePurchaseConsentCertification).mockRejectedValueOnce(
      new Error("Consent denied"),
    );
    await expect(f.service.status("other-session", f.businessId, f.operationId)).rejects.toThrow(
      "Consent denied",
    );
    expect(f.payments.reconcilePaymentAttempt).not.toHaveBeenCalled();
  });
});
