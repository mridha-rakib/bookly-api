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
import { createPublicContentRoute } from "../modules/content/content.route.js";
import { createDashboardOverviewRoute } from "../modules/dashboard-overview/dashboard-overview.route.js";
import { createDiscoveryRoute } from "../modules/discovery/discovery.route.js";
import { createFavoriteRoute } from "../modules/favorite/favorite.route.js";
import { HealthController } from "../modules/health/health.controller.js";
import { HealthRepository } from "../modules/health/health.repository.js";
import { createReadinessHealthRoute } from "../modules/health/health.route.js";
import { HealthService } from "../modules/health/health.service.js";
import { createGoogleCalendarCallbackRoute } from "../modules/integration/integration.route.js";
import { createMarketingRoute } from "../modules/marketing/marketing.route.js";
import { createPaymentRoute } from "../modules/payment/payment.route.js";
import { createPlatformConfigRoute } from "../modules/platform-settings/platform-settings.route.js";
import {
  createBusinessReviewRoute,
  createCustomerReviewRoute,
  createPublicBusinessReviewRoute,
} from "../modules/review/review.route.js";
import { createSuperAdminRoute } from "../modules/super-admin/super-admin.route.js";
import { createContactRoute } from "../modules/support/contact.route.js";
import { createSupportRoute } from "../modules/support/support.route.js";

export const createApiRouter = (databaseStateReader: DatabaseStateReader): Router => {
  const router = Router();
  const healthRepository = new HealthRepository(databaseStateReader);
  const healthService = new HealthService(healthRepository);
  const healthController = new HealthController(healthService);

  router.use("/health", createReadinessHealthRoute(healthController));
  router.use("/auth", createAuthRoute());
  // Google Calendar OAuth callback — MUST be the first "/businesses" router registered. Google
  // redirects the browser here with no Authorization header at all (see its own comment in
  // integration.route.ts for why), so it cannot pass through ANY authenticated gate. Several
  // "/businesses" routers below (createBusinessReviewRoute is the one that actually intercepted
  // this route in practice) apply their `authenticate` middleware via a path-less `router.use(...)`
  // at the top of their own router — that runs for every request entering that router regardless
  // of whether any of ITS OWN routes match the path, so registering the callback after any such
  // router previously made it 401 with SESSION_EXPIRED before ever reaching the callback handler.
  // Registering it here, first, guarantees Express matches its exact static path before any later
  // "/businesses" router (present or future) gets a chance to gate it.
  router.use("/businesses", createGoogleCalendarCallbackRoute());
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
  // Batch 19 — Business dashboard Reviews read (Owner/Supervisor), same per-route-auth-before-
  // stricter-router-wide-gate rationale as createClientRoute/createAvailabilityRoute/
  // createBusinessBookingRoute above — must be registered before createBusinessRoute()'s
  // router-wide BUSINESS_OWNER-only gate or Supervisor would 403 before reaching it.
  router.use("/businesses", createBusinessReviewRoute());
  // Dashboard Overview — Owner/Supervisor/Staff, same per-route-auth-before-stricter-router-
  // wide-gate rationale as the routers above (Staff in particular has no access at all under
  // createBusinessRoute()'s router-wide BUSINESS_OWNER-only gate, so this MUST be registered
  // before it).
  router.use("/businesses", createDashboardOverviewRoute());
  router.use("/businesses", createBusinessRoute());
  // Customer self-service "My Bookings" surface — cross-business, never nested under
  // /businesses/:businessId (see createCustomerBookingRoute's own comment).
  router.use("/me", createCustomerBookingRoute());
  // Batch 14 — Customer self-service Review surface, same "/me" prefix/rationale as "My
  // Bookings" above (own booking-scoped review, cross-business).
  router.use("/me", createCustomerReviewRoute());
  // Batch 15B — Customer/Business Owner/Supervisor/Staff self-service "My Tickets" surface, same
  // "/me" prefix/rationale as "My Bookings"/"My Reviews" above (own-ticket-scoped, cross-Business).
  router.use("/me", createSupportRoute());
  // Customer saved-card management — cross-business, same rationale as "My Bookings" above.
  router.use("/payments", createPaymentRoute());
  // Batch 15B — the public Contact form's real backend. Its own top-level prefix (genuinely
  // anonymous, no `authenticate` anywhere in its chain — see createContactRoute's own comment) so
  // it can never collide with any authenticated surface above.
  router.use("/contact", createContactRoute());
  // Batch 16 — Explore's real backend. Genuinely public, its own top-level prefix — same
  // anonymous-route precedent as createContactRoute() above.
  router.use("/discovery", createDiscoveryRoute());
  // Content Manager public reads (Phase 1: FAQ only). Genuinely anonymous, its own top-level
  // prefix — same anonymous-route precedent as createContactRoute()/createDiscoveryRoute().
  // Super Admin FAQ mutations live under `/super-admin/content` (SUPER_ADMIN-gated), never here.
  router.use("/content", createPublicContentRoute());
  // Marketing Email Stage M2 — public unsubscribe. Genuinely anonymous, its own top-level prefix
  // (same precedent as createContactRoute()/createDiscoveryRoute()/createPublicContentRoute()).
  // No marketing email is sent yet; this only lets a FUTURE marketing send carry a working
  // one-click unsubscribe. Distinct `/marketing` prefix — no ordering dependency.
  router.use("/marketing", createMarketingRoute());
  // Batch 16 — Favorites, same "/me" prefix/rationale as "My Bookings"/"My Reviews"/"My Tickets"
  // above (own-resource-scoped, CUSTOMER-only, cross-Business).
  router.use("/me", createFavoriteRoute());
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
  // Anonymous read of the server-authoritative booking limit (maxServicesPerBooking) so the
  // customer / business booking UIs can mirror it. Distinct `/platform` prefix, no collision.
  router.use("/platform", createPlatformConfigRoute());

  return router;
};
