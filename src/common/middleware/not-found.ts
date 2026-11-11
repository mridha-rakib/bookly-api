import type { RequestHandler } from "express";

import { NotFoundError } from "../errors/not-found-error.js";

export const notFoundMiddleware: RequestHandler = (request, _response, next) => {
  // Unknown paths can also contain OAuth codes or tokens. Do not copy the URL
  // into an error that is logged and returned to the caller.
  next(new NotFoundError(`Route ${request.method}`));
};
