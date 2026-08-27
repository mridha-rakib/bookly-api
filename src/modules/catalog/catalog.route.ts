import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { env } from "../../config/env.js";
import { AddonRepository } from "../addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../addons/addon-service-assignment.repository.js";
import {
  createAuthenticateAccessTokenMiddleware,
  createOptionalAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireApprovedBusiness,
  requireRoles,
} from "../auth/auth.middleware.js";
import { TokenService } from "../auth/token.service.js";
import { AvailabilityService } from "../availability/availability.service.js";
import { BookingSlotReservationRepository } from "../booking-slot-reservation/booking-slot-reservation.repository.js";
import { BusinessRepository } from "../business/business.repository.js";
import { BusinessBookingSettingsRepository } from "../business-booking-settings/business-booking-settings.repository.js";
import { BusinessHoursRepository } from "../business-hours/business-hours.repository.js";
import { BusinessMediaRepository } from "../business-media/business-media.repository.js";
import { BusinessTravelSettingsRepository } from "../business-travel-settings/business-travel-settings.repository.js";
import { ServiceRepository } from "../services/service.repository.js";
import { SessionRepository } from "../session/session.repository.js";
import { StaffRepository } from "../staff/staff.repository.js";
import { StaffScheduleRepository } from "../staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../staff/staff-time-off.repository.js";
import { StaffAvatarRepository } from "../staff-avatar/staff-avatar.repository.js";
import { StaffAvatarService } from "../staff-avatar/staff-avatar.service.js";
import { createDeferredStorageServiceFromEnv } from "../storage/storage.service.js";
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
 * authorization. Reuses AvailabilityService/ServiceRepository/AddonRepository/
 * StaffRepository directly (see catalog.service.ts's own doc comment) — no booking/pricing/
 * eligibility logic is re-implemented here.
 *
 * Authorization split (Phase: public Explore/Venue):
 *  - `GET /catalog/businesses/:businessId` is genuinely PUBLIC (optional-auth) — the venue
 *    detail page is browsable by unregistered visitors.
 *  - the `/services/:serviceId/addons` and `/availability` sub-routes stay CUSTOMER-only — they
 *    are the booking wizard's own reads, and booking requires authentication.
 *  - both keep `requireApprovedBusiness` (APPROVED/WARNING only; PENDING/SUSPENDED -> 403).
 */
export const createCatalogRoute = (): Router => {
  const router = Router();

  const userRepository = new UserRepository();
  const sessionRepository = new SessionRepository();
  const tokenService = new TokenService(sessionRepository);
  const authenticate = createAuthenticateAccessTokenMiddleware(tokenService, userRepository);
  const optionalAuthenticate = createOptionalAuthenticateAccessTokenMiddleware(
    tokenService,
    userRepository,
  );

  const businessRepository = new BusinessRepository();
  const serviceRepository = new ServiceRepository();
  const addonRepository = new AddonRepository();
  const addonServiceAssignmentRepository = new AddonServiceAssignmentRepository();
  const staffRepository = new StaffRepository();
  const staffScheduleRepository = new StaffScheduleRepository();
  const staffTimeOffRepository = new StaffTimeOffRepository();
  const businessHoursRepository = new BusinessHoursRepository();
  const businessMediaRepository = new BusinessMediaRepository();
  const businessBookingSettingsRepository = new BusinessBookingSettingsRepository();
  const businessTravelSettingsRepository = new BusinessTravelSettingsRepository();
  const reservationRepository = new BookingSlotReservationRepository();
  const staffAvatarRepository = new StaffAvatarRepository();
  const storageService = createDeferredStorageServiceFromEnv();
  const staffAvatarService = new StaffAvatarService(
    staffAvatarRepository,
    businessRepository,
    staffRepository,
    storageService,
    { maxUploadBytes: env.STAFF_AVATAR_MAX_UPLOAD_BYTES },
  );

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
    businessHoursRepository,
    businessMediaRepository,
    staffAvatarService,
    storageService,
  );
  const controller = new CatalogController(catalogService);

  // The venue detail read is genuinely PUBLIC — an unregistered visitor opening a shared
  // `/venue?id=...` link must see the business identity, its ACTIVE bookable services, team,
  // about, hours and gallery with no account. `optionalAuthenticate` still attaches
  // `request.auth` when a valid token IS present (never rejects its absence), and
  // `requireActiveUser()` still blocks a SUSPENDED logged-in caller. `requireApprovedBusiness`
  // keeps the canonical public-visibility rule unchanged: only APPROVED/WARNING businesses
  // resolve — PENDING/SUSPENDED stay hidden (403), matching Discovery's PUBLICLY_VISIBLE_STATUSES.
  router.get(
    "/businesses/:businessId",
    optionalAuthenticate,
    requireActiveUser(),
    validateRequest({ params: catalogBusinessParamsSchema }),
    requireApprovedBusiness(businessRepository),
    asyncHandler(controller.getBusinessCatalog),
  );

  // The add-ons and availability reads drive the booking wizard itself, so they stay
  // CUSTOMER-authenticated exactly as before (Batch 11 policy). A logged-out visitor is sent to
  // the customer login/register flow before the wizard ever opens (see the frontend venue page),
  // so these never need an anonymous path. Same PENDING/SUSPENDED block as the public read above.
  router.get(
    "/businesses/:businessId/services/:serviceId/addons",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    validateRequest({ params: catalogServiceParamsSchema }),
    requireApprovedBusiness(businessRepository),
    asyncHandler(controller.listServiceAddons),
  );

  router.get(
    "/businesses/:businessId/services/:serviceId/availability",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    validateRequest({ params: catalogServiceParamsSchema, query: catalogAvailabilityQuerySchema }),
    requireApprovedBusiness(businessRepository),
    asyncHandler(controller.getServiceAvailability),
  );

  return router;
};
