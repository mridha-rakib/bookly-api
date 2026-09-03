import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

/**
 * Domain errors for staff/supervisor invitations. Same shape/convention as StaffError /
 * LinkedAccountError — extends the shared AppError so the global error handler renders the
 * standard envelope, and every message is a static, safe string.
 */
const defaultMessages: Record<string, string> = {
  STAFF_INVITATION_NOT_FOUND: "That invitation was not found",
  STAFF_INVITATION_EMAIL_IN_USE: "An account with this email already exists",
  STAFF_INVITATION_ALREADY_PENDING:
    "There is already a pending invitation for this email at this business",
  STAFF_INVITATION_NOT_PENDING: "This invitation is no longer pending",
  STAFF_INVITATION_EXPIRED: "This invitation has expired",
  STAFF_INVITATION_TOKEN_INVALID: "This invitation link is invalid",
};

export class StaffInvitationError extends AppError {
  public constructor(
    code: keyof typeof defaultMessages,
    statusCode = 400,
    details?: ErrorDetail[],
  ) {
    const message = defaultMessages[code] ?? code;
    super(message, statusCode, {
      details: details ?? [{ message, code }],
      expose: true,
    });
  }
}
