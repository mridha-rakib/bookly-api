import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import { BookingModel } from "../../src/modules/booking/booking.model.js";
import {
  bookingPackageContextSchema,
  bookingSchedulingSnapshotSchema,
  validPackageSchedulingSnapshot,
} from "../../src/modules/booking/booking-package-foundation.js";
import { packageRequestBindingSchema } from "../../src/modules/booking/package-request-binding.js";

describe("additive Package claim/Booking foundations", () => {
  const common = () => ({
    version: 1,
    requestHash: "a".repeat(64),
    selectedItemId: new Types.ObjectId(),
  });
  it("accepts distinct PURCHASE and REDEMPTION bindings", () => {
    expect(
      packageRequestBindingSchema.safeParse({
        ...common(),
        operation: "PURCHASE",
        packageId: new Types.ObjectId(),
      }).success,
    ).toBe(true);
    expect(
      packageRequestBindingSchema.safeParse({
        ...common(),
        operation: "REDEMPTION",
        packageProgressId: new Types.ObjectId(),
      }).success,
    ).toBe(true);
  });
  it.each([
    { operation: "OTHER" },
    { operation: "PURCHASE" },
    {
      operation: "PURCHASE",
      packageId: new Types.ObjectId(),
      packageProgressId: new Types.ObjectId(),
    },
    {
      operation: "REDEMPTION",
      packageProgressId: new Types.ObjectId(),
      acceptedPurchaseSnapshot: {},
    },
    { operation: "PURCHASE", packageId: new Types.ObjectId(), requestHash: "invalid" },
    { operation: "PURCHASE", packageId: new Types.ObjectId(), selectedItemId: "wrong" },
  ])("rejects malformed operation metadata %#", (extra) => {
    expect(packageRequestBindingSchema.safeParse({ ...common(), ...extra }).success).toBe(false);
  });
  it("keeps new Booking fields optional for legacy and checks occupied-time arithmetic", () => {
    const snapshot = {
      version: 1 as const,
      baseDurationMin: 60,
      bufferAfterMin: 10,
      processingTimeMin: 5,
      occupiedDurationMin: 75,
    };
    expect(validPackageSchedulingSnapshot(snapshot)).toBe(true);
    expect(validPackageSchedulingSnapshot({ ...snapshot, occupiedDurationMin: 60 })).toBe(false);
    expect(BookingModel.schema.path("serviceLines")).toBeDefined();
    expect(bookingPackageContextSchema.path("role").isRequired).toBe(true);
    expect(bookingSchedulingSnapshotSchema.path("version").isRequired).toBe(true);
  });
  it("conditionally enforces complete v2 linkage, zero redemption base and a single Package line", () => {
    const line = {
      serviceId: new Types.ObjectId(),
      responsibleStaffMembershipId: new Types.ObjectId(),
      reservationId: new Types.ObjectId(),
      amountCents: 0,
      addons: [],
      serviceSnapshot: { name: "Treatment", pricingMode: "PACKAGE", durationMin: 60 },
      pricingInput: {
        packageProgressId: new Types.ObjectId(),
        packageItemId: new Types.ObjectId(),
      },
      packageContext: {
        packageId: new Types.ObjectId(),
        packageName: "Bundle",
        definitionItemId: new Types.ObjectId(),
        role: "REDEMPTION",
      },
      schedulingSnapshot: {
        version: 1,
        baseDurationMin: 60,
        bufferAfterMin: 10,
        processingTimeMin: 5,
        occupiedDurationMin: 75,
      },
    };
    const valid = new BookingModel({ serviceLines: [line] }).validateSync();
    expect(valid?.errors["serviceLines"]).toBeUndefined();
    for (const change of [
      { amountCents: 100 },
      { packageContext: undefined },
      { schedulingSnapshot: { ...line.schedulingSnapshot, occupiedDurationMin: 60 } },
    ]) {
      expect(
        new BookingModel({ serviceLines: [{ ...line, ...change }] }).validateSync()?.errors[
          "serviceLines"
        ],
      ).toBeDefined();
    }
    expect(
      new BookingModel({ serviceLines: [line, line] }).validateSync()?.errors["serviceLines"],
    ).toBeDefined();
  });
});
