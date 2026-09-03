import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

/**
 * Domain errors for staff/supervisor invitations. Same shape/convention as StaffError /
 * LinkedAccountError — extends the shared AppError so the global error handler renders the
 * standard envelope, and every message is a static, safe string.
 *
 * The Google-acceptance callback almost never surfaces these to the browser (it always redirects
 * to the frontend with a coarse `status`); the token-info + password-accept endpoints do.
 */
const defaultMessages: Record<string, string> = {
  STAFF_INVITATION_NOT_FOUND: "That invitation was not found",
  STAFF_INVITATION_EMAIL_IN_USE: "An account with this email already exists",
  STAFF_INVITATION_ALREADY_PENDING:
    "There is already a pending invitation for this email at this business",
  STAFF_INVITATION_NOT_PENDING: "This invitation is no longer pending",
  STAFF_INVITATION_EXPIRED: "This invitation has expired",
  STAFF_INVITATION_TOKEN_INVALID: "This invitation link is invalid",
  STAFF_INVITATION_RESEND_TOO_SOON: "Please wait before requesting another invitation email",
  STAFF_INVITATION_EMAIL_FAILED: "Could not send the invitation email. Please try again",
  STAFF_INVITATION_ALREADY_MEMBER: "This email is already a team member of another business",
  STAFF_INVITATION_GOOGLE_NOT_CONFIGURED: "Google sign-in is not configured on this server",
  STAFF_INVITATION_GOOGLE_OAUTH_FAILED: "Could not complete Google sign-in. Please try again",
  STAFF_INVITATION_INVALID_STATE: "This Google sign-in request has expired. Please try again",
  STAFF_INVITATION_GOOGLE_EMAIL_MISMATCH:
    "The Google account's email does not match the invited address",
  STAFF_INVITATION_TRANSACTION_UNAVAILABLE: "Could not complete the request. Please try again",
};

export type StaffInvitationErrorCode = keyof typeof defaultMessages;

export class StaffInvitationError extends AppError {
  public constructor(code: StaffInvitationErrorCode, statusCode = 400, details?: ErrorDetail[]) {
    const message = defaultMessages[code] ?? code;
    super(message, statusCode, {
      details: details ?? [{ message, code }],
      expose: true,
    });
  }
}
