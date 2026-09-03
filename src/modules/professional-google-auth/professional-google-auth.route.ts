import { type RequestHandler, Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import type { ProfessionalGoogleAuthController } from "./professional-google-auth.controller.js";
import {
  professionalGoogleCallbackQuerySchema,
  professionalGoogleStartQuerySchema,
} from "./professional-google-auth.schema.js";

type ProfessionalGoogleAuthRouteDeps = {
  controller: ProfessionalGoogleAuthController;
  startLimiter: RequestHandler;
  callbackLimiter: RequestHandler;
};

/**
 * Both routes are deliberately public: `start` is the unauthenticated "Continue with Google"
 * entry point (it validates the required `visitType` and signs it into the state), and Google
 * redirects the browser to `callback` with no Authorization header. Security comes from the
 * signed `state` + its matching professional nonce cookie, never from a session. Mounted with
 * `router.use(...)` inside createAuthRoute() so both paths sit under `/auth`.
 */
export const createProfessionalGoogleAuthRoute = (
  deps: ProfessionalGoogleAuthRouteDeps,
): Router => {
  const router = Router();
  const { controller, startLimiter, callbackLimiter } = deps;

  router.get(
    "/professional/oauth/google/start",
    startLimiter,
    validateRequest({ query: professionalGoogleStartQuerySchema }),
    asyncHandler(controller.start),
  );

  router.get(
    "/professional/oauth/google/callback",
    callbackLimiter,
    validateRequest({ query: professionalGoogleCallbackQuerySchema }),
    asyncHandler(controller.callback),
  );

  return router;
};
