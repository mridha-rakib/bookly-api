import type { RequestHandler } from "express";

import { NotFoundError } from "../errors/not-found-error.js";

export const notFoundMiddleware: RequestHandler = (request, _response, next) => {
  next(new NotFoundError(`Route ${request.method} ${request.originalUrl}`));
};
