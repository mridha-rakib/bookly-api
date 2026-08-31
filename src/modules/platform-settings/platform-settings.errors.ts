import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  PLATFORM_SETTINGS_NO_UPDATE_FIELDS: "Provide at least one field to update",
  PLATFORM_SETTINGS_INVALID_MAX_SERVICES: "maxServicesPerBooking is out of the allowed range",
  PLATFORM_SETTINGS_INVALID_WINDOWS:
    "noShowCategoryWindows must contain exactly one valid entry per canonical category",
};

export class PlatformSettingsError extends AppError {
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
