import { Router } from "express";
import rateLimit from "express-rate-limit";

import { buildErrorResponse } from "../../common/http/responses.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { env } from "../../config/env.js";
import { ContentController } from "./content.controller.js";
import { FaqRepository } from "./faq.repository.js";
import { publicListFaqsQuerySchema } from "./faq.schema.js";
import { FaqService } from "./faq.service.js";

/**
 * Public Content reads (Phase 1: FAQ only). Genuinely anonymous — no `authenticate` in the
 * chain — matching the real precedent `discovery.route.ts` / `contact.route.ts` set for public
 * GETs in this codebase. Rate limited instead of auth-gated, same reasoning: there is no session
 * to lean on for abuse protection. All Super Admin FAQ *mutations* live on `/super-admin/content`
 * behind the SUPER_ADMIN router-wide gate — never here.
 */
export const createPublicContentRoute = (): Router => {
  const router = Router();
  const controller = new ContentController(new FaqService(new FaqRepository()));

  const contentLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: env.RATE_LIMIT_MAX,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: buildErrorResponse("Too many requests"),
  });

  router.get(
    "/faqs",
    contentLimiter,
    validateRequest({ query: publicListFaqsQuerySchema }),
    asyncHandler(controller.listPublicFaqs),
  );

  return router;
};
