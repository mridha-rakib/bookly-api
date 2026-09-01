import { Router } from "express";
import rateLimit from "express-rate-limit";

import { buildErrorResponse } from "../../common/http/responses.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { env } from "../../config/env.js";
import { UserRepository } from "../user/user.repository.js";
import { MarketingUnsubscribeController } from "./marketing-unsubscribe.controller.js";
import {
  marketingUnsubscribeBodySchema,
  marketingUnsubscribeQuerySchema,
} from "./marketing-unsubscribe.schema.js";
import { MarketingUnsubscribeService } from "./marketing-unsubscribe.service.js";

/**
 * Marketing Email Stage M2 — public unsubscribe. Genuinely anonymous (no `authenticate` in the
 * chain), its own top-level `/marketing` prefix — same anonymous-public-POST precedent as
 * `createContactRoute()` / `createDiscoveryRoute()`, guarded by a per-IP rate limiter instead of
 * an auth gate. POST-only: a signed one-way token that can only ever set `marketingEmail=false`,
 * so there is deliberately no GET (avoids drive-by unsubscribes from link scanners / prefetch)
 * and no endpoint anywhere that could set it back to `true`.
 */
export const createMarketingRoute = (): Router => {
  const router = Router();
  const controller = new MarketingUnsubscribeController(
    new MarketingUnsubscribeService(new UserRepository()),
  );

  const unsubscribeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: env.MARKETING_RATE_LIMIT_MAX,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: buildErrorResponse("Too many requests"),
  });

  router.post(
    "/unsubscribe",
    unsubscribeLimiter,
    validateRequest({
      query: marketingUnsubscribeQuerySchema,
      body: marketingUnsubscribeBodySchema,
    }),
    asyncHandler(controller.unsubscribe),
  );

  return router;
};
