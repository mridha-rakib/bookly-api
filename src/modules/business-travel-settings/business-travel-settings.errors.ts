import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  BUSINESS_TRAVEL_SETTINGS_NOT_FOUND: "Business travel settings not found",
  BUSINESS_TRAVEL_SETTINGS_INVALID_CITY: "Travel settings city is invalid",
  BUSINESS_TRAVEL_SETTINGS_INVALID_DELIVERY_TYPE: "Service delivery type is invalid",
  BUSINESS_TRAVEL_SETTINGS_INVALID_SERVICE_SUBTOTAL: "Service subtotal is invalid",
  TRAVEL_CITY_NOT_SERVED: "This business does not serve the selected city",
};

export class BusinessTravelSettingsError extends AppError {
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
