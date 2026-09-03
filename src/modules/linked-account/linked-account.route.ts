import { type RequestHandler, Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { requireActiveUser, requireRoles } from "../auth/auth.middleware.js";
import type { LinkedAccountController } from "./linked-account.controller.js";
import {
  googleLinkCallbackQuerySchema,
  unlinkGoogleAccountBodySchema,
} from "./linked-account.schema.js";

type LinkedAccountRouteDeps = {
  /** The access-token middleware already built in auth.route.ts (closes over TokenService +
   * UserRepository) — injected so this module never re-constructs auth infrastructure. */
  authenticate: RequestHandler;
  controller: LinkedAccountController;
  authorizeUrlLimiter: RequestHandler;
  unlinkLimiter: RequestHandler;
};

/**
 * Mounted with `router.use(...)` inside createAuthRoute() so its paths sit under `/auth`. The two
 * account endpoints are gated authenticate + requireActiveUser + requireRoles(["CUSTOMER",
 * "BUSINESS_OWNER", "SUPERVISOR", "STAFF"]) — SUPER_ADMIN is excluded (no admin Google-link
 * surface); Phase 2D added SUPERVISOR / STAFF so a staff member who joined with a password can
 * add Google from settings later. The OAuth callback is deliberately public — Google redirects
 * the browser to it with no Authorization header, and its security comes from the signed `state`
 * param instead (see
 * LinkedAccountService.linkGoogleFromCallback). createAuthRoute() applies no router-wide auth
 * gate, so no special mount ordering is needed (unlike the Calendar callback under `/businesses`).
 */
export const createLinkedAccountRoute = (deps: LinkedAccountRouteDeps): Router => {
  const router = Router();
  const { authenticate, controller, authorizeUrlLimiter, unlinkLimiter } = deps;

  router.get(
    "/me/linked-accounts/google/authorize-url",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER", "BUSINESS_OWNER", "SUPERVISOR", "STAFF"]),
    authorizeUrlLimiter,
    asyncHandler(controller.getGoogleAuthorizeUrl),
  );

  router.delete(
    "/me/linked-accounts/google",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER", "BUSINESS_OWNER", "SUPERVISOR", "STAFF"]),
    unlinkLimiter,
    validateRequest({ body: unlinkGoogleAccountBodySchema }),
    asyncHandler(controller.unlinkGoogle),
  );

  router.get(
    "/oauth/google/callback",
    validateRequest({ query: googleLinkCallbackQuerySchema }),
    asyncHandler(controller.handleGoogleCallback),
  );

  return router;
};
