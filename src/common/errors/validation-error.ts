import { AppError, type ErrorDetail } from "./app-error.js";

export class RequestValidationError extends AppError {
  public constructor(details: ErrorDetail[]) {
    super("Validation failed", 400, { details });
  }
}
