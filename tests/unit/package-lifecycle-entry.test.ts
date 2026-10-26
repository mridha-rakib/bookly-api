import { Types } from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BookingModel } from "../../src/modules/booking/booking.model.js";
import { BookingLifecycleService } from "../../src/modules/booking/booking-lifecycle.service.js";
import { NoShowResolutionService } from "../../src/modules/booking/no-show-resolution.service.js";
import type { PackageCheckoutCustomer } from "../../src/modules/booking/package-checkout-customer-authority.js";
import { PackageLifecycleService } from "../../src/modules/booking/package-lifecycle.service.js";
import { PackageLifecycleDeliveryRecovery } from "../../src/modules/booking/package-lifecycle-delivery-recovery.js";
import {
  type LifecycleIntent,
  PackageLifecycleOperationModel,
  PackageLifecycleOperations,
} from "../../src/modules/booking/package-lifecycle-operation.js";
import { deriveLifecyclePenalty } from "../../src/modules/booking/package-lifecycle-penalty.js";
import { deriveLifecycleSessionTerms } from "../../src/modules/booking/package-lifecycle-session-terms.js";
import { renderEmailTemplate } from "../../src/modules/email/template-registry.js";
import { PaymentService } from "../../src/modules/payment/payment.service.js";
import {
  completeLifecyclePaymentAttempt,
  PaymentAttemptModel,
} from "../../src/modules/payment/payment-attempt.model.js";

describe("S5 shipped lifecycle denial without authority mock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const id = new Types.ObjectId();
  const intent: LifecycleIntent = {
    version: 1,
    key: "denied-lifecycle",
    action: "REDEEM",
    actorUserId: id,
    actorRole: "CUSTOMER",
    customerUserId: id,
    businessId: id,
    businessClientId: id,
    packageProgressId: id,
  };
  for (const action of [
    "REDEEM",
    "RESCHEDULE",
    "CANCEL",
    "COMPLETE",
    "MARK_NO_SHOW",
    "NO_SHOW",
    "REVERSE_NO_SHOW",
    "EXPIRE",
  ] as const) {
    it(`${action} rejects before any DB/dependency operation even with consent true`, async () => {
      vi.stubEnv("PACKAGE_CONSENT_ENABLED", "true");
      const lookup = vi.spyOn(PackageLifecycleOperationModel, "findOneAndUpdate");
      const poison = new Proxy(Object.create(null), {
        get() {
          throw Error("dependency touched before activation denial");
        },
      });
      const service = new PackageLifecycleService(poison, poison, poison);
      const forged: PackageCheckoutCustomer = Object.create(null);
      if (["COMPLETE", "MARK_NO_SHOW", "NO_SHOW", "REVERSE_NO_SHOW"].includes(action))
        await expect(
          service.business(id, "BUSINESS_OWNER", id, { ...intent, action }),
        ).rejects.toThrow("activation");
      else
        await expect(service.customer(forged, { ...intent, action })).rejects.toThrow("activation");
      expect(lookup).not.toHaveBeenCalled();
    });
  }
  it("direct operation prepare cannot manufacture a lifecycle capability", async () => {
    const lookup = vi.spyOn(PackageLifecycleOperationModel, "findOneAndUpdate");
    await expect(new PackageLifecycleOperations().prepare(intent)).rejects.toThrow("activation");
    expect(lookup).not.toHaveBeenCalled();
  });
  it("direct claim/reset/complete cannot mutate evidence", async () => {
    const write = vi.spyOn(PackageLifecycleOperationModel, "updateOne");
    await expect(new PackageLifecycleOperations().claim(id)).rejects.toThrow("activation");
    await expect(new PackageLifecycleOperations().reset(id, "forged")).rejects.toThrow(
      "activation",
    );
    expect(write).not.toHaveBeenCalled();
  });
  it("validation-disabled first-class Booking save still denies", async () => {
    const booking = new BookingModel({
      serviceLines: [{ pricingInput: { packageItemId: id, packageProgressId: id } }],
    });
    await expect(booking.save({ validateBeforeSave: false })).rejects.toThrow("activation");
  });
  it("removing the first-class marker cannot bypass a validation-disabled existing Booking save", async () => {
    const probe = BookingModel.exists({ _id: id });
    vi.spyOn(probe, "exec").mockResolvedValue({ _id: id });
    vi.spyOn(BookingModel, "exists").mockReturnValue(probe);
    const booking = new BookingModel({ serviceLines: [] });
    booking.isNew = false;
    await expect(booking.save({ validateBeforeSave: false })).rejects.toThrow("activation");
  });
  it("document deletion cannot erase lifecycle operation evidence", async () => {
    await expect(
      new PackageLifecycleOperationModel({ _id: id, intent, phase: "COMPLETE" }).deleteOne(),
    ).rejects.toThrow();
  });
  it("generic lifecycle model save cannot forge completed success", async () => {
    await expect(
      new PackageLifecycleOperationModel({ _id: id, intent, phase: "COMPLETE", result: {} }).save({
        validateBeforeSave: false,
      }),
    ).rejects.toThrow();
  });
  it("legacy Customer cancellation stops before monetary lookup on first-class rows", async () => {
    const row = { serviceLines: [{ pricingInput: { packageItemId: id } }] };
    const legacy: BookingLifecycleService = Object.assign(
      Object.create(BookingLifecycleService.prototype),
      {
        bookingRepository: { findByIdForCustomer: vi.fn(async () => row) },
        financialTransactionService: new Proxy(Object.create(null), {
          get() {
            throw Error("monetary port touched");
          },
        }),
      },
    );
    await expect(legacy.cancelByCustomer(String(id), String(id), undefined)).rejects.toThrow(
      "activation",
    );
  });
  it("existing automatic no-show resolver stops before legacy penalty suppression/collection", async () => {
    const automatic: NoShowResolutionService = Object.assign(
      Object.create(NoShowResolutionService.prototype),
      {
        bookingRepository: {
          findByIdOnly: vi.fn(async () => ({
            serviceLines: [{ pricingInput: { packageItemId: id } }],
          })),
        },
      },
    );
    await expect(automatic.autoResolve(id)).rejects.toThrow("activation");
  });
  it("direct full operation append cannot use an arbitrary caller transaction", async () => {
    const write = vi.spyOn(PackageLifecycleOperationModel, "updateOne");
    await expect(
      new PackageLifecycleOperations().complete(
        id,
        "forged",
        {
          version: 1,
          status: "UPCOMING",
          committedAt: new Date(),
          emails: [],
          reminders: [],
          tasks: [],
        },
        Object.create(null),
      ),
    ).rejects.toThrow("activation");
    expect(write).not.toHaveBeenCalled();
  });
  it("S5F1 genuine session charge denies before profile/provider/database access regardless of flag", async () => {
    vi.stubEnv("PACKAGE_CONSENT_ENABLED", "true");
    const payment: PaymentService = Object.create(PaymentService.prototype);
    const read = vi.spyOn(PaymentAttemptModel, "findById");
    await expect(payment.chargePackageLifecycle(Object.create(null))).rejects.toThrow("activation");
    expect(read).not.toHaveBeenCalled();
  });
  it("S5F1 session quote presentation and acceptance cannot use structural Customer DTOs", async () => {
    vi.stubEnv("PACKAGE_CONSENT_ENABLED", "true");
    const read = vi.spyOn(PackageLifecycleOperationModel, "findOneAndUpdate");
    const ops = new PackageLifecycleOperations(),
      forged: PackageCheckoutCustomer = Object.create(null);
    await expect(ops.presentSession(forged, intent, new Date())).rejects.toThrow("activation");
    await expect(
      ops.acceptSession(forged, intent, Object.create(null), new Date()),
    ).rejects.toThrow("activation");
    expect(read).not.toHaveBeenCalled();
  });
  it("S5F1 penalty reserve/release/paid failure cannot manufacture monetary authority", async () => {
    vi.stubEnv("PACKAGE_CONSENT_ENABLED", "true");
    const read = vi.spyOn(PackageLifecycleOperationModel, "findById");
    const ops = new PackageLifecycleOperations();
    await expect(ops.reservePenalty(id, intent, new Date())).rejects.toThrow("activation");
    await expect(
      deriveLifecyclePenalty(id, intent, new Date(), Object.create(null)),
    ).rejects.toThrow("activation");
    await expect(ops.releaseUncollected(id)).rejects.toThrow("activation");
    await expect(ops.failPaid(id, "forged")).rejects.toThrow("activation");
    expect(read).not.toHaveBeenCalled();
  });
  it("S5F1 same-parent monetary completion denies before any transaction or model operation", async () => {
    const read = vi.spyOn(PaymentAttemptModel, "findById");
    await expect(
      completeLifecyclePaymentAttempt(id, "forged", Object.create(null)),
    ).rejects.toThrow("activation");
    expect(read).not.toHaveBeenCalled();
  });
  it("S5F1 exported session-term adapter cannot act as an alternate genuine writer", async () => {
    const read = vi.spyOn(PackageLifecycleOperationModel, "findById");
    await expect(
      deriveLifecycleSessionTerms(intent, id, Object.create(null), new Date()),
    ).rejects.toThrow("activation");
    expect(read).not.toHaveBeenCalled();
  });
  it("S5F1 delivery consumer and direct task transitions deny before reading or dispatching", async () => {
    vi.stubEnv("PACKAGE_CONSENT_ENABLED", "true");
    const read = vi.spyOn(PackageLifecycleOperationModel, "findOne");
    const port = { reconcileExisting: vi.fn(async () => ({ outcome: "UNAVAILABLE" as const })) };
    await expect(
      new PackageLifecycleDeliveryRecovery(port).runOnce(Object.create(null), id),
    ).rejects.toThrow("activation");
    await expect(
      new PackageLifecycleOperations().claimDelivery(id, intent, 0, new Date()),
    ).rejects.toThrow("activation");
    await expect(
      new PackageLifecycleOperations().settleDelivery(id, 0, "forged", "DONE", new Date()),
    ).rejects.toThrow("activation");
    expect(read).not.toHaveBeenCalled();
    expect(port.reconcileExisting).not.toHaveBeenCalled();
  });
});

describe("S5F1 lifecycle notice rendering", () => {
  it("registered lifecycle renderer escapes contact text and never turns a pending notice into a charge receipt", () => {
    const result = renderEmailTemplate("PACKAGE_SESSION_LIFECYCLE", {
      title: "Appointment under review",
      businessName: "<script>venue</script>",
      bookingReference: "SYNTHETIC-REF",
      message: "Review is pending. No payment outcome is reported by this notice.",
    });
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
    expect(result.text).toContain("Review is pending");
    expect(result.text).not.toContain("Payment succeeded");
    expect(() =>
      renderEmailTemplate("PACKAGE_SESSION_LIFECYCLE", {
        title: "Forged paid receipt",
        businessName: "Venue",
        bookingReference: "REF",
        message: "Pending",
        chargedAmountCents: 500,
      }),
    ).toThrow();
  });
});
