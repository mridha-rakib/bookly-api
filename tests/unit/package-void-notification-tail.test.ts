import { Types } from "mongoose";
import { expect, it, vi } from "vitest";
import { BookingLifecycleService } from "../../src/modules/booking/booking-lifecycle.service.js";

/** Isolate only the post-workflow observer tail; real refund/persistence coverage remains in
 * package-progress-database.integration.test.ts. No synthetic production authority is added. */
function fixture(status: "SUCCEEDED" | "FAILED" | "PENDING" = "SUCCEEDED") {
  const progress = {
    _id: new Types.ObjectId(),
    businessId: new Types.ObjectId(),
    originBookingId: new Types.ObjectId(),
    voidedAt: new Date(),
    voidRefundSettlement: { status, amountCents: 3500 },
  };
  const origin = { _id: progress.originBookingId, businessId: progress.businessId };
  const business = { _id: progress.businessId };
  const notify = vi.fn(async () => undefined);
  const findOrigin = vi.fn(async () => origin);
  const findBusiness = vi.fn(async () => business);
  const packageAction = vi.fn(async () => ({ packageProgress: progress, cancelledBookingIds: [] }));
  const service: BookingLifecycleService = Object.assign(
    Object.create(BookingLifecycleService.prototype),
    {
      packageAction,
      bookingRepository: { findById: findOrigin },
      businessRepository: { findById: findBusiness },
      bookingCancelledNotifier: { notifyBookingCancelled: notify },
    },
  );
  const run = () =>
    service.voidUnusedPackage(
      "customer",
      String(progress.businessId),
      String(progress._id),
      "reason",
    );
  return { progress, origin, business, notify, findOrigin, findBusiness, packageAction, run };
}

it.each(["SUCCEEDED", "FAILED", "PENDING"] as const)(
  "uses the origin and persisted %s refund amount/status after workflow completion",
  async (status) => {
    const f = fixture(status);
    await expect(f.run()).resolves.toBe(f.progress);
    expect(f.packageAction).toHaveBeenCalledWith(
      "customer",
      "CUSTOMER",
      String(f.progress.businessId),
      String(f.progress._id),
      "TERMINATE",
      "reason",
      true,
    );
    expect(f.findOrigin).toHaveBeenCalledWith(f.progress.businessId, f.progress.originBookingId);
    expect(f.notify).toHaveBeenCalledWith(
      f.origin,
      f.business,
      "CUSTOMER",
      {
        succeeded: status === "SUCCEEDED",
        amountCents: 3500,
        status,
      },
      `PACKAGE_REFUND:${f.origin._id}`,
    );
    expect(f.packageAction.mock.invocationCallOrder[0]).toBeLessThan(
      f.notify.mock.invocationCallOrder[0]!,
    );
  },
);

it.each(["origin", "business", "notifier"] as const)(
  "%s observer failure cannot reject the completed void/refund",
  async (dependency) => {
    const f = fixture();
    const failure = Error("post-commit observer unavailable");
    if (dependency === "origin") f.findOrigin.mockRejectedValueOnce(failure);
    else if (dependency === "business") f.findBusiness.mockRejectedValueOnce(failure);
    else f.notify.mockRejectedValueOnce(failure);
    await expect(f.run()).resolves.toBe(f.progress);
    expect(f.progress.voidRefundSettlement).toEqual({ status: "SUCCEEDED", amountCents: 3500 });
    expect(f.packageAction).toHaveBeenCalledTimes(1);
  },
);

it("does not swallow a failure from the actual void/refund workflow", async () => {
  const f = fixture();
  f.packageAction.mockRejectedValueOnce(Error("workflow failed"));
  await expect(f.run()).rejects.toThrow("workflow failed");
  expect(f.findOrigin).not.toHaveBeenCalled();
  expect(f.notify).not.toHaveBeenCalled();
});
