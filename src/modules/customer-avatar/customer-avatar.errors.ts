import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  CUSTOMER_AVATAR_FILE_REQUIRED: "Image file is required",
  CUSTOMER_AVATAR_INVALID_TYPE: "Only JPEG, PNG, and WebP images are allowed",
  CUSTOMER_AVATAR_TOO_LARGE: "Image file is too large",
};

export class CustomerAvatarError extends AppError {
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
