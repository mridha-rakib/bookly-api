import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import type { CustomerPaymentProfileRepository } from "../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../src/modules/payment/payment.service.js";
import type {
  PaymentGateway,
  PaymentIntentSnapshot,
} from "../../src/modules/payment/payment.types.js";
import type { PaymentAttemptDocument } from "../../src/modules/payment/payment-attempt.model.js";
import { PaymentAttemptModel } from "../../src/modules/payment/payment-attempt.model.js";
import { PaymentAttemptRepository } from "../../src/modules/payment/payment-attempt.repository.js";
import type { UserRepository } from "../../src/modules/user/user.repository.js";

function fixture(status: PaymentIntentSnapshot["status"] = "requires_action") {
  const attempt = {
    _id: new Types.ObjectId(),
    providerPaymentIntentId: "pi_original",
    providerCustomerId: "cus_original",
    expectedAmountCents: 2000,
    currency: "EUR",
    providerStatus: "REQUIRES_ACTION",
    persistenceStatus: "NOT_STARTED",
    compensationStatus: "NOT_REQUIRED",
    createdAt: new Date(Date.now() - 120_000),
  } as PaymentAttemptDocument;
  const snapshot: PaymentIntentSnapshot = {
    paymentIntentId: "pi_original",
    status,
    amountCents: 2000,
    amountRefundedCents: 0,
    currency: "eur",
    customerId: "cus_original",
    metadata: { booklyPaymentAttemptId: String(attempt._id) },
    clientSecret: "original_secret",
  };
  const retrieve = vi.fn(async () => ({ ...snapshot }));
  const cancel = vi.fn(async () => ({ ...snapshot, status: "canceled" as const }));
  const create = vi.fn();
  const repository = {
    findById: vi.fn(async () => attempt),
    recordProviderResult: vi.fn(async (_id, input) => Object.assign(attempt, input)),
  };
  const service = new PaymentService(
    {
      retrievePaymentIntent: retrieve,
      cancelPaymentIntent: cancel,
      createAndConfirmPaymentIntent: create,
    } as unknown as PaymentGateway,
    {} as CustomerPaymentProfileRepository,
    {} as UserRepository,
    repository as unknown as PaymentAttemptRepository,
  );
  return { attempt, snapshot, retrieve, cancel, create, repository, service };
}

describe("Original PaymentIntent authentication recovery", () => {
  it("recovers the original operation and secret without cancellation when policy is unset", async () => {
    const f = fixture();
    const result = await f.service.reconcileAuthenticationExpiry(f.attempt._id);
    expect(result.attempt._id).toEqual(f.attempt._id);
    expect(result.snapshot?.clientSecret).toBe("original_secret");
    expect(f.retrieve).toHaveBeenCalledWith("pi_original");
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });

  it.each(["succeeded", "processing", "failed", "canceled"] as const)(
    "never cancels an authoritative %s payment",
    async (status) => {
      const f = fixture(status);
      const result = await f.service.reconcileAuthenticationExpiry(f.attempt._id, 60_000);
      expect(result.snapshot?.status).toBe(status);
      expect(f.cancel).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
    },
  );

  it("cancels only the expired original intent and preserves its operation identity", async () => {
    const f = fixture();
    const first = await f.service.reconcileAuthenticationExpiry(f.attempt._id, 60_000);
    expect(first.attempt.providerStatus).toBe("CANCELED");
    expect(f.cancel).toHaveBeenCalledWith("pi_original");
    f.snapshot.status = "canceled";
    await f.service.reconcileAuthenticationExpiry(f.attempt._id, 60_000);
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.create).not.toHaveBeenCalled();
  });

  it("reconciles a concurrent authentication success after cancellation is rejected", async () => {
    const f = fixture();
    f.cancel.mockImplementation(async () => {
      f.snapshot.status = "succeeded";
      throw new Error("Intent already succeeded");
    });
    const result = await f.service.reconcileAuthenticationExpiry(f.attempt._id, 60_000);
    expect(result.attempt.providerStatus).toBe("SUCCEEDED");
    expect(f.retrieve).toHaveBeenCalledTimes(2);
    expect(f.create).not.toHaveBeenCalled();
  });

  it("recovers a lost cancellation response from the original Stripe status", async () => {
    const f = fixture();
    f.cancel.mockImplementation(async () => {
      f.snapshot.status = "canceled";
      throw new Error("Response lost");
    });
    expect(
      (await f.service.reconcileAuthenticationExpiry(f.attempt._id, 60_000)).attempt.providerStatus,
    ).toBe("CANCELED");
    expect(f.create).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, -1, Number.NaN, 180_000])(
    "does not cancel for an ineligible policy %s",
    async (age) => {
      const f = fixture();
      await f.service.reconcileAuthenticationExpiry(f.attempt._id, age);
      expect(f.cancel).not.toHaveBeenCalled();
    },
  );

  it("rejects a mismatched provider identity before writing or canceling", async () => {
    const f = fixture();
    f.snapshot.paymentIntentId = "pi_unrelated";
    await expect(
      f.service.reconcileAuthenticationExpiry(f.attempt._id, 60_000),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(f.repository.recordProviderResult).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
  });
});

describe("PaymentAttempt atomic correlation", () => {
  it("cannot overwrite a different provider ID even on a duplicate success", async () => {
    const row = fixture().attempt;
    const update = vi
      .spyOn(PaymentAttemptModel, "findOneAndUpdate")
      .mockReturnValue({ exec: async () => null } as never);
    const read = vi
      .spyOn(PaymentAttemptModel, "findById")
      .mockReturnValue({ orFail: async () => row } as never);
    try {
      await expect(
        new PaymentAttemptRepository().recordProviderResult(row._id, {
          providerPaymentIntentId: "pi_unrelated",
          providerStatus: "SUCCEEDED",
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      for (const [filter] of update.mock.calls)
        expect(filter).toMatchObject({
          $or: [
            { providerPaymentIntentId: { $exists: false } },
            { providerPaymentIntentId: "pi_unrelated" },
          ],
        });
    } finally {
      update.mockRestore();
      read.mockRestore();
    }
  });
});
