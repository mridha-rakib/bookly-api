import { expect, it } from "vitest";
import { bookingPaymentStatusQuerySchema } from "../../src/modules/booking/booking.schema.js";
import { bookingPaymentState } from "../../src/modules/booking/booking-payment-status.js";

it.each([
  ["REQUIRES_ACTION", "NOT_REQUIRED", "AUTHENTICATION_REQUIRED"],
  ["PROCESSING", "NOT_REQUIRED", "PAYMENT_PROCESSING"],
  ["UNKNOWN", "NOT_REQUIRED", "UNRESOLVED"],
  ["SUCCEEDED", "NOT_REQUIRED", "FINALIZATION_PENDING"],
  ["SUCCEEDED", "REFUND_PENDING", "REFUND_PENDING"],
  ["SUCCEEDED", "REFUNDED", "REFUNDED"],
  ["SUCCEEDED", "FAILED", "RECONCILIATION_REQUIRED"],
  ["FAILED", "NOT_REQUIRED", "PAYMENT_FAILED"],
])(
  "%s + %s reports %s without inventing Booking commitment",
  (providerStatus, compensationStatus, expected) => {
    expect(bookingPaymentState({ providerStatus, compensationStatus } as never)).toBe(expected);
  },
);
it("status accepts only the original key, never posted actor, money or provider authority", () => {
  expect(bookingPaymentStatusQuerySchema.parse({ idempotencyKey: "original" })).toEqual({
    idempotencyKey: "original",
  });
  for (const key of [
    "customerId",
    "businessClientId",
    "amountCents",
    "providerStatus",
    "clientSecret",
  ])
    expect(
      bookingPaymentStatusQuerySchema.safeParse({ idempotencyKey: "original", [key]: "forged" })
        .success,
    ).toBe(false);
});
