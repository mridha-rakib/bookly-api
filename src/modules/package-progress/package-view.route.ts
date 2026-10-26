import { type ErrorRequestHandler, type Request, Router } from "express";
import { Error as MongooseError, mongo } from "mongoose";
import { z } from "zod";
import { AppError } from "../../common/errors/app-error.js";
import { sendSuccess } from "../../common/http/responses.js";
import { asyncHandler } from "../../common/middleware/async-handler.js";
import { validateRequest } from "../../common/middleware/validate-request.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../auth/auth.middleware.js";
import { TokenService } from "../auth/token.service.js";
import { BusinessRepository } from "../business/business.repository.js";
import { BusinessTravelSettingsRepository } from "../business-travel-settings/business-travel-settings.repository.js";
import { PackageRepository } from "../packages/package.repository.js";
import { PackageService } from "../packages/package.service.js";
import { ServiceRepository } from "../services/service.repository.js";
import { ServiceCategoryRepository } from "../services/service-category.repository.js";
import { SessionRepository } from "../session/session.repository.js";
import { StaffRepository } from "../staff/staff.repository.js";
import { UserRepository } from "../user/user.repository.js";
import { PackageViewService } from "./package-view.service.js";

const id = z.string().regex(/^[a-fA-F0-9]{24}$/);
const businessParams = z.object({ businessId: id }).strict();
const detailParams = z.object({ businessId: id, packageId: id }).strict();
const ownedParams = z.object({ progressId: id }).strict();
const settlementParams = z.object({ businessId: id, bookingId: id }).strict();
const noQuery = z.object({}).strict();
const actor = (request: Request) => {
  if (!request.auth) throw new AppError("Sign in to view packages", 401);
  return request.auth;
};

/** Authenticated read adapter only. No lifecycle kernel, writer or worker is composed here. */
export function createPackageViewRoute(): Router {
  const router = Router();
  const catalogue = new PackageService(
    new PackageRepository(),
    new BusinessRepository(),
    new ServiceRepository(),
    new ServiceCategoryRepository(),
    new StaffRepository(),
    new BusinessTravelSettingsRepository(),
  );
  const views = new PackageViewService();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });
  router.use(
    createAuthenticateAccessTokenMiddleware(
      new TokenService(new SessionRepository()),
      new UserRepository(),
    ),
    requireActiveUser(),
  );
  router.get(
    "/catalog/:businessId",
    requireRoles(["CUSTOMER"]),
    validateRequest({ params: businessParams, query: noQuery }),
    asyncHandler(async (req, res) => {
      const p = req.validated?.params as z.infer<typeof businessParams>;
      sendSuccess(res, 200, "Package catalogue", await catalogue.customerCatalog(p.businessId));
    }),
  );
  router.get(
    "/catalog/:businessId/:packageId",
    requireRoles(["CUSTOMER"]),
    validateRequest({ params: detailParams, query: noQuery }),
    asyncHandler(async (req, res) => {
      const p = req.validated?.params as z.infer<typeof detailParams>;
      sendSuccess(
        res,
        200,
        "Package detail",
        await catalogue.customerCatalog(p.businessId, p.packageId),
      );
    }),
  );
  router.get(
    "/owned",
    requireRoles(["CUSTOMER"]),
    validateRequest({ query: noQuery }),
    asyncHandler(async (req, res) => {
      sendSuccess(res, 200, "Owned first-class packages", await views.owned(actor(req).userId));
    }),
  );
  router.get(
    "/owned/:progressId",
    requireRoles(["CUSTOMER"]),
    validateRequest({ params: ownedParams, query: noQuery }),
    asyncHandler(async (req, res) => {
      const p = req.validated?.params as z.infer<typeof ownedParams>;
      sendSuccess(res, 200, "Owned package", await views.owned(actor(req).userId, p.progressId));
    }),
  );
  router.get(
    "/settlement/:businessId/:bookingId",
    requireRoles(["BUSINESS_OWNER", "SUPERVISOR"]),
    validateRequest({ params: settlementParams, query: noQuery }),
    asyncHandler(async (req, res) => {
      const p = req.validated?.params as z.infer<typeof settlementParams>;
      sendSuccess(
        res,
        200,
        "Package settlement",
        await views.settlement(actor(req).userId, actor(req).role, p.businessId, p.bookingId),
      );
    }),
  );
  router.post(
    "/actions/:action",
    requireRoles(["CUSTOMER", "BUSINESS_OWNER", "SUPERVISOR"]),
    validateRequest({
      params: z
        .object({
          action: z.enum(["purchase", "consent", "redeem", "reschedule", "cancel", "settlement"]),
        })
        .strict(),
      body: z.object({}).strict(),
      query: noQuery,
    }),
    asyncHandler(async () => {
      throw new AppError(
        "First-class Package checkout and lifecycle actions are unavailable",
        503,
        {
          details: [
            {
              code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE",
              message: "Genuine purchase consent is not available. No operation was performed.",
            },
          ],
        },
      );
    }),
  );
  const unavailable: ErrorRequestHandler = (error, _req, _res, next) => {
    if (
      error instanceof mongo.MongoError ||
      error instanceof MongooseError.MongooseServerSelectionError
    )
      return next(
        new AppError("Package information is temporarily unavailable", 503, {
          details: [{ code: "PACKAGE_READ_UNAVAILABLE", message: "Try again later" }],
        }),
      );
    return next(error);
  };
  router.use(unavailable);
  return router;
}
