import type { RequestHandler } from "express";
import { buildErrorResponse } from "../http/responses.js";

/** Reject disabled/unconfigured Apple flows before validation, provider calls or session work. */
export const requireAppleOAuth =
  (configured: () => boolean): RequestHandler =>
  (_request, response, next) => {
    if (!configured()) {
      response.status(503).json(
        buildErrorResponse("Apple sign-in is unavailable", {
          errors: [{ code: "APPLE_OAUTH_UNAVAILABLE", message: "Apple sign-in is unavailable" }],
        }),
      );
      return;
    }
    next();
  };
