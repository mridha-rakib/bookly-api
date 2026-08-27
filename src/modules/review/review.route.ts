import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import {
  createAuthenticateAccessTokenMiddleware,
  createOptionalAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireApprovedBusiness,
  requireRoles,
} from "../auth/auth.middleware.js";
import { TokenService } from "../auth/token.service.js";
import { BookingRepository } from "../booking/booking.repository.js";
import { BusinessRepository } from "../business/business.repository.js";
import { SessionRepository } from "../session/session.repository.js";
import { StaffRepository } from "../staff/staff.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { ReviewController } from "./review.controller.js";
import { ReviewRepository } from "./review.repository.js";
import {
  bookingIdReviewParamsSchema,
  businessIdParamsSchema,
  listPublicReviewsQuerySchema,
  reviewWriteBodySchema,
} from "./review.schema.js";
import { ReviewService } from "./review.service.js";

const buildController = (): ReviewController =>
  new ReviewController(
    new ReviewService(
      new ReviewRepository(),
      new BookingRepository(),
      new BusinessRepository(),
      new StaffRepository(),
    ),
  );

const buildAuthenticate = () => {
  const userRepository = new UserRepository();
  const sessionRepository = new SessionRepository();
  const tokenService = new TokenService(sessionRepository);
  return createAuthenticateAccessTokenMiddleware(tokenService, userRepository);
};

const buildOptionalAuthenticate = () => {
  const userRepository = new UserRepository();
  const sessionRepository = new SessionRepository();
  const tokenService = new TokenService(sessionRepository);
  return createOptionalAuthenticateAccessTokenMiddleware(tokenService, userRepository);
};

/** Batch 14 — Customer self-service Review surface, mounted at `/me` (same top-level prefix as
 * `createCustomerBookingRoute`, see api-router.ts) — cross-business, CUSTOMER-only, matching that
 * route's own authorization convention exactly. */
export const createCustomerReviewRoute = (): Router => {
  const router = Router();
  const authenticate = buildAuthenticate();
  const controller = buildController();

  router.get(
    "/bookings/:bookingId/review",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    validateRequest({ params: bookingIdReviewParamsSchema }),
    asyncHandler(controller.getStateForBooking),
  );

  router.post(
    "/bookings/:bookingId/review",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    validateRequest({ params: bookingIdReviewParamsSchema, body: reviewWriteBodySchema }),
    asyncHandler(controller.create),
  );

  router.patch(
    "/bookings/:bookingId/review",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    validateRequest({ params: bookingIdReviewParamsSchema, body: reviewWriteBodySchema }),
    asyncHandler(controller.update),
  );

  return router;
};

/** Batch 14 / Phase public Explore+Venue — the public Business rating summary + published
 * Reviews list, mounted at `/catalog` alongside createCatalogRoute's own `/businesses/:businessId`
 * surface. These are genuinely PUBLIC reads now: an unregistered visitor on a shared `/venue`
 * link sees the real aggregate rating and published reviews with no account. `optionalAuthenticate`
 * still attaches `request.auth` when a valid token is present (never rejects its absence);
 * `requireActiveUser()` still blocks a SUSPENDED logged-in caller; `requireApprovedBusiness`
 * keeps the canonical public-visibility rule (APPROVED/WARNING only; PENDING/SUSPENDED -> 403).
 * Writing a review is UNCHANGED — that stays on the CUSTOMER-only `/me/bookings/:id/review`
 * surface (createCustomerReviewRoute). A separate route module (not folded into catalog.route.ts)
 * to keep the Review domain self-contained; distinct path suffixes, no collision. */
export const createPublicBusinessReviewRoute = (): Router => {
  const router = Router();
  const optionalAuthenticate = buildOptionalAuthenticate();
  const controller = buildController();
  const businessRepository = new BusinessRepository();

  router.use(optionalAuthenticate, requireActiveUser());

  router.get(
    "/businesses/:businessId/reviews/summary",
    validateRequest({ params: businessIdParamsSchema }),
    requireApprovedBusiness(businessRepository),
    asyncHandler(controller.getBusinessRatingSummary),
  );

  router.get(
    "/businesses/:businessId/reviews",
    validateRequest({ params: businessIdParamsSchema, query: listPublicReviewsQuerySchema }),
    requireApprovedBusiness(businessRepository),
    asyncHandler(controller.listBusinessReviews),
  );

  return router;
};

/** Batch 19 — Business dashboard reads of a Business's OWN reviews (Owner/Supervisor only,
 * mirroring the exact ownership/membership boundary booking.route.ts and client.route.ts already
 * use for their own `/businesses/:businessId/...` management routes — no product rule grants
 * STAFF this access, see ReviewService.requireBusinessManagementAccess). Same underlying data as
 * createPublicBusinessReviewRoute above; that CUSTOMER-only route is untouched — this is an
 * additive, separately-authorized route, not a change to existing behavior. Not gated by
 * requireApprovedBusiness, matching booking.route.ts's own convention that read routes (unlike
 * booking creation) stay available regardless of Business approval status. */
export const createBusinessReviewRoute = (): Router => {
  const router = Router();
  const authenticate = buildAuthenticate();
  const controller = buildController();

  router.use(authenticate, requireActiveUser(), requireRoles(["BUSINESS_OWNER", "SUPERVISOR"]));

  router.get(
    "/:businessId/reviews/summary",
    validateRequest({ params: businessIdParamsSchema }),
    asyncHandler(controller.getBusinessRatingSummaryForDashboard),
  );

  router.get(
    "/:businessId/reviews",
    validateRequest({ params: businessIdParamsSchema, query: listPublicReviewsQuerySchema }),
    asyncHandler(controller.listBusinessReviewsForDashboard),
  );

  return router;
};
