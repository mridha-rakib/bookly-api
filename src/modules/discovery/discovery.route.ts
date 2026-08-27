import { Router } from "express";
import rateLimit from "express-rate-limit";

import { buildErrorResponse } from "../../common/http/responses.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import { env } from "../../config/env.js";
import { createOptionalAuthenticateAccessTokenMiddleware } from "../auth/auth.middleware.js";
import { TokenService } from "../auth/token.service.js";
import { BusinessMediaRepository } from "../business-media/business-media.repository.js";
import { SessionRepository } from "../session/session.repository.js";
import { createDeferredStorageServiceFromEnv } from "../storage/storage.service.js";
import { UserRepository } from "../user/user.repository.js";
import { DiscoveryController } from "./discovery.controller.js";
import { DiscoveryRepository } from "./discovery.repository.js";
import { homeSectionsQuerySchema, listDiscoveryBusinessesQuerySchema } from "./discovery.schema.js";
import { DiscoveryService } from "./discovery.service.js";

/** Batch 16 — Explore's real backend. Genuinely public — no `authenticate` anywhere in this
 * chain — matching the real precedent `contact.route.ts` established (a genuinely anonymous GET/
 * POST is possible in this codebase; it is not limited to `auth.route.ts`'s entry points). Rate
 * limited instead of auth-gated, same reasoning as the Contact route: there's no session to lean
 * on for abuse protection. */
export const createDiscoveryRoute = (): Router => {
  const router = Router();
  const controller = new DiscoveryController(
    new DiscoveryService(
      new DiscoveryRepository(),
      new BusinessMediaRepository(),
      createDeferredStorageServiceFromEnv(),
    ),
  );

  const discoveryLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: env.RATE_LIMIT_MAX,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: buildErrorResponse("Too many requests"),
  });

  // Optional auth — the route stays fully usable logged-out; a valid CUSTOMER token only
  // personalizes the "Recommended" row (see discovery.controller.ts homeSections).
  const optionalAuthenticate = createOptionalAuthenticateAccessTokenMiddleware(
    new TokenService(new SessionRepository()),
    new UserRepository(),
  );

  router.get(
    "/businesses",
    discoveryLimiter,
    validateRequest({ query: listDiscoveryBusinessesQuerySchema }),
    asyncHandler(controller.search),
  );
  router.get(
    "/home-sections",
    discoveryLimiter,
    optionalAuthenticate,
    validateRequest({ query: homeSectionsQuerySchema }),
    asyncHandler(controller.homeSections),
  );
  router.get("/categories", discoveryLimiter, asyncHandler(controller.listCategories));
  router.get("/founding-partners", discoveryLimiter, asyncHandler(controller.listFoundingPartners));

  return router;
};
