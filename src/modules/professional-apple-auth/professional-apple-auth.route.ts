import { type RequestHandler, Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import type { ProfessionalAppleAuthController } from "./professional-apple-auth.controller.js";
import {
  professionalAppleCallbackBodySchema,
  professionalAppleStartQuerySchema,
} from "./professional-apple-auth.schema.js";

type ProfessionalAppleAuthRouteDeps = {
  controller: ProfessionalAppleAuthController;
  startLimiter: RequestHandler;
  callbackLimiter: RequestHandler;
};

/**
 * `start` is a public GET (validates + signs the required `visitType`) that 302s to Apple.
 * `callback` is a public POST — Apple `response_mode=form_post`, fields in the urlencoded body.
 * Security is the signed `state` + the Apple id_token `nonce` claim, never a session or cookie.
 */
export const createProfessionalAppleAuthRoute = (deps: ProfessionalAppleAuthRouteDeps): Router => {
  const router = Router();
  const { controller, startLimiter, callbackLimiter } = deps;

  router.get(
    "/professional/oauth/apple/start",
    startLimiter,
    validateRequest({ query: professionalAppleStartQuerySchema }),
    asyncHandler(controller.start),
  );

  router.post(
    "/professional/oauth/apple/callback",
    callbackLimiter,
    validateRequest({ body: professionalAppleCallbackBodySchema }),
    asyncHandler(controller.callback),
  );

  return router;
};
