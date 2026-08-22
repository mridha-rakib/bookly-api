import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../auth/auth.middleware.js";
import { TokenService } from "../auth/token.service.js";
import { SessionRepository } from "../session/session.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { CustomerPaymentProfileRepository } from "./customer-payment-profile.repository.js";
import { PaymentController } from "./payment.controller.js";
import { confirmSavedPaymentMethodBodySchema } from "./payment.schema.js";
import { PaymentService } from "./payment.service.js";
import { StripePaymentGateway } from "./stripe-payment-gateway.js";

/** Customer-only, cross-business (a saved card belongs to the Customer identity, never one
 * Business) — mirrors the `/me/bookings` mount convention already established for the Customer
 * self-service surface. */
export const createPaymentRoute = (): Router => {
  const router = Router();

  const userRepository = new UserRepository();
  const sessionRepository = new SessionRepository();
  const tokenService = new TokenService(sessionRepository);
  const authenticate = createAuthenticateAccessTokenMiddleware(tokenService, userRepository);

  const paymentService = new PaymentService(
    new StripePaymentGateway(),
    new CustomerPaymentProfileRepository(),
    userRepository,
  );
  const controller = new PaymentController(paymentService);

  router.post(
    "/setup-intent",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    asyncHandler(controller.createSetupIntent),
  );

  router.post(
    "/confirm-card",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    validateRequest({ body: confirmSavedPaymentMethodBodySchema }),
    asyncHandler(controller.confirmSavedPaymentMethod),
  );

  router.get(
    "/card-status",
    authenticate,
    requireActiveUser(),
    requireRoles(["CUSTOMER"]),
    asyncHandler(controller.getSavedCardStatus),
  );

  return router;
};
