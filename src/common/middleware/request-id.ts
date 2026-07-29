import { randomUUID } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

export const requestIdMiddleware = (
  request: Request,
  response: Response,
  next: NextFunction,
): void => {
  const headerValue = request.header("x-request-id");
  const requestId = headerValue?.trim() || randomUUID();

  request.id = requestId;
  response.setHeader("X-Request-Id", requestId);

  next();
};
