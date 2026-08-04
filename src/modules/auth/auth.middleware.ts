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
      next(error);
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
