import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { env } from "../../config/env.js";
import { Argon2PasswordHasher } from "../auth/password-hasher.js";
import { BusinessRepository } from "../business/business.repository.js";
import { EmailOutboxService } from "../email-outbox/email-outbox.service.js";
import { StaffAccessNotifier } from "../notification/staff-access.notifier.js";
import { StaffAvatarRepository } from "../staff-avatar/staff-avatar.repository.js";
import { StaffAvatarService } from "../staff-avatar/staff-avatar.service.js";
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
  staffTimeOffParamsSchema,
  updateStaffBodySchema,
} from "./staff.schema.js";
import { StaffService } from "./staff.service.js";
import { StaffAccessEventRepository } from "./staff-access-event.repository.js";
import { StaffScheduleRepository } from "./staff-schedule.repository.js";
import { StaffTimeOffRepository } from "./staff-time-off.repository.js";

/**
 * Mounted inside business.route.ts, underneath its existing
 * `requireRoles(["BUSINESS_OWNER"])` gate — staff creation/removal/core-identity editing
 * is BUSINESS_OWNER-only in this phase (Supervisor "manage staff schedules" is a narrower,
 * later-phase permission, not "manage staff accounts").
 */
export const createStaffRoute = (): Router => {
  const router = Router({ mergeParams: true });
  const staffRepository = new StaffRepository();
  const businessRepository = new BusinessRepository();
  const userRepository = new UserRepository();
  const passwordHasher = new Argon2PasswordHasher();
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
  const service = new StaffService(
    staffRepository,
    businessRepository,
    userRepository,
    passwordHasher,
    emailOtpProvider,
    staffScheduleRepository,
    staffTimeOffRepository,
    staffAvatarService,
    new StaffAccessNotifier(new EmailOutboxService(), userRepository),
    staffAccessEventRepository,
  );
  const controller = new StaffController(service);

  router.get(
    "/:businessId/staff",
    validateRequest({ params: staffBusinessParamsSchema }),
    asyncHandler(controller.list),
  );
  router.post(
    "/:businessId/staff",
    validateRequest({ params: staffBusinessParamsSchema, body: createStaffBodySchema }),
    asyncHandler(controller.create),
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

  router.get(
    "/:businessId/staff/:staffId/schedule",
    validateRequest({ params: staffIdParamsSchema }),
    asyncHandler(controller.getSchedule),
  );
  router.put(
    "/:businessId/staff/:staffId/schedule",
    validateRequest({ params: staffIdParamsSchema, body: putStaffScheduleBodySchema }),
    asyncHandler(controller.putSchedule),
  );

  router.get(
    "/:businessId/staff/:staffId/time-off",
    validateRequest({ params: staffIdParamsSchema }),
    asyncHandler(controller.listTimeOff),
  );
  router.post(
    "/:businessId/staff/:staffId/time-off",
    validateRequest({ params: staffIdParamsSchema, body: createStaffTimeOffBodySchema }),
    asyncHandler(controller.createTimeOff),
  );
  router.delete(
    "/:businessId/staff/:staffId/time-off/:timeOffId",
    validateRequest({ params: staffTimeOffParamsSchema }),
    asyncHandler(controller.removeTimeOff),
  );

  return router;
};
