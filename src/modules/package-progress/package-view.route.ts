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
import {
  PackageBatchActivationUnavailableError,
  verifyPackageBatchActivation,
} from "../booking/package-batch-authority.js";
import { PackageLifecycleHttpController } from "../booking/package-lifecycle-http.controller.js";
import { buildPackageLifecycleHttpServices } from "../booking/package-lifecycle-http.factory.js";
import {
  buildPackagePurchaseService,
  PackagePurchaseHttpController,
  purchaseHttpBodySchema,
} from "../booking/package-purchase-http.js";
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
const ownedQuery = z.object({ before: id.optional() }).strict();
const actor = (request: Request) => {
  if (!request.auth) throw new AppError("Sign in to view packages", 401);
  return request.auth;
};
const lifecycleAvailable = async () => {
  try {
    await verifyPackageBatchActivation();
    return true;
  } catch (error) {
    if (error instanceof PackageBatchActivationUnavailableError) return false;
    throw error;
  }
};

/** Existing read surface plus activation-gated lifecycle composition. No worker registration. */
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
  let lifecycle: PackageLifecycleHttpController | undefined;
  let purchase: PackagePurchaseHttpController | undefined;
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
    validateRequest({ query: ownedQuery }),
    asyncHandler(async (req, res) => {
      const query = req.validated?.query as z.infer<typeof ownedQuery>;
      const result = await views.owned(actor(req).userId, undefined, query.before),
        enabled = await lifecycleAvailable();
      sendSuccess(res, 200, "Owned first-class packages", {
        ...result,
        packages: result.packages.map((p) => ({
          ...p,
          actionsAvailable: enabled && p.purchaseCompletion === "VERIFIED",
        })),
      });
    }),
  );
  router.get(
    "/owned/:progressId",
    requireRoles(["CUSTOMER"]),
    validateRequest({ params: ownedParams, query: noQuery }),
    asyncHandler(async (req, res) => {
      const p = req.validated?.params as z.infer<typeof ownedParams>;
      const result = await views.owned(actor(req).userId, p.progressId),
        enabled = await lifecycleAvailable();
      sendSuccess(res, 200, "Owned package", {
        ...result,
        packages: result.packages.map((entry) => ({
          ...entry,
          actionsAvailable: enabled && entry.purchaseCompletion === "VERIFIED",
        })),
      });
    }),
  );
  router.get(
    "/settlement/:businessId/:bookingId",
    requireRoles(["BUSINESS_OWNER", "SUPERVISOR"]),
    validateRequest({ params: settlementParams, query: noQuery }),
    asyncHandler(async (req, res) => {
      const p = req.validated?.params as z.infer<typeof settlementParams>;
      const result = await views.settlement(
        actor(req).userId,
        actor(req).role,
        p.businessId,
        p.bookingId,
      );
      sendSuccess(res, 200, "Package settlement", {
        ...result,
        actionsAvailable: (await lifecycleAvailable()) && result.purchaseCompletion === "VERIFIED",
      });
    }),
  );
  router.post(
    "/actions/:action",
    requireRoles(["CUSTOMER", "BUSINESS_OWNER", "SUPERVISOR"]),
    asyncHandler(async (req, res) => {
      const action = String(req.params["action"]);
      if (["purchase", "purchase-status"].includes(action)) {
        // Preserve closed-gate empty-body probes, but reject posted identity/authority.
        purchaseHttpBodySchema.partial().parse(req.body);
        noQuery.parse(req.query);
      }
      if (action === "consent") {
        z.object({}).strict().parse(req.body);
        noQuery.parse(req.query);
      }
      // No flag, DTO or alternate registration may open this boundary. In isolated tests
      // the authority module is mocked; production retains its unconditional denial.
      try {
        await verifyPackageBatchActivation();
      } catch (error) {
        if (error instanceof PackageBatchActivationUnavailableError)
          throw new AppError(error.message, 503, {
            details: [{ code: error.code, message: "No operation was performed" }],
          });
        throw error;
      }
      if (action === "consent")
        throw new AppError("Package consent activation is unavailable", 503);
      if (["purchase", "purchase-status"].includes(action)) {
        purchase ??= new PackagePurchaseHttpController(buildPackagePurchaseService());
        await purchase.execute(req, res);
        return;
      }
      lifecycle ??= new PackageLifecycleHttpController(buildPackageLifecycleHttpServices());
      await lifecycle.execute(req, res);
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
