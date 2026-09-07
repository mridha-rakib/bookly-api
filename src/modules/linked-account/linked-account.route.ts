import { type RequestHandler, Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { requireActiveUser, requireRoles } from "../auth/auth.middleware.js";
import type { LinkedAccountController } from "./linked-account.controller.js";
import {
  appleLinkCallbackBodySchema,
  facebookLinkCallbackQuerySchema,
  googleLinkCallbackQuerySchema,
  unlinkLinkedAccountBodySchema,
} from "./linked-account.schema.js";

type LinkedAccountRouteDeps = {
  /** The access-token middleware already built in auth.route.ts (closes over TokenService +
   * UserRepository) — injected so this module never re-constructs auth infrastructure. */
  authenticate: RequestHandler;
  controller: LinkedAccountController;
  authorizeUrlLimiter: RequestHandler;
  unlinkLimiter: RequestHandler;
};

/** Same linkable role set for every provider — SUPER_ADMIN is excluded (no admin link surface);
 * SUPERVISOR / STAFF were added in Phase 2D so a staff member who joined with a password can add
 * a provider from settings later. */
const LINKABLE_ROLES = ["CUSTOMER", "BUSINESS_OWNER", "SUPERVISOR", "STAFF"] as const;

/**
 * Mounted with `router.use(...)` inside createAuthRoute() so its paths sit under `/auth`. The
 * authorize-url + unlink endpoints are gated authenticate + requireActiveUser + requireRoles;
 * each OAuth callback is deliberately public — the provider redirects the browser to it with no
 * Authorization header, and its security comes from the signed `state` param instead (see
 * LinkedAccountService). createAuthRoute() applies no router-wide auth gate, so no special mount
 * ordering is needed.
 *
 * Facebook here is account-LINKING only. "Continue with Facebook" login/signup is a separate,
 * unbuilt concern and must never point at these routes (they require an authenticated user).
 */
export const createLinkedAccountRoute = (deps: LinkedAccountRouteDeps): Router => {
  const router = Router();
  const { authenticate, controller, authorizeUrlLimiter, unlinkLimiter } = deps;

  // --- Google ---
  router.get(
    "/me/linked-accounts/google/authorize-url",
    authenticate,
    requireActiveUser(),
    requireRoles([...LINKABLE_ROLES]),
    authorizeUrlLimiter,
    asyncHandler(controller.getGoogleAuthorizeUrl),
  );

  router.delete(
    "/me/linked-accounts/google",
    authenticate,
    requireActiveUser(),
    requireRoles([...LINKABLE_ROLES]),
    unlinkLimiter,
    validateRequest({ body: unlinkLinkedAccountBodySchema }),
    asyncHandler(controller.unlinkGoogle),
  );

  router.get(
    "/oauth/google/callback",
    validateRequest({ query: googleLinkCallbackQuerySchema }),
    asyncHandler(controller.handleGoogleCallback),
  );

  // --- Facebook (linking only) ---
  router.get(
    "/me/linked-accounts/facebook/authorize-url",
    authenticate,
    requireActiveUser(),
    requireRoles([...LINKABLE_ROLES]),
    authorizeUrlLimiter,
    asyncHandler(controller.getFacebookAuthorizeUrl),
  );

  router.delete(
    "/me/linked-accounts/facebook",
    authenticate,
    requireActiveUser(),
    requireRoles([...LINKABLE_ROLES]),
    unlinkLimiter,
    validateRequest({ body: unlinkLinkedAccountBodySchema }),
    asyncHandler(controller.unlinkFacebook),
  );

  router.get(
    "/oauth/facebook/callback",
    validateRequest({ query: facebookLinkCallbackQuerySchema }),
    asyncHandler(controller.handleFacebookCallback),
  );

  // --- Apple (linking only) ---
  router.get(
    "/me/linked-accounts/apple/authorize-url",
    authenticate,
    requireActiveUser(),
    requireRoles([...LINKABLE_ROLES]),
    authorizeUrlLimiter,
    asyncHandler(controller.getAppleAuthorizeUrl),
  );

  router.delete(
    "/me/linked-accounts/apple",
    authenticate,
    requireActiveUser(),
    requireRoles([...LINKABLE_ROLES]),
    unlinkLimiter,
    validateRequest({ body: unlinkLinkedAccountBodySchema }),
    asyncHandler(controller.unlinkApple),
  );

  // Apple uses response_mode=form_post — a cross-site POST with the fields in the urlencoded body
  // (parsed by the global express.urlencoded). Public: trust is the signed `state` + the id_token
  // `nonce` claim, never a session or a nonce cookie.
  router.post(
    "/oauth/apple/callback",
    validateRequest({ body: appleLinkCallbackBodySchema }),
    asyncHandler(controller.handleAppleCallback),
  );

  return router;
};
