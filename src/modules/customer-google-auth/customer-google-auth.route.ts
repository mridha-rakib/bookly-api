import { type RequestHandler, Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import type { CustomerGoogleAuthController } from "./customer-google-auth.controller.js";
import { customerGoogleCallbackQuerySchema } from "./customer-google-auth.schema.js";

type CustomerGoogleAuthRouteDeps = {
  controller: CustomerGoogleAuthController;
  startLimiter: RequestHandler;
  callbackLimiter: RequestHandler;
};

/**
 * Both routes are deliberately public: `start` is the unauthenticated "Continue with Google"
 * entry point, and Google redirects the browser to `callback` with no Authorization header.
 * Security comes from the signed `state` + its matching nonce cookie (see
 * customer-google-auth.state.ts / .nonce.ts), never from a session. Mounted with `router.use(...)`
 * inside createAuthRoute() so both paths sit under `/auth`; that router applies no router-wide
 * auth gate, so no special mount ordering is needed.
 */
export const createCustomerGoogleAuthRoute = (deps: CustomerGoogleAuthRouteDeps): Router => {
  const router = Router();
  const { controller, startLimiter, callbackLimiter } = deps;

  router.get("/customer/oauth/google/start", startLimiter, asyncHandler(controller.start));

  router.get(
    "/customer/oauth/google/callback",
    callbackLimiter,
    validateRequest({ query: customerGoogleCallbackQuerySchema }),
    asyncHandler(controller.callback),
  );

  return router;
};
