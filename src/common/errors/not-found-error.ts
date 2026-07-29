import { AppError } from "./app-error.js";

export class NotFoundError extends AppError {
  public constructor(resource = "Resource") {
    super(`${resource} not found`, 404);
  }
}
