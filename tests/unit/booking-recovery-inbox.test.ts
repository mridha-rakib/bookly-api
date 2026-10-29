import { expect, it } from "vitest";
import { bookingRecoveryInboxQuerySchema } from "../../src/modules/booking/booking.schema.js";
import { decodeRecoveryCursor } from "../../src/modules/booking/booking-recovery-inbox.js";

const customerId = "1".repeat(24);
it("recovery pages bound the amount of evidence scanned and reject caller identity/provider fields", () => {
  expect(bookingRecoveryInboxQuerySchema.parse({})).toEqual({ limit: 10 });
  for (const limit of [0, 21, 1.5])
    expect(bookingRecoveryInboxQuerySchema.safeParse({ limit }).success).toBe(false);
  for (const key of [
    "customerId",
    "businessId",
    "providerStatus",
    "clientSecret",
    "includePackages",
  ])
    expect(bookingRecoveryInboxQuerySchema.safeParse({ [key]: "forged" }).success).toBe(false);
});
it("cursor scope cannot be reused by another Customer and malformed/legacy cursors fail closed", () => {
  const cursor = Buffer.from(
    JSON.stringify({
      version: 1,
      customerId,
      createdAt: "2030-08-20T09:00:00.000Z",
      id: "2".repeat(24),
      source: "ATTEMPT",
    }),
  ).toString("base64url");
  expect(decodeRecoveryCursor(cursor, customerId)?.source).toBe("ATTEMPT");
  expect(() => decodeRecoveryCursor(cursor, "3".repeat(24))).toThrow(
    "Invalid Booking recovery cursor",
  );
  for (const value of ["invalid", Buffer.from("{}").toString("base64url")])
    expect(() => decodeRecoveryCursor(value, customerId)).toThrow();
});
