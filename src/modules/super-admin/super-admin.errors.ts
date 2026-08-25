import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  SUPER_ADMIN_CUSTOMER_NOT_FOUND: "Customer not found",
};

export class SuperAdminError extends AppError {
  public constructor(
    code: keyof typeof defaultMessages,
    statusCode = 404,
    details?: ErrorDetail[],
  ) {
    const message = defaultMessages[code] ?? code;
    super(message, statusCode, {
      details: details ?? [{ message, code }],
      expose: true,
    });
  }
}
