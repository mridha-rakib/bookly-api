import { type RequestHandler, Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import type { ProfessionalFacebookAuthController } from "./professional-facebook-auth.controller.js";
import {
  professionalFacebookCallbackQuerySchema,
  professionalFacebookStartQuerySchema,
} from "./professional-facebook-auth.schema.js";

type ProfessionalFacebookAuthRouteDeps = {
  controller: ProfessionalFacebookAuthController;
  startLimiter: RequestHandler;
  callbackLimiter: RequestHandler;
};

/**
 * Both routes are deliberately public: `start` is the unauthenticated "Continue with Facebook"
 * entry point (it validates the required `visitType` and signs it into the state), and Facebook
 * redirects the browser to `callback` with no Authorization header. Security comes from the
 * signed `state` + its matching professional Facebook nonce cookie, never from a session. This is
 * LOGIN — it never reuses the authenticated link route. Mounted with `router.use(...)` inside
 * createAuthRoute() so both paths sit under `/auth`.
 */
export const createProfessionalFacebookAuthRoute = (
  deps: ProfessionalFacebookAuthRouteDeps,
): Router => {
  const router = Router();
  const { controller, startLimiter, callbackLimiter } = deps;

  router.get(
    "/professional/oauth/facebook/start",
    startLimiter,
    validateRequest({ query: professionalFacebookStartQuerySchema }),
    asyncHandler(controller.start),
  );

  router.get(
    "/professional/oauth/facebook/callback",
    callbackLimiter,
    validateRequest({ query: professionalFacebookCallbackQuerySchema }),
    asyncHandler(controller.callback),
  );

  return router;
};
