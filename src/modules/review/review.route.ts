import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireApprovedBusiness,
  requireRoles,
} from "../auth/auth.middleware.js";
import { TokenService } from "../auth/token.service.js";
import { BookingRepository } from "../booking/booking.repository.js";
import { BusinessRepository } from "../business/business.repository.js";
import { SessionRepository } from "../session/session.repository.js";
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
  new ReviewController(new ReviewService(new ReviewRepository(), new BookingRepository()));

const buildAuthenticate = () => {
  const userRepository = new UserRepository();
  const sessionRepository = new SessionRepository();
  const tokenService = new TokenService(sessionRepository);
  return createAuthenticateAccessTokenMiddleware(tokenService, userRepository);
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

/** Batch 14 — the public (CUSTOMER-authenticated, matching catalog.route.ts's own "public
 * business page" convention — there is no true anonymous-public route architecture anywhere in
 * this codebase) Business rating summary + Reviews list, mounted at `/catalog` alongside
 * createCatalogRoute's own `/businesses/:businessId` surface. A separate route module (not added
 * directly to catalog.route.ts) to keep the Review domain self-contained; same prefix, same
 * authorization gate, no collision (distinct path suffixes). */
export const createPublicBusinessReviewRoute = (): Router => {
  const router = Router();
  const authenticate = buildAuthenticate();
  const controller = buildController();
  const businessRepository = new BusinessRepository();

  router.use(
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    requireApprovedBusiness(businessRepository),
  );

  router.get(
    "/businesses/:businessId/reviews/summary",
    validateRequest({ params: businessIdParamsSchema }),
    asyncHandler(controller.getBusinessRatingSummary),
  );

  router.get(
    "/businesses/:businessId/reviews",
    validateRequest({ params: businessIdParamsSchema, query: listPublicReviewsQuerySchema }),
    asyncHandler(controller.listBusinessReviews),
  );

  return router;
};
