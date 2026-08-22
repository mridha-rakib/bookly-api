import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { AddonRepository } from "../addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../addons/addon-service-assignment.repository.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../auth/auth.middleware.js";
import { TokenService } from "../auth/token.service.js";
import { BookingRepository } from "../booking/booking.repository.js";
import { BookingService } from "../booking/booking.service.js";
import { BookingSlotReservationRepository } from "../booking-slot-reservation/booking-slot-reservation.repository.js";
import { BusinessRepository } from "../business/business.repository.js";
import { BusinessBookingSettingsRepository } from "../business-booking-settings/business-booking-settings.repository.js";
import { BusinessHoursRepository } from "../business-hours/business-hours.repository.js";
import { BusinessTravelSettingsRepository } from "../business-travel-settings/business-travel-settings.repository.js";
import { ClientRepository } from "../client/client.repository.js";
import { ServiceRepository } from "../services/service.repository.js";
import { SessionRepository } from "../session/session.repository.js";
import { StaffRepository } from "../staff/staff.repository.js";
import { StaffScheduleRepository } from "../staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../staff/staff-time-off.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { AvailabilityController } from "./availability.controller.js";
import { availabilityParamsSchema, getAvailabilityQuerySchema } from "./availability.schema.js";
import { AvailabilityService } from "./availability.service.js";

/**
 * A standalone, top-level route (not nested under business.route.ts's Owner-only gate) —
 * Availability read access is Owner-or-active-Supervisor (see
 * BookingService.requireBookingManagementAccess, reused by AvailabilityController), the same
 * management-preview scope Booking itself will eventually use. A genuinely public/customer-
 * facing read path does not exist yet anywhere in this codebase (confirmed: no unauthenticated
 * business-browsing API) and is out of this batch's scope — see the Batch 2 final report.
 */
export const createAvailabilityRoute = (): Router => {
  const router = Router();

  const userRepository = new UserRepository();
  const sessionRepository = new SessionRepository();
  const tokenService = new TokenService(sessionRepository);
  const authenticate = createAuthenticateAccessTokenMiddleware(tokenService, userRepository);

  const businessRepository = new BusinessRepository();
  const serviceRepository = new ServiceRepository();
  const staffRepository = new StaffRepository();
  const staffScheduleRepository = new StaffScheduleRepository();
  const staffTimeOffRepository = new StaffTimeOffRepository();
  const businessHoursRepository = new BusinessHoursRepository();
  const businessBookingSettingsRepository = new BusinessBookingSettingsRepository();
  const businessTravelSettingsRepository = new BusinessTravelSettingsRepository();
  const reservationRepository = new BookingSlotReservationRepository();

  const availabilityService = new AvailabilityService(
    businessRepository,
    serviceRepository,
    staffRepository,
    staffScheduleRepository,
    staffTimeOffRepository,
    businessHoursRepository,
    businessBookingSettingsRepository,
    businessTravelSettingsRepository,
    reservationRepository,
  );

  const bookingService = new BookingService(
    businessRepository,
    staffRepository,
    serviceRepository,
    new AddonRepository(),
    new AddonServiceAssignmentRepository(),
    new ClientRepository(),
    new BookingRepository(),
  );

  const controller = new AvailabilityController(availabilityService, bookingService);

  router.get(
    "/:businessId/services/:serviceId/availability",
    authenticate,
    requireActiveUser(),
    requireRoles(["BUSINESS_OWNER", "SUPERVISOR"]),
    validateRequest({ params: availabilityParamsSchema, query: getAvailabilityQuerySchema }),
    asyncHandler(controller.get),
  );

  return router;
};
