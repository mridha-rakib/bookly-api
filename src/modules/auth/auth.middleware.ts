import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { BusinessRepository } from "../business/business.repository.js";
import type { UserRepository } from "../user/user.repository.js";
import type { UserRole } from "../user/user.types.js";
import { AuthError } from "./auth.errors.js";
import type { TokenService } from "./token.service.js";

export const createAuthenticateAccessTokenMiddleware =
  (tokenService: TokenService, userRepository: UserRepository): RequestHandler =>
  async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    try {
      const authorization = request.headers.authorization;

      if (!authorization?.startsWith("Bearer ")) {
        throw new AuthError("SESSION_EXPIRED", 401);
      }

      const claims = await tokenService.verifyAccessToken(authorization.slice("Bearer ".length));
      const user = await userRepository.findById(claims.sub);

      if (!user) {
        throw new AuthError("SESSION_EXPIRED", 401);
      }

      request.auth = {
        userId: String(user._id),
        role: user.role,
        status: user.status,
      };
      next();
    } catch (error) {
      next(error instanceof AuthError ? error : new AuthError("SESSION_EXPIRED", 401));
    }
  };

export const requireRoles =
  (roles: UserRole[]): RequestHandler =>
  (request: Request, _response: Response, next: NextFunction): void => {
    if (!request.auth || !roles.includes(request.auth.role)) {
      next(new AuthError("PORTAL_MISMATCH", 403));
      return;
    }

    next();
  };

export const requireActiveUser = (): RequestHandler => (request, _response, next) => {
  if (request.auth?.status === "SUSPENDED") {
    next(new AuthError("USER_SUSPENDED", 403));
    return;
  }

  next();
};

/**
 * DELIBERATELY UNWIRED — do not attach this to a route without re-reading this comment first.
 *
 * Item 12 audit (this batch): confirmed by exhaustive search that no code path anywhere in
 * this codebase ever transitions Business.status away from "PENDING" — there is no approval
 * endpoint, no Super Admin business-management route, no auto-approval on registration.
 * Business.model.ts defaults every new Business to `status: "PENDING"`. Wiring this middleware
 * onto any currently-live management route today would therefore lock out every single
 * Business Owner permanently and immediately (their Business can never become "APPROVED"),
 * which is a product outage, not a security fix. That is why this batch does NOT attach it
 * anywhere, per this batch's own instruction not to guess at product-ambiguous behavior.
 *
 * A second, independent reason not to attach it broadly even once an approval workflow
 * exists: `findByOwnerUserId` below only resolves a Business for a BUSINESS_OWNER actor — a
 * SUPERVISOR/STAFF actor's userId is never a Business's ownerUserId, so this middleware would
 * incorrectly reject every Supervisor/Staff request as "pending approval" on any route that
 * also permits those roles (business.route.ts's Staff/Client/Booking sub-routers, for
 * example). It is only safe to attach to a route segment that is Owner-only for its entire
 * length.
 *
 * Route-access matrix (what SHOULD gate on approved-Business status, once an approval
 * workflow exists to actually set it — not implemented in this batch):
 *   - Business Profile (business.route.ts core CRUD)         -> gate (Owner-only end to end)
 *   - Services / Add-ons / Staff / Staff Avatar / Clients     -> gate (Owner-only end to end)
 *   - Business Hours / Cancellation Policy / Travel Settings  -> gate (Owner-only end to end)
 *   - Business linking (/links/*)                             -> DO NOT gate — an Owner must
 *     be able to link a secondary/linked Business regardless of their primary Business's
 *     approval state; this is an identity operation, not a management operation on that
 *     specific Business.
 *   - GET /my-profile, GET /:businessId (read-only detail)    -> DO NOT gate — a PENDING
 *     Owner still needs to see their own Business while awaiting approval (e.g. to finish
 *     onboarding); blocking reads here would make the PENDING state unrecoverable from the
 *     product's own UI.
 *   - Auth routes (login, refresh, /me, registration)          -> DO NOT gate — approval status
 *     is a Business-level concept, not an account-access concept.
 *
 * Prerequisite before this can be wired anywhere: a real "approve/suspend a Business" admin
 * workflow must exist first (a Super Admin route today has zero business-management
 * endpoints — confirmed separately in this batch's security review). Building that workflow
 * is out of this batch's scope; this comment exists so a future batch does not have to
 * re-derive the above from scratch.
 */
export const requireApprovedBusiness =
  (businessRepository: BusinessRepository): RequestHandler =>
  async (request, _response, next): Promise<void> => {
    try {
      if (!request.auth?.userId) {
        throw new AuthError("SESSION_EXPIRED", 401);
      }

      const business = await businessRepository.findByOwnerUserId(request.auth.userId);

      if (!business || business.status === "PENDING") {
        throw new AuthError("BUSINESS_PENDING_APPROVAL", 403);
      }

      if (business.status === "SUSPENDED") {
        throw new AuthError("BUSINESS_SUSPENDED", 403);
      }

      next();
    } catch (error) {
      next(error);
    }
  };
