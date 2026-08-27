import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { BusinessRepository } from "../business/business.repository.js";
import { IntegrationController } from "./integration.controller.js";
import { IntegrationRepository } from "./integration.repository.js";
import {
  googleCalendarCallbackQuerySchema,
  integrationBusinessParamsSchema,
} from "./integration.schema.js";
import { IntegrationService } from "./integration.service.js";

const buildController = (): IntegrationController => {
  const integrationRepository = new IntegrationRepository();
  const businessRepository = new BusinessRepository();
  const service = new IntegrationService(integrationRepository, businessRepository);

  return new IntegrationController(service);
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
