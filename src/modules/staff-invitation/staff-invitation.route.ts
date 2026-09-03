import { type RequestHandler, Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import type { StaffInvitationController } from "./staff-invitation.controller.js";
import {
  acceptStaffInvitationPasswordBodySchema,
  staffInvitationGoogleCallbackQuerySchema,
  staffInvitationGoogleStartQuerySchema,
  staffInvitationTokenQuerySchema,
} from "./staff-invitation.schema.js";

type StaffInvitationRouteDeps = {
  controller: StaffInvitationController;
  /** `loginLimiter` — same per-IP budget as password login. */
  readLimiter: RequestHandler;
  acceptLimiter: RequestHandler;
};

/**
 * All routes are deliberately PUBLIC — an invitee has no Bookly session yet. Security is the
 * opaque invitation token (hash-stored, single-use, 72h TTL), plus the signed OAuth `state` +
 * staff nonce cookie for the Google path. Mounted with `router.use(...)` inside createAuthRoute()
 * so every path sits under `/auth`.
 */
export const createStaffInvitationRoute = (deps: StaffInvitationRouteDeps): Router => {
  const router = Router();
  const { controller, readLimiter, acceptLimiter } = deps;

  router.get(
    "/staff/invitation",
    readLimiter,
    validateRequest({ query: staffInvitationTokenQuerySchema }),
    asyncHandler(controller.getInvitation),
  );

  router.post(
    "/staff/invitation/accept/password",
    acceptLimiter,
    validateRequest({ body: acceptStaffInvitationPasswordBodySchema }),
    asyncHandler(controller.acceptWithPassword),
  );

  router.get(
    "/staff/invitation/oauth/google/start",
    acceptLimiter,
    validateRequest({ query: staffInvitationGoogleStartQuerySchema }),
    asyncHandler(controller.googleStart),
  );

  router.get(
    "/staff/invitation/oauth/google/callback",
    acceptLimiter,
    validateRequest({ query: staffInvitationGoogleCallbackQuerySchema }),
    asyncHandler(controller.googleCallback),
  );

  return router;
};
