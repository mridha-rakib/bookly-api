import { randomUUID } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

const requestIdPattern = /^[A-Za-z0-9._:-]+$/;
const maxRequestIdLength = 128;

const normalizeRequestId = (value: string | undefined): string => {
  const trimmed = value?.trim();

  if (!trimmed) {
    return randomUUID();
  }

  if (trimmed.length > maxRequestIdLength || !requestIdPattern.test(trimmed)) {
    return randomUUID();
  }

  return trimmed;
};

export const requestIdMiddleware = (
  request: Request,
  response: Response,
  next: NextFunction,
): void => {
  const requestId = normalizeRequestId(request.header("x-request-id"));

  request.id = requestId;
  response.setHeader("X-Request-Id", requestId);

  next();
};
