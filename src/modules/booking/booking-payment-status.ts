import type { PaymentAttemptDocument } from "../payment/payment-attempt.model.js";

export type BookingPaymentState =
  | "NOT_OBSERVED"
  | "UNRESOLVED"
  | "AUTHENTICATION_REQUIRED"
  | "PAYMENT_PROCESSING"
  | "FINALIZATION_PENDING"
  | "PAYMENT_FAILED"
  | "REFUND_PENDING"
  | "REFUNDED"
  | "RECONCILIATION_REQUIRED"
  | "COMMITTED";

/** A durable provider observation is not evidence of a committed Booking or settled refund. */
export function bookingPaymentState(attempt: PaymentAttemptDocument | null): BookingPaymentState {
  if (!attempt) return "UNRESOLVED";
  if (attempt.compensationStatus === "REFUNDED") return "REFUNDED";
  if (["FAILED", "RECONCILIATION_REQUIRED"].includes(attempt.compensationStatus))
    return "RECONCILIATION_REQUIRED";
  if (attempt.compensationStatus !== "NOT_REQUIRED") return "REFUND_PENDING";
  if (attempt.providerStatus === "SUCCEEDED") return "FINALIZATION_PENDING";
  if (attempt.providerStatus === "REQUIRES_ACTION") return "AUTHENTICATION_REQUIRED";
  if (["FAILED", "CANCELED"].includes(attempt.providerStatus)) return "PAYMENT_FAILED";
  if (attempt.providerStatus === "PROCESSING") return "PAYMENT_PROCESSING";
  return "UNRESOLVED";
}
