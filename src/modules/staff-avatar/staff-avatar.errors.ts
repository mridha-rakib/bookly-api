import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  STAFF_AVATAR_FILE_REQUIRED: "Image file is required",
  STAFF_AVATAR_INVALID_TYPE: "Only JPEG, PNG, WebP, and GIF images are allowed",
  STAFF_AVATAR_TOO_LARGE: "Image file is too large",
  STAFF_AVATAR_STAFF_NOT_FOUND: "Staff member not found",
  STAFF_AVATAR_BUSINESS_NOT_FOUND: "Business not found",
  STAFF_AVATAR_BUSINESS_ACCESS_DENIED: "You do not have access to manage staff for this business",
};

export class StaffAvatarError extends AppError {
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
