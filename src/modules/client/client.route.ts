import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../auth/auth.middleware.js";
import { TokenService } from "../auth/token.service.js";
import { BusinessRepository } from "../business/business.repository.js";
import { SessionRepository } from "../session/session.repository.js";
import { StaffRepository } from "../staff/staff.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { ClientController } from "./client.controller.js";
import { ClientRepository } from "./client.repository.js";
import {
  clientBusinessParamsSchema,
  clientIdParamsSchema,
  createClientBodySchema,
  listClientsQuerySchema,
  updateClientBodySchema,
} from "./client.schema.js";
import { ClientService } from "./client.service.js";
import { ClientIdentityService } from "./client-identity.service.js";

/**
 * Mounted at /businesses in api-router.ts, registered BEFORE createBusinessRoute() and
 * deliberately NOT nested inside it: business.route.ts applies a router-wide
 * `requireRoles(["BUSINESS_OWNER"])` gate that would reject SUPERVISOR outright. This router
 * instead applies auth per-route (not as a blanket `router.use`), so it never intercepts
 * requests for other /businesses/* paths it doesn't own — those fall through untouched to
 * business.route.ts exactly as before this module existed. Client management is the first
 * BUSINESS_OWNER + SUPERVISOR-shared surface in the codebase; exact-business scoping for each
 * role is re-resolved per request in ClientService.requireBusinessAccess (no BusinessAccess
 * fallback, matching every other management-surface convention).
 */
export const createClientRoute = (): Router => {
  const router = Router();

  const userRepository = new UserRepository();
  const businessRepository = new BusinessRepository();
  const staffRepository = new StaffRepository();
  const clientRepository = new ClientRepository();
  const clientIdentityService = new ClientIdentityService(userRepository, clientRepository);
  const service = new ClientService(
    clientRepository,
    businessRepository,
    staffRepository,
    userRepository,
    clientIdentityService,
  );
  const controller = new ClientController(service);

  const sessionRepository = new SessionRepository();
  const tokenService = new TokenService(sessionRepository);
  const authenticate = createAuthenticateAccessTokenMiddleware(tokenService, userRepository);
  const requireClientAccess = [
    authenticate,
    requireActiveUser(),
    requireRoles(["BUSINESS_OWNER", "SUPERVISOR"]),
  ] as const;

  router.get(
    "/:businessId/clients",
    ...requireClientAccess,
    validateRequest({ params: clientBusinessParamsSchema, query: listClientsQuerySchema }),
    asyncHandler(controller.list),
  );
  router.post(
    "/:businessId/clients",
    ...requireClientAccess,
    validateRequest({ params: clientBusinessParamsSchema, body: createClientBodySchema }),
    asyncHandler(controller.create),
  );
  router.get(
    "/:businessId/clients/:clientId",
    ...requireClientAccess,
    validateRequest({ params: clientIdParamsSchema }),
    asyncHandler(controller.getById),
  );
  router.patch(
    "/:businessId/clients/:clientId",
    ...requireClientAccess,
    validateRequest({ params: clientIdParamsSchema, body: updateClientBodySchema }),
    asyncHandler(controller.update),
  );
  router.delete(
    "/:businessId/clients/:clientId",
    ...requireClientAccess,
    validateRequest({ params: clientIdParamsSchema }),
    asyncHandler(controller.archive),
  );
  router.post(
    "/:businessId/clients/:clientId/restore",
    ...requireClientAccess,
    validateRequest({ params: clientIdParamsSchema }),
    asyncHandler(controller.restore),
  );

  return router;
};
