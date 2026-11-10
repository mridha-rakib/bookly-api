import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  SUPER_ADMIN_CUSTOMER_STATUS_UNCONFIRMED:
    "Account status and session termination could not be confirmed. Retry the action to reconcile safely.",
  SUPER_ADMIN_CUSTOMER_NOT_FOUND: "Customer not found",
  SUPER_ADMIN_CUSTOMER_DELETED: "This customer account is closed and its status can't be changed",
  SUPER_ADMIN_CUSTOMER_STATUS_CONFLICT: "This customer's status was changed by someone else",
  SUPER_ADMIN_FORBIDDEN: "Only a Super Admin can change a customer's account status",
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
