import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendBatchCompletion,
  BookingCreationClaimModel,
  claimBatchDeliveryTask,
  markBatchCompensatedFailure,
  retainBatchFinance,
  settleBatchDeliveryTask,
} from "../../src/modules/booking/booking-creation-claim.model.js";
import { PackageBatchDeliveryRecovery } from "../../src/modules/booking/package-batch-delivery-recovery.js";
import { PackageBatchFinancialPersistence } from "../../src/modules/booking/package-batch-financial-persistence.js";
import { PackageCalendarDispatch } from "../../src/modules/booking/package-calendar-dispatch.js";
import { PaymentService } from "../../src/modules/payment/payment.service.js";
import {
  completeBoundPaymentAttempt,
  PaymentAttemptModel,
} from "../../src/modules/payment/payment-attempt.model.js";
import { PaymentAttemptRepository } from "../../src/modules/payment/payment-attempt.repository.js";

// Deliberately no authority module mock; malformed DTOs/dependencies cannot reach persistence.
describe("F2-65/66 shipped denial independently covers every new mutable entry", () => {
  beforeEach(() => vi.stubEnv("PACKAGE_CONSENT_ENABLED", "true"));
  it("direct batch attempt composition denies before persistence", async () => {
    const read = vi.spyOn(PaymentAttemptModel, "findOne");
    const repository = new PaymentAttemptRepository();
    await expect(
      Reflect.apply(repository.createOrResumeWithDisposition, repository, [
        { packageBatchBinding: {} },
      ]),
    ).rejects.toMatchObject({ code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE" });
    expect(read).not.toHaveBeenCalled();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it.each([
    ["finance", retainBatchFinance],
    ["compensated-failure", markBatchCompensatedFailure],
    ["completion", appendBatchCompletion],
    ["claim-task", claimBatchDeliveryTask],
    ["settle-task", settleBatchDeliveryTask],
    ["payment-completion", completeBoundPaymentAttempt],
  ] as const)("%s denies before DB", async (_name, entry) => {
    vi.stubEnv("PACKAGE_CONSENT_ENABLED", "true");
    const read = vi.spyOn(BookingCreationClaimModel, "findOne");
    const attempt = vi.spyOn(PaymentAttemptModel, "findById");
    await expect(Reflect.apply(entry, undefined, [{}, {}, {}, {}, {}])).rejects.toMatchObject({
      code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE",
      statusCode: 503,
    });
    expect(read).not.toHaveBeenCalled();
    expect(attempt).not.toHaveBeenCalled();
  });
  it("the full financial parent rejects before even inspecting dependency ports", async () => {
    const instance = Reflect.construct(PackageBatchFinancialPersistence, [{}, {}, {}]);
    const read = vi.spyOn(BookingCreationClaimModel, "findOne");
    await expect(
      Reflect.apply(PackageBatchFinancialPersistence.prototype.complete, instance, [{}]),
    ).rejects.toMatchObject({ code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE" });
    expect(read).not.toHaveBeenCalled();
  });
  it("delivery recovery has no live flag bypass or purchase authority", async () => {
    vi.stubEnv("PACKAGE_CONSENT_ENABLED", "true");
    const poison = new Proxy(Object.create(null), {
      get() {
        throw new Error("delivery dependency touched before activation denial");
      },
    });
    const instance = Reflect.construct(PackageBatchDeliveryRecovery, [poison, undefined, poison]);
    const read = vi.spyOn(BookingCreationClaimModel, "findOne");
    await expect(
      Reflect.apply(PackageBatchDeliveryRecovery.prototype.runOnce, instance, [{}]),
    ).rejects.toMatchObject({ code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE", statusCode: 503 });
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["release", "deliver", "recover"] as const)(
    "durable Calendar %s denies before dependencies",
    async (entry) => {
      const poison = new Proxy(Object.create(null), {
        get() {
          throw new Error("Calendar dependency touched before activation denial");
        },
      });
      const engine = new PackageCalendarDispatch(poison);
      await expect(Reflect.apply(engine[entry], engine, [{}, {}])).rejects.toMatchObject({
        code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE",
        statusCode: 503,
      });
    },
  );
  it("a batch-bound charge denies before profile/provider/attempt preparation", async () => {
    const instance = Reflect.construct(PaymentService, [{}, {}, {}]);
    const attempt = vi.spyOn(PaymentAttemptModel, "findOne");
    await expect(
      Reflect.apply(PaymentService.prototype.chargeBookingDeposit, instance, [
        { packageBatchBinding: {} },
      ]),
    ).rejects.toMatchObject({ code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE" });
    expect(attempt).not.toHaveBeenCalled();
  });
  it("direct model save cannot manufacture a batch payment through disabled validation", async () => {
    const row = new PaymentAttemptModel({ packageBatchBinding: {} });
    await expect(row.save({ validateBeforeSave: false })).rejects.toMatchObject({
      code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE",
    });
  });
});
