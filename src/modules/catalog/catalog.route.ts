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
import { AvailabilityService } from "../availability/availability.service.js";
import { BookingSlotReservationRepository } from "../booking-slot-reservation/booking-slot-reservation.repository.js";
import { BusinessRepository } from "../business/business.repository.js";
import { BusinessBookingSettingsRepository } from "../business-booking-settings/business-booking-settings.repository.js";
import { BusinessHoursRepository } from "../business-hours/business-hours.repository.js";
import { BusinessTravelSettingsRepository } from "../business-travel-settings/business-travel-settings.repository.js";
import { ServiceRepository } from "../services/service.repository.js";
import { SessionRepository } from "../session/session.repository.js";
import { StaffRepository } from "../staff/staff.repository.js";
import { StaffScheduleRepository } from "../staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../staff/staff-time-off.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { CatalogController } from "./catalog.controller.js";
import {
  catalogAvailabilityQuerySchema,
  catalogBusinessParamsSchema,
  catalogServiceParamsSchema,
} from "./catalog.schema.js";
import { CatalogService } from "./catalog.service.js";

/**
 * Batch 9 — the customer-facing "browse a known Business and book" surface, mounted at its own
 * top-level `/catalog` prefix (never `/businesses/...`) specifically so it can never collide
 * with `business.route.ts`'s Owner-only-gated `/businesses/:businessId` or
 * `availability.route.ts`'s Owner/Supervisor-only `/businesses/:businessId/services/:serviceId/
 * availability` — same path shapes, deliberately different prefix, deliberately different
 * (CUSTOMER-only) authorization. Reuses AvailabilityService/ServiceRepository/AddonRepository/
 * StaffRepository directly (see catalog.service.ts's own doc comment) — no booking/pricing/
 * eligibility logic is re-implemented here.
 */
export const createCatalogRoute = (): Router => {
  const router = Router();

  const userRepository = new UserRepository();
  const sessionRepository = new SessionRepository();
  const tokenService = new TokenService(sessionRepository);
  const authenticate = createAuthenticateAccessTokenMiddleware(tokenService, userRepository);

  const businessRepository = new BusinessRepository();
  const serviceRepository = new ServiceRepository();
  const addonRepository = new AddonRepository();
  const addonServiceAssignmentRepository = new AddonServiceAssignmentRepository();
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

  const catalogService = new CatalogService(
    businessRepository,
    serviceRepository,
    addonRepository,
    addonServiceAssignmentRepository,
    staffRepository,
    userRepository,
    availabilityService,
  );
  const controller = new CatalogController(catalogService);

  router.use(authenticate, requireActiveUser(), requireRoles(["CUSTOMER"]));

  router.get(
    "/businesses/:businessId",
    validateRequest({ params: catalogBusinessParamsSchema }),
    asyncHandler(controller.getBusinessCatalog),
  );

  router.get(
    "/businesses/:businessId/services/:serviceId/addons",
    validateRequest({ params: catalogServiceParamsSchema }),
    asyncHandler(controller.listServiceAddons),
  );

  router.get(
    "/businesses/:businessId/services/:serviceId/availability",
    validateRequest({ params: catalogServiceParamsSchema, query: catalogAvailabilityQuerySchema }),
    asyncHandler(controller.getServiceAvailability),
  );

  return router;
};
