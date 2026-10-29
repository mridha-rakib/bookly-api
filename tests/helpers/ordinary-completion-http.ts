import express from "express";
import request from "supertest";
import { asyncHandler } from "../../src/common/middleware/async-handler.js";
import { createErrorHandler } from "../../src/common/middleware/error-handler.js";
import { validateRequest } from "../../src/common/middleware/validate-request.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../../src/modules/auth/auth.middleware.js";
import { TokenService } from "../../src/modules/auth/token.service.js";
import { BookingController } from "../../src/modules/booking/booking.controller.js";
import {
  bookingIdParamsSchema,
  completeBookingBodySchema,
} from "../../src/modules/booking/booking.schema.js";
import type { BookingService } from "../../src/modules/booking/booking.service.js";
import type { BookingLifecycleService } from "../../src/modules/booking/booking-lifecycle.service.js";
import { SessionRepository } from "../../src/modules/session/session.repository.js";
import { UserRepository } from "../../src/modules/user/user.repository.js";
import type { UserRole } from "../../src/modules/user/user.types.js";
import { issueTestAccessToken } from "./access-token.js";

/** Test composition of the existing route middleware/controller with a suite's real domain.
 * Uses persisted sid-bound sessions. Never registered or imported by application source. */
export async function ordinaryCompletionHttp(
  management: BookingService,
  lifecycle: BookingLifecycleService,
  actorId: string,
  actorRole: UserRole = "BUSINESS_OWNER",
) {
  const tokens = new TokenService(new SessionRepository());
  const token = await issueTestAccessToken(tokens, { userId: actorId, role: actorRole });
  const controller = new BookingController(management, {} as never, lifecycle);
  const app = express();
  app.use(express.json());
  app.post(
    "/businesses/:businessId/bookings/:bookingId/complete",
    createAuthenticateAccessTokenMiddleware(tokens, new UserRepository()),
    requireActiveUser(),
    requireRoles(["BUSINESS_OWNER", "SUPERVISOR"]),
    validateRequest({ params: bookingIdParamsSchema, body: completeBookingBodySchema }),
    asyncHandler(controller.completeBooking),
  );
  app.use(createErrorHandler({ isProduction: true }));
  return (businessId: string, bookingId: string, body: object = {}) =>
    request(app)
      .post(`/businesses/${businessId}/bookings/${bookingId}/complete`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);
}
