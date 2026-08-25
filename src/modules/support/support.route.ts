import { Router } from "express";

import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../auth/auth.middleware.js";
import { TokenService } from "../auth/token.service.js";
import { BookingRepository } from "../booking/booking.repository.js";
import { BusinessRepository } from "../business/business.repository.js";
import { SessionRepository } from "../session/session.repository.js";
import { StaffRepository } from "../staff/staff.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { SupportController } from "./support.controller.js";
import {
  createSupportTicketBodySchema,
  listSupportMessagesQuerySchema,
  listSupportTicketsQuerySchema,
  supportMessageBodySchema,
  supportTicketIdParamsSchema,
} from "./support.schema.js";
import { SupportService } from "./support.service.js";
import { supportTicketRequesterRoles } from "./support.types.js";
import { createSupportEmailProvider } from "./support-email.provider.js";
import { SupportMessageRepository } from "./support-message.repository.js";
import { SupportTicketRepository } from "./support-ticket.repository.js";

const buildController = (): SupportController =>
  new SupportController(
    new SupportService(
      new SupportTicketRepository(),
      new SupportMessageRepository(),
      new BookingRepository(),
      new BusinessRepository(),
      new StaffRepository(),
      new UserRepository(),
      createSupportEmailProvider(),
    ),
  );

const buildAuthenticate = () => {
  const userRepository = new UserRepository();
  const sessionRepository = new SessionRepository();
  const tokenService = new TokenService(sessionRepository);
  return createAuthenticateAccessTokenMiddleware(tokenService, userRepository);
};

/** Batch 15B — Customer/Business Owner/Supervisor/Staff self-service "My Tickets" surface, mounted
 * at `/me` (same top-level prefix as `createCustomerBookingRoute`/`createCustomerReviewRoute`, see
 * api-router.ts) — cross-Business, own-ticket-only (Q2: uniformly requesterUserId-scoped for all
 * four roles, never a shared per-Business inbox). */
export const createSupportRoute = (): Router => {
  const router = Router();
  const authenticate = buildAuthenticate();
  const controller = buildController();

  router.use(authenticate, requireActiveUser(), requireRoles([...supportTicketRequesterRoles]));

  router.post(
    "/support/tickets",
    validateRequest({ body: createSupportTicketBodySchema }),
    asyncHandler(controller.create),
  );
  router.get(
    "/support/tickets",
    validateRequest({ query: listSupportTicketsQuerySchema }),
    asyncHandler(controller.list),
  );
  router.get(
    "/support/tickets/:ticketId",
    validateRequest({ params: supportTicketIdParamsSchema }),
    asyncHandler(controller.getById),
  );
  router.get(
    "/support/tickets/:ticketId/messages",
    validateRequest({ params: supportTicketIdParamsSchema, query: listSupportMessagesQuerySchema }),
    asyncHandler(controller.listMessages),
  );
  router.post(
    "/support/tickets/:ticketId/messages",
    validateRequest({ params: supportTicketIdParamsSchema, body: supportMessageBodySchema }),
    asyncHandler(controller.reply),
  );
  router.post(
    "/support/tickets/:ticketId/reopen",
    validateRequest({ params: supportTicketIdParamsSchema }),
    asyncHandler(controller.reopen),
  );

  return router;
};
