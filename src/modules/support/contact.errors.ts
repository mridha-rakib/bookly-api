import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  CONTACT_DELIVERY_FAILED: "Could not send your message right now. Please try again shortly.",
};

export class ContactError extends AppError {
  public constructor(
    code: keyof typeof defaultMessages,
    statusCode = 502,
    details?: ErrorDetail[],
  ) {
    const message = defaultMessages[code] ?? code;
    super(message, statusCode, {
      details: details ?? [{ message, code }],
      expose: true,
    });
  }
}
