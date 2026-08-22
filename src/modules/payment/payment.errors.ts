import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  PAYMENT_PROVIDER_NOT_CONFIGURED:
    "Payments are not available right now — the payment provider is not configured in this environment",
  PAYMENT_CUSTOMER_NOT_FOUND: "No payment profile found for this customer",
  PAYMENT_METHOD_REQUIRED: "A saved payment method is required to complete this booking",
  PAYMENT_METHOD_INVALID: "This payment method could not be saved — please try a different card",
  PAYMENT_REQUIRES_ACTION: "This payment requires additional authentication",
  PAYMENT_FAILED: "The payment could not be completed",
  PAYMENT_ALREADY_PROCESSED: "This payment has already been processed",
  PAYMENT_REFUND_FAILED: "The refund could not be completed",
  PAYMENT_WEBHOOK_SIGNATURE_INVALID: "Webhook signature verification failed",
  PAYMENT_IDEMPOTENCY_KEY_REQUIRED: "An idempotency key is required for this payment operation",
};

export class PaymentError extends AppError {
  public constructor(
    code: keyof typeof defaultMessages,
    statusCode = 402,
    details?: ErrorDetail[],
  ) {
    const message = defaultMessages[code] ?? code;
    super(message, statusCode, {
      details: details ?? [{ message, code }],
      // Payment failures are shown to the end user (declined card, requires 3DS, etc.) — but
      // never expose the underlying Stripe error object/message verbatim (see
      // stripe-payment-gateway.ts's own comment on why raw provider errors are summarized,
      // never passed through).
      expose: true,
    });
  }
}
