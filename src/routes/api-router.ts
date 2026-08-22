import { Router } from "express";

import type { DatabaseStateReader } from "../database/database-manager.js";
import { createAuthRoute } from "../modules/auth/auth.route.js";
import { createAvailabilityRoute } from "../modules/availability/availability.route.js";
import {
  createBusinessBookingRoute,
  createCustomerBookingRoute,
} from "../modules/booking/booking.route.js";
import { createBusinessRoute } from "../modules/business/business.route.js";
import { createClientRoute } from "../modules/client/client.route.js";
import { HealthController } from "../modules/health/health.controller.js";
import { HealthRepository } from "../modules/health/health.repository.js";
import { createReadinessHealthRoute } from "../modules/health/health.route.js";
import { HealthService } from "../modules/health/health.service.js";
import { createPaymentRoute } from "../modules/payment/payment.route.js";

export const createApiRouter = (databaseStateReader: DatabaseStateReader): Router => {
  const router = Router();
  const healthRepository = new HealthRepository(databaseStateReader);
  const healthService = new HealthService(healthRepository);
  const healthController = new HealthController(healthService);

  router.use("/health", createReadinessHealthRoute(healthController));
  router.use("/auth", createAuthRoute());
  // createClientRoute() is mounted first: it applies auth per-route (not a blanket gate), so
  // it only intercepts requests it actually owns (/:businessId/clients...) and everything else
  // falls through untouched to createBusinessRoute()'s stricter BUSINESS_OWNER-only gate below.
  // Registering it after would be broken — createBusinessRoute()'s router-wide
  // requireRoles(["BUSINESS_OWNER"]) would reject SUPERVISOR before this router is ever reached.
  router.use("/businesses", createClientRoute());
  // Same rationale as createClientRoute() above — Availability applies auth per-route
  // (Owner-or-Supervisor, not blanket Owner-only), so it must be registered before
  // createBusinessRoute()'s stricter router-wide gate.
  router.use("/businesses", createAvailabilityRoute());
  // Same rationale — Booking management applies auth per-route (Owner-or-Supervisor, plus the
  // Customer-scoped preview endpoint), so it must be registered before createBusinessRoute()'s
  // stricter router-wide gate.
  router.use("/businesses", createBusinessBookingRoute());
  router.use("/businesses", createBusinessRoute());
  // Customer self-service "My Bookings" surface — cross-business, never nested under
  // /businesses/:businessId (see createCustomerBookingRoute's own comment).
  router.use("/me", createCustomerBookingRoute());
  // Customer saved-card management — cross-business, same rationale as "My Bookings" above.
  router.use("/payments", createPaymentRoute());

  return router;
};
