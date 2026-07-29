import type { ErrorRequestHandler } from "express";
import mongoose from "mongoose";
import { ZodError } from "zod";

import { env } from "../../config/env.js";
import { logger as defaultLogger } from "../../config/logger.js";
import { AppError, type ErrorDetail } from "../errors/app-error.js";
import { RequestValidationError } from "../errors/validation-error.js";
import { buildErrorResponse } from "../http/responses.js";

type ErrorHandlerOptions = {
  isProduction?: boolean;
  logger?: typeof defaultLogger;
};

const zodErrorToDetails = (error: ZodError): ErrorDetail[] =>
  error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));

const mongooseValidationToDetails = (error: mongoose.Error.ValidationError): ErrorDetail[] =>
  Object.entries(error.errors).map(([path, validatorError]) => ({
    path,
    message: validatorError.message,
    code: validatorError.name,
  }));

const normalizeError = (error: unknown): AppError => {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof ZodError) {
    return new RequestValidationError(zodErrorToDetails(error));
  }

  if (error instanceof mongoose.Error.ValidationError) {
    return new RequestValidationError(mongooseValidationToDetails(error));
  }

  if (error instanceof mongoose.Error.CastError) {
    return new RequestValidationError([
      {
        path: error.path,
        message: "Invalid identifier format",
        code: "invalid_cast",
      },
    ]);
  }

  return new AppError("Internal server error", 500, { cause: error, expose: false });
};

export const createErrorHandler = (options: ErrorHandlerOptions = {}): ErrorRequestHandler => {
  const isProduction = options.isProduction ?? env.NODE_ENV === "production";
  const logger = options.logger ?? defaultLogger;

  return (error, request, response, _next) => {
    const normalizedError = normalizeError(error);
    const statusCode = normalizedError.statusCode;
    const requestId = request.id ? String(request.id) : undefined;
    const message =
      normalizedError.expose || !isProduction ? normalizedError.message : "Internal server error";

    logger.error(
      {
        err: error,
        requestId,
        statusCode,
      },
      normalizedError.message,
    );

    response.status(statusCode).json(
      buildErrorResponse(message, {
        errors: normalizedError.details,
        requestId,
        stack: !isProduction ? normalizedError.stack : undefined,
      }),
    );
  };
};

export const errorHandlerMiddleware: ErrorRequestHandler = createErrorHandler();
