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
import { BusinessMediaRepository } from "../business-media/business-media.repository.js";
import { DiscoveryRepository } from "../discovery/discovery.repository.js";
import { DiscoveryService } from "../discovery/discovery.service.js";
import { SessionRepository } from "../session/session.repository.js";
import { createDeferredStorageServiceFromEnv } from "../storage/storage.service.js";
import { UserRepository } from "../user/user.repository.js";
import { FavoriteController } from "./favorite.controller.js";
import { FavoriteRepository } from "./favorite.repository.js";
import { favoriteBusinessIdParamsSchema, listFavoritesQuerySchema } from "./favorite.schema.js";
import { FavoriteService } from "./favorite.service.js";

/** Batch 16 — Favorites, mounted at `/me` (same top-level prefix/convention as My Bookings/My
 * Reviews/My Support Tickets) — CUSTOMER-only, own-resource-scoped. */
export const createFavoriteRoute = (): Router => {
  const router = Router();
  const userRepository = new UserRepository();
  const sessionRepository = new SessionRepository();
  const tokenService = new TokenService(sessionRepository);
  const authenticate = createAuthenticateAccessTokenMiddleware(tokenService, userRepository);

  const controller = new FavoriteController(
    new FavoriteService(
      new FavoriteRepository(),
      new BusinessRepository(),
      new DiscoveryService(
        new DiscoveryRepository(),
        new BusinessMediaRepository(),
        createDeferredStorageServiceFromEnv(),
      ),
    ),
  );

  router.use(authenticate, requireActiveUser(), requireRoles(["CUSTOMER"]));

  router.get(
    "/favorites",
    validateRequest({ query: listFavoritesQuerySchema }),
    asyncHandler(controller.list),
  );
  router.get("/favorites/ids", asyncHandler(controller.listIds));
  router.post(
    "/favorites/:businessId",
    validateRequest({ params: favoriteBusinessIdParamsSchema }),
    asyncHandler(controller.add),
  );
  router.delete(
    "/favorites/:businessId",
    validateRequest({ params: favoriteBusinessIdParamsSchema }),
    asyncHandler(controller.remove),
  );

  return router;
};
