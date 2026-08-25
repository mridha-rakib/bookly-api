import { Router } from "express";

import type { DatabaseStateReader } from "../database/database-manager.js";
import { createAuthRoute } from "../modules/auth/auth.route.js";
import { createAvailabilityRoute } from "../modules/availability/availability.route.js";
import {
  createBusinessBookingRoute,
  createCustomerBookingRoute,
} from "../modules/booking/booking.route.js";
import { createBusinessRoute } from "../modules/business/business.route.js";
import { createCatalogRoute } from "../modules/catalog/catalog.route.js";
import { createClientRoute } from "../modules/client/client.route.js";
import { HealthController } from "../modules/health/health.controller.js";
import { HealthRepository } from "../modules/health/health.repository.js";
import { createReadinessHealthRoute } from "../modules/health/health.route.js";
import { HealthService } from "../modules/health/health.service.js";
import { createPaymentRoute } from "../modules/payment/payment.route.js";
import {
  createCustomerReviewRoute,
  createPublicBusinessReviewRoute,
} from "../modules/review/review.route.js";
import { createSuperAdminRoute } from "../modules/super-admin/super-admin.route.js";

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
  // Batch 14 — Customer self-service Review surface, same "/me" prefix/rationale as "My
  // Bookings" above (own booking-scoped review, cross-business).
  router.use("/me", createCustomerReviewRoute());
  // Customer saved-card management — cross-business, same rationale as "My Bookings" above.
  router.use("/payments", createPaymentRoute());
  // Super Admin's own top-level prefix — SUPER_ADMIN-only end to end (see its own comment); no
  // ordering dependency with the routers above (distinct path prefix).
  router.use("/super-admin", createSuperAdminRoute());
  // Customer-facing catalog browse/availability — its own top-level prefix specifically to
  // avoid colliding with the Owner-only `/businesses/:businessId` and `/businesses/:businessId/
  // services/:serviceId/availability` paths above (see createCatalogRoute's own comment). No
  // ordering dependency (distinct path prefix).
  router.use("/catalog", createCatalogRoute());
  // Batch 14 — public Business rating summary + Reviews list, same `/catalog` prefix and
  // CUSTOMER-authenticated "public business page" convention as createCatalogRoute() (see
  // createPublicBusinessReviewRoute's own comment on why this codebase has no true anonymous-
  // public route). Distinct path suffixes (`/reviews`, `/reviews/summary`), no collision.
  router.use("/catalog", createPublicBusinessReviewRoute());

  return router;
};
