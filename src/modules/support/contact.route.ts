import { Router } from "express";
import rateLimit from "express-rate-limit";

import { buildErrorResponse } from "../../common/http/responses.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { env } from "../../config/env.js";
import { ContactController } from "./contact.controller.js";
import { submitContactBodySchema } from "./contact.schema.js";
import { createSupportEmailProvider } from "./support-email.provider.js";

/** Batch 15B — the public Contact form's real backend (Q1: kept entirely separate from
 * SupportTicket — no persistence, no authenticated ticket history, message-only). No `authenticate`
 * middleware at all — mirrors `auth.route.ts`'s own real precedent for a genuinely public POST
 * endpoint (registration/login), guarded instead by rate limiting since there is no auth gate to
 * lean on. */
export const createContactRoute = (): Router => {
  const router = Router();
  const controller = new ContactController(createSupportEmailProvider());

  const contactLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: env.CONTACT_RATE_LIMIT_MAX,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: buildErrorResponse("Too many contact requests"),
  });

  router.post(
    "/",
    contactLimiter,
    validateRequest({ body: submitContactBodySchema }),
    asyncHandler(controller.submit),
  );

  return router;
};
