import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { TokenService } from "../auth/token.service.js";
import { BookingModel } from "../booking/booking.model.js";
import { OrdinaryCalendarJournalModel } from "../booking/ordinary-calendar-journal.model.js";
import { PackageCalendarOwnerAuthority } from "../booking/package-calendar-authority.js";
import { BusinessModel } from "../business/business.model.js";
import { BusinessRepository } from "../business/business.repository.js";
import { SessionRepository } from "../session/session.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { IntegrationController } from "./integration.controller.js";
import { IntegrationRepository } from "./integration.repository.js";
import {
  bookingCalendarRecoveryBodySchema,
  bookingCalendarSyncParamsSchema,
  googleCalendarCallbackQuerySchema,
  integrationBusinessParamsSchema,
} from "./integration.schema.js";
import { IntegrationService } from "./integration.service.js";
import { OrdinaryCalendarSyncController } from "./ordinary-calendar-sync.controller.js";

const buildController = (): IntegrationController => {
  const integrationRepository = new IntegrationRepository();
  const businessRepository = new BusinessRepository();
  const service = new IntegrationService(integrationRepository, businessRepository);

  return new IntegrationController(service);
};

/** P4B-2C — production composition of the ordinary Calendar status/recovery controller. The
 * recovery service itself is default-denied by the ordinary Calendar delivery authority. */
const buildOrdinaryCalendarSyncController = (): OrdinaryCalendarSyncController => {
  const owners = new PackageCalendarOwnerAuthority(
    new TokenService(new SessionRepository()),
    new UserRepository(),
  );
  const delivery = new IntegrationService(
    new IntegrationRepository(),
    new BusinessRepository(),
  ).ordinaryCalendarDelivery();
  return new OrdinaryCalendarSyncController({
    ownsBusiness: async (userId, businessId) =>
      Boolean(await BusinessModel.exists({ _id: businessId, ownerUserId: userId }).read("primary")),
    bookingBelongsToBusiness: async (bookingId, businessId) =>
      Boolean(await BookingModel.exists({ _id: bookingId, businessId }).read("primary")),
    readJournal: (bookingId, businessId) =>
      OrdinaryCalendarJournalModel.findOne({ bookingId, businessId }).read("primary").exec(),
    authenticateOwner: (authorization) => owners.authenticate(authorization),
    recover: (input, proof) => delivery.recover(input, proof),
  });
};

/**
 * Mounted inside business.route.ts, underneath its existing `requireRoles(["BUSINESS_OWNER"])`
 * + `requireApprovedBusiness` gates (same as staff/services/addons) — Google Calendar is a
 * Business Owner-only, business-wide connection (product scope decision: one-way Bookly ->
 * Google sync, Owner-connected, not per-staff calendars).
 */
export const createIntegrationRoute = (): Router => {
  const router = Router({ mergeParams: true });
  const controller = buildController();

  router.get(
    "/:businessId/integrations/google-calendar/connect",
    validateRequest({ params: integrationBusinessParamsSchema }),
    asyncHandler(controller.connectGoogleCalendar),
  );
  router.get(
    "/:businessId/integrations/google-calendar/status",
    validateRequest({ params: integrationBusinessParamsSchema }),
    asyncHandler(controller.getGoogleCalendarStatus),
  );
  router.delete(
    "/:businessId/integrations/google-calendar",
    validateRequest({ params: integrationBusinessParamsSchema }),
    asyncHandler(controller.disconnectGoogleCalendar),
  );

  // P4B-2C — per-Booking ordinary Calendar status and exact Owner recovery.
  const calendarSync = buildOrdinaryCalendarSyncController();
  router.get(
    "/:businessId/bookings/:bookingId/calendar-sync",
    validateRequest({ params: bookingCalendarSyncParamsSchema }),
    asyncHandler(calendarSync.getStatus),
  );
  router.post(
    "/:businessId/bookings/:bookingId/calendar-sync/recovery",
    validateRequest({
      params: bookingCalendarSyncParamsSchema,
      body: bookingCalendarRecoveryBodySchema,
    }),
    asyncHandler(calendarSync.recover),
  );

  return router;
};

/**
 * Genuinely public (no `authenticate`) — same "own top-level-ish prefix, registered before
 * createBusinessRoute()'s router-wide Owner-only gate" precedent api-router.ts already uses for
 * createClientRoute/createAvailabilityRoute/createBusinessBookingRoute (see its own comments).
 * This one has to be unauthenticated for a stronger reason than those: Google redirects the
 * browser here via a plain top-level GET navigation, which cannot carry this API's Bearer access
 * token at all (there is no cookie-based auth in this codebase — see auth.middleware.ts). Its
 * security comes entirely from the signed `state` param instead (see
 * IntegrationService.handleOAuthCallback's own comment). No :businessId in the path — this exact
 * path is the static redirect_uri registered in Google Cloud Console (see
 * GOOGLE_CALENDAR_REDIRECT_URI in .env.example); Google does not template dynamic path segments
 * into a redirect_uri. Which business/owner this callback belongs to is instead recovered from
 * the signed `state` param.
 */
export const createGoogleCalendarCallbackRoute = (): Router => {
  const router = Router();
  const controller = buildController();

  router.get(
    "/integrations/google-calendar/callback",
    validateRequest({ query: googleCalendarCallbackQuerySchema }),
    asyncHandler(controller.handleGoogleCalendarCallback),
  );

  return router;
};
