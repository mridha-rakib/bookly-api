import type { Response } from "express";

import type { ErrorDetail } from "../errors/app-error.js";

type SuccessPayload<T> = {
  success: true;
  message: string;
  data?: T;
};

type ErrorPayload = {
  success: false;
  message: string;
  errors?: ErrorDetail[];
  requestId?: string;
  stack?: string;
};

export const buildSuccessResponse = <T>(message: string, data?: T): SuccessPayload<T> => ({
  success: true,
  message,
  ...(data === undefined ? {} : { data }),
});

export const buildErrorResponse = (
  message: string,
  options: {
    errors?: ErrorDetail[] | undefined;
    requestId?: string | undefined;
    stack?: string | undefined;
  } = {},
): ErrorPayload => ({
  success: false,
  message,
  ...(options.errors?.length ? { errors: options.errors } : {}),
  ...(options.requestId ? { requestId: options.requestId } : {}),
  ...(options.stack ? { stack: options.stack } : {}),
});

export const sendSuccess = <T>(
  response: Response,
  statusCode: number,
  message: string,
  data?: T,
): void => {
  response.status(statusCode).json(buildSuccessResponse(message, data));
};
