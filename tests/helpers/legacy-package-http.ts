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
  bookingBusinessParamsSchema,
  legacyPackageStatusQuerySchema,
} from "../../src/modules/booking/booking.schema.js";
import type { BookingCreationService } from "../../src/modules/booking/booking-creation.service.js";
import { SessionRepository } from "../../src/modules/session/session.repository.js";
import { UserRepository } from "../../src/modules/user/user.repository.js";
import type { UserRole } from "../../src/modules/user/user.types.js";
import { issueTestAccessToken } from "./access-token.js";

/** Same production status middleware/controller, real persisted test sessions; no provider. */
export async function legacyPackageHttp(
  service: BookingCreationService,
  actorId: string,
  role: UserRole = "CUSTOMER",
) {
  const tokens = new TokenService(new SessionRepository());
  const token = await issueTestAccessToken(tokens, { userId: actorId, role });
  const controller = new BookingController({} as never, service, {} as never);
  const app = express();
  app.get(
    "/businesses/:businessId/bookings/packages/operations/status",
    createAuthenticateAccessTokenMiddleware(tokens, new UserRepository()),
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    validateRequest({ params: bookingBusinessParamsSchema, query: legacyPackageStatusQuerySchema }),
    asyncHandler(controller.readLegacyPackageOperation),
  );
  app.use(createErrorHandler({ isProduction: true }));
  return (businessId: string, query: object, authenticated = true) => {
    const call = request(app)
      .get(`/businesses/${businessId}/bookings/packages/operations/status`)
      .query(query);
    return authenticated ? call.set("Authorization", `Bearer ${token}`) : call;
  };
}
