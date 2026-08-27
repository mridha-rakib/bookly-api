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

/**
 * Batch 17 — "authenticate if a Bearer token is present, otherwise proceed anonymously".
 * Used only by genuinely-public read endpoints that OPTIONALLY personalize when a logged-in
 * Customer calls them (home discovery sections). Any failure to resolve the token — missing,
 * malformed, expired, revoked — is a silent fall-through to the anonymous path, never a 401:
 * the endpoint is fully usable logged-out, so a stale token must degrade to "not personalized",
 * not to an error. It never throws and never calls `next(error)`.
 */
export const createOptionalAuthenticateAccessTokenMiddleware =
  (tokenService: TokenService, userRepository: UserRepository): RequestHandler =>
  async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    try {
      const authorization = request.headers.authorization;
      if (authorization?.startsWith("Bearer ")) {
        const claims = await tokenService.verifyAccessToken(authorization.slice("Bearer ".length));
        const user = await userRepository.findById(claims.sub);
        if (user) {
          request.auth = {
            userId: String(user._id),
            role: user.role,
            status: user.status,
          };
        }
      }
    } catch {
      // Intentionally swallowed — see doc comment. The request continues anonymously.
    }
    next();
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
 * Batch 11 — now wired (was previously built but deliberately dormant; see git history/prior
 * comment for why). Resolves the Business from the request's OWN `:businessId` URL param —
 * never from the actor's identity — so it works identically for BUSINESS_OWNER, SUPERVISOR, or
 * CUSTOMER requests on any mixed-role route, unlike an ownerUserId-based lookup (which breaks
 * for Supervisor/Customer actors, who are never a Business's own `ownerUserId`). This
 * middleware ONLY checks Business status; it never re-implements ownership/role authorization —
 * that stays exactly where each route already enforces it (`requireBookingManagementAccess`,
 * `ClientService.requireBusinessAccess`, etc.), keeping the two concerns separate. If the route
 * has no `:businessId` param (e.g. `/my-profile`), or the param fails to resolve a real
 * Business, this middleware does nothing and lets the downstream handler's own existing
 * not-found handling apply — it is not a substitute for business-existence checks.
 *
 * Confirmed product policy this enforces (Batch 11 AskUserQuestion, all "Recommended"):
 *  - PENDING or SUSPENDED blocks: new customer self-bookings (catalog + finalize), new manual
 *    bookings, and catalog/staff/client/business-settings management writes.
 *  - WARNING blocks nothing — informational only, same capability as APPROVED.
 *  - Existing-booking lifecycle actions (complete/cancel/no-show/waive-fee/reschedule),
 *    Business linking, and Finance/payout access are NEVER gated by this middleware anywhere —
 *    wired individually per-route, never router-wide, precisely to exclude these.
 */
export const requireApprovedBusiness =
  (businessRepository: BusinessRepository): RequestHandler =>
  async (request, _response, next): Promise<void> => {
    try {
      const businessId = request.params["businessId"];
      if (!businessId || typeof businessId !== "string") {
        next();
        return;
      }

      const business = await businessRepository.findById(businessId);
      if (!business) {
        next();
        return;
      }

      if (business.status === "PENDING") {
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
