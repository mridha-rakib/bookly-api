import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

const defaultMessages: Record<string, string> = {
  STORAGE_NOT_CONFIGURED: "Object storage is not configured",
  STORAGE_OPERATION_FAILED: "Object storage operation failed",
};

export class StorageError extends AppError {
  public constructor(
    code: keyof typeof defaultMessages,
    statusCode = 500,
    details?: ErrorDetail[],
    cause?: unknown,
  ) {
    const message = defaultMessages[code] ?? code;
    super(message, statusCode, {
      details: details ?? [{ message, code }],
      cause,
      expose: statusCode < 500,
    });
  }
}
