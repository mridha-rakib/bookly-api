import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { env } from "../../config/env.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../auth/auth.middleware.js";
import { TokenService } from "../auth/token.service.js";
import { BusinessRepository } from "../business/business.repository.js";
import { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import { StaffAccessNotifier } from "../notification/staff-access.notifier.js";
import { ServiceRepository } from "../services/service.repository.js";
import { SessionRepository } from "../session/session.repository.js";
import { StaffAvatarRepository } from "../staff-avatar/staff-avatar.repository.js";
import { StaffAvatarService } from "../staff-avatar/staff-avatar.service.js";
import { StaffInvitationRepository } from "../staff-invitation/staff-invitation.repository.js";
import { StaffInvitationService } from "../staff-invitation/staff-invitation.service.js";
import { createDeferredStorageServiceFromEnv } from "../storage/storage.service.js";
import { UserRepository } from "../user/user.repository.js";
import { createEmailOtpProvider } from "../verification/email-otp.provider.js";
import { StaffController } from "./staff.controller.js";
import { StaffRepository } from "./staff.repository.js";
import {
  createStaffBodySchema,
  createStaffTimeOffBodySchema,
  putStaffScheduleBodySchema,
  staffBusinessParamsSchema,
  staffIdParamsSchema,
  staffInvitationParamsSchema,
  staffTimeOffParamsSchema,
  updateStaffBodySchema,
} from "./staff.schema.js";
import { StaffService } from "./staff.service.js";
import { StaffAccessEventRepository } from "./staff-access-event.repository.js";
import { StaffScheduleRepository } from "./staff-schedule.repository.js";
import { StaffTimeOffRepository } from "./staff-time-off.repository.js";

/**
 * Both route factories below build their own, independent StaffService instance — same
 * per-router self-contained wiring convention already used across every other module
 * (e.g. availability.route.ts, business.route.ts's sub-routers each re-instantiate their own
 * repositories/services rather than sharing a DI container).
 */
const buildStaffService = (): StaffService => {
  const staffRepository = new StaffRepository();
  const businessRepository = new BusinessRepository();
  const userRepository = new UserRepository();
  const staffInvitationService = new StaffInvitationService(
    new StaffInvitationRepository(),
    userRepository,
  );
  const emailOtpProvider = createEmailOtpProvider();
  const staffScheduleRepository = new StaffScheduleRepository();
  const staffTimeOffRepository = new StaffTimeOffRepository();
  const staffAccessEventRepository = new StaffAccessEventRepository();
  const staffAvatarRepository = new StaffAvatarRepository();
  const staffAvatarStorageService = createDeferredStorageServiceFromEnv();
  const staffAvatarService = new StaffAvatarService(
    staffAvatarRepository,
    businessRepository,
    staffRepository,
    staffAvatarStorageService,
    { maxUploadBytes: env.STAFF_AVATAR_MAX_UPLOAD_BYTES },
  );

  return new StaffService(
    staffRepository,
    businessRepository,
    userRepository,
    staffInvitationService,
    emailOtpProvider,
    staffScheduleRepository,
    staffTimeOffRepository,
    staffAvatarService,
    new StaffAccessNotifier(new EmailOutboxService(), userRepository),
    staffAccessEventRepository,
    new ServiceRepository(),
  );
};

/**
 * Mounted inside business.route.ts, underneath its existing
 * `requireRoles(["BUSINESS_OWNER"])` gate — staff account creation/removal/core-identity
 * editing and invitation management stay BUSINESS_OWNER-only in this phase. Staff list read
 * and schedule/time-off (Owner-or-Supervisor) live in {@link createStaffScheduleRoute} instead,
 * mounted as a standalone top-level route the same way client.route.ts/availability.route.ts
 * are, specifically so Supervisor reaches them before this router's stricter gate would 403.
 */
export const createStaffRoute = (): Router => {
  const router = Router({ mergeParams: true });
  const controller = new StaffController(buildStaffService());

  router.post(
    "/:businessId/staff",
    validateRequest({ params: staffBusinessParamsSchema, body: createStaffBodySchema }),
    asyncHandler(controller.create),
  );
  // Phase 2D — pending-invitation management (owner-only, same gate as the rest of this router).
  router.post(
    "/:businessId/staff/invitations/:invitationId/resend",
    validateRequest({ params: staffInvitationParamsSchema }),
    asyncHandler(controller.resendInvitation),
  );
  router.delete(
    "/:businessId/staff/invitations/:invitationId",
    validateRequest({ params: staffInvitationParamsSchema }),
    asyncHandler(controller.revokeInvitation),
  );
  router.patch(
    "/:businessId/staff/:staffId",
    validateRequest({ params: staffIdParamsSchema, body: updateStaffBodySchema }),
    asyncHandler(controller.update),
  );
  router.delete(
    "/:businessId/staff/:staffId",
    validateRequest({ params: staffIdParamsSchema }),
    asyncHandler(controller.remove),
  );

  return router;
};

/**
 * Phase 4A — staff list read + schedule/time-off (Owner-or-Supervisor), plus Staff/Supervisor
 * self-service "my schedule"/"my assigned services" (Owner-or-Supervisor-or-Staff). A standalone
 * top-level route, NOT nested under business.route.ts's router-wide
 * `requireRoles(["BUSINESS_OWNER"])` gate — same rationale and mounting convention as
 * client.route.ts/availability.route.ts/createBusinessBookingRoute (per-route auth, registered
 * on "/businesses" before createBusinessRoute() in api-router.ts).
 *
 * The `/staff/me/...` routes are registered BEFORE the `/staff/:staffId/...` routes below: with
 * these mounted on the same "/staff" prefix, Express would otherwise match "me" as a literal
 * `:staffId` value first (failing staffIdParamsSchema's ObjectId regex) before ever reaching
 * the dedicated `/me` handlers.
 */
export const createStaffScheduleRoute = (): Router => {
  const router = Router();
  const userRepository = new UserRepository();
  const sessionRepository = new SessionRepository();
  const tokenService = new TokenService(sessionRepository);
  const authenticate = createAuthenticateAccessTokenMiddleware(tokenService, userRepository);
  const controller = new StaffController(buildStaffService());

  const ownerOrSupervisor = [
    authenticate,
    requireActiveUser(),
    requireRoles(["BUSINESS_OWNER", "SUPERVISOR"]),
  ];
  const anyStaffRole = [
    authenticate,
    requireActiveUser(),
    requireRoles(["BUSINESS_OWNER", "SUPERVISOR", "STAFF"]),
  ];

  router.get(
    "/:businessId/staff/me/schedule",
    ...anyStaffRole,
    validateRequest({ params: staffBusinessParamsSchema }),
    asyncHandler(controller.getMySchedule),
  );
  router.get(
    "/:businessId/staff/me/services",
    ...anyStaffRole,
    validateRequest({ params: staffBusinessParamsSchema }),
    asyncHandler(controller.listMyAssignedServices),
  );

  router.get(
    "/:businessId/staff",
    ...ownerOrSupervisor,
    validateRequest({ params: staffBusinessParamsSchema }),
    asyncHandler(controller.list),
  );

  router.get(
    "/:businessId/staff/:staffId/schedule",
    ...ownerOrSupervisor,
    validateRequest({ params: staffIdParamsSchema }),
    asyncHandler(controller.getSchedule),
  );
  router.put(
    "/:businessId/staff/:staffId/schedule",
    ...ownerOrSupervisor,
    validateRequest({ params: staffIdParamsSchema, body: putStaffScheduleBodySchema }),
    asyncHandler(controller.putSchedule),
  );

  router.get(
    "/:businessId/staff/:staffId/time-off",
    ...ownerOrSupervisor,
    validateRequest({ params: staffIdParamsSchema }),
    asyncHandler(controller.listTimeOff),
  );
  router.post(
    "/:businessId/staff/:staffId/time-off",
    ...ownerOrSupervisor,
    validateRequest({ params: staffIdParamsSchema, body: createStaffTimeOffBodySchema }),
    asyncHandler(controller.createTimeOff),
  );
  router.delete(
    "/:businessId/staff/:staffId/time-off/:timeOffId",
    ...ownerOrSupervisor,
    validateRequest({ params: staffTimeOffParamsSchema }),
    asyncHandler(controller.removeTimeOff),
  );

  return router;
};
