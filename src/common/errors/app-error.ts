export type ErrorDetail = {
  path?: string;
  message: string;
  code?: string;
};

type AppErrorOptions = {
  details?: ErrorDetail[];
  cause?: unknown;
  expose?: boolean;
};

export class AppError extends Error {
  public readonly isOperational = true;
  public readonly statusCode: number;
  public readonly details: ErrorDetail[] | undefined;
  public readonly expose: boolean;

  public constructor(message: string, statusCode = 500, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.details = options.details;
    this.expose = options.expose ?? statusCode < 500;
    Error.captureStackTrace?.(this, new.target);
  }
}
