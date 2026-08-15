import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  BUSINESS_MEDIA_NOT_FOUND: "Business media not found",
  BUSINESS_MEDIA_FILE_REQUIRED: "Image file is required",
  BUSINESS_MEDIA_INVALID_TYPE: "Only JPEG, PNG, WebP, and GIF images are allowed",
  BUSINESS_MEDIA_TOO_LARGE: "Image file is too large",
};

export class BusinessMediaError extends AppError {
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
