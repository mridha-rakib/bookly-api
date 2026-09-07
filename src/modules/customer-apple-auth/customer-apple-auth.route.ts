import { type RequestHandler, Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import type { CustomerAppleAuthController } from "./customer-apple-auth.controller.js";
import { customerAppleCallbackBodySchema } from "./customer-apple-auth.schema.js";

type CustomerAppleAuthRouteDeps = {
  controller: CustomerAppleAuthController;
  startLimiter: RequestHandler;
  callbackLimiter: RequestHandler;
};

/**
 * `start` is a public GET that 302s to Apple. `callback` is a public POST — Apple uses
 * `response_mode=form_post`, so the fields arrive in the urlencoded body (global
 * `express.urlencoded`). Security is the signed `state` + the Apple id_token `nonce` claim, never
 * a session and never a nonce cookie. This is LOGIN — it never reuses the authenticated
 * `/auth/me/linked-accounts/apple/authorize-url` link route.
 */
export const createCustomerAppleAuthRoute = (deps: CustomerAppleAuthRouteDeps): Router => {
  const router = Router();
  const { controller, startLimiter, callbackLimiter } = deps;

  router.get("/customer/oauth/apple/start", startLimiter, asyncHandler(controller.start));

  router.post(
    "/customer/oauth/apple/callback",
    callbackLimiter,
    validateRequest({ body: customerAppleCallbackBodySchema }),
    asyncHandler(controller.callback),
  );

  return router;
};
