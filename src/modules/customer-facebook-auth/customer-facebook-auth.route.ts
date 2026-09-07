import { type RequestHandler, Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import type { CustomerFacebookAuthController } from "./customer-facebook-auth.controller.js";
import { customerFacebookCallbackQuerySchema } from "./customer-facebook-auth.schema.js";

type CustomerFacebookAuthRouteDeps = {
  controller: CustomerFacebookAuthController;
  startLimiter: RequestHandler;
  callbackLimiter: RequestHandler;
};

/**
 * Both routes are deliberately public: `start` is the unauthenticated "Continue with Facebook"
 * entry point, and Facebook redirects the browser to `callback` with no Authorization header.
 * Security comes from the signed `state` + its matching nonce cookie
 * (customer-facebook-auth.state.ts / .nonce.ts), never from a session. This is LOGIN — it never
 * reuses the authenticated `GET /auth/me/linked-accounts/facebook/authorize-url` link route.
 * Mounted with `router.use(...)` inside createAuthRoute() so both paths sit under `/auth`.
 */
export const createCustomerFacebookAuthRoute = (deps: CustomerFacebookAuthRouteDeps): Router => {
  const router = Router();
  const { controller, startLimiter, callbackLimiter } = deps;

  router.get("/customer/oauth/facebook/start", startLimiter, asyncHandler(controller.start));

  router.get(
    "/customer/oauth/facebook/callback",
    callbackLimiter,
    validateRequest({ query: customerFacebookCallbackQuerySchema }),
    asyncHandler(controller.callback),
  );

  return router;
};
