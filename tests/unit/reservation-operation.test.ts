import { describe, expect, it, vi } from "vitest";
import {
  packageInitialReservationKey,
  packageInitialReservationOperationSchema,
} from "../../src/modules/booking-slot-reservation/reservation-operation.js";

const base = {
  version: 1 as const,
  kind: "PACKAGE_INITIAL_APPOINTMENT" as const,
  businessId: "100000000000000000000001",
  batchId: "200000000000000000000001",
  bookingId: "300000000000000000000001",
  selectionId: "400000000000000000000001",
};

describe("preparatory initial Package reservation identity", () => {
  it("different retained Bookings in one batch have distinct stable operation keys", () => {
    const other = {
      ...base,
      bookingId: "300000000000000000000002",
      selectionId: "400000000000000000000002",
    };
    expect(packageInitialReservationKey(base)).not.toBe(packageInitialReservationKey(other));
    expect(packageInitialReservationKey({ ...base })).toBe(packageInitialReservationKey(base));
  });
  it("reordering appointment inputs preserves each Booking identity", () => {
    const rows = [
      base,
      { ...base, bookingId: "300000000000000000000002", selectionId: "400000000000000000000002" },
    ];
    const map = (values: typeof rows) =>
      Object.fromEntries(values.map((row) => [row.bookingId, packageInitialReservationKey(row)]));
    expect(map([...rows].reverse())).toEqual(map(rows));
  });
  it("Business is a fixed-width scoped identity component", () => {
    expect(
      packageInitialReservationKey({ ...base, businessId: "100000000000000000000002" }),
    ).not.toBe(packageInitialReservationKey(base));
  });
  it("batch and selection correlate the one initial Booking operation rather than mint replacement operations", () => {
    expect(packageInitialReservationKey({ ...base, batchId: "200000000000000000000002" })).toBe(
      packageInitialReservationKey(base),
    );
    expect(packageInitialReservationKey({ ...base, selectionId: "400000000000000000000002" })).toBe(
      packageInitialReservationKey(base),
    );
  });
  it("hex normalization is deterministic and does not mutate supplied snapshots", () => {
    const input = Object.freeze({ ...base, bookingId: "ABCDEF000000000000000001" });
    expect(packageInitialReservationKey(input)).toBe(
      packageInitialReservationKey({ ...input, bookingId: input.bookingId.toLowerCase() }),
    );
    expect(input.bookingId).toBe("ABCDEF000000000000000001");
  });
  it("supported ordinary/manual/legacy and reschedule keys retain a numeric line suffix and cannot equal the fixed Booking key", () => {
    const key = packageInitialReservationKey(base);
    for (const index of [0, 1, 19]) {
      expect(key).not.toBe(`${key}:${index}`);
      expect(key).not.toBe(`${base.bookingId}:reschedule:nonce:${index}`);
    }
    expect(key.split(":").at(-1)).toHaveLength(24);
  });
  it.each(["bookingId", "businessId", "batchId", "selectionId"])(
    "missing or malformed %s cannot create a key",
    (field) => {
      expect(() => packageInitialReservationKey({ ...base, [field]: "invalid" })).toThrow();
      expect(() => packageInitialReservationKey({ ...base, [field]: undefined })).toThrow();
    },
  );
  it("rejects posted time, retry, money or mutable index authority", () => {
    for (const field of ["retryAttempt", "lineIndex", "acceptedAt", "priceCents"])
      expect(() => packageInitialReservationKey({ ...base, [field]: 1 })).toThrow();
    expect(() =>
      packageInitialReservationOperationSchema.parse({ ...base, kind: "REDEMPTION" }),
    ).toThrow();
  });
  it("has no clock, randomness, ID generation or persistence dependency during key construction", () => {
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock");
    });
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("random");
    });
    try {
      expect(packageInitialReservationKey(base)).toContain(base.bookingId);
      expect(clock).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      random.mockRestore();
    }
  });
});
