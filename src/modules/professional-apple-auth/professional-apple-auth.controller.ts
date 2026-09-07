import type { Request, Response } from "express";

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { setRefreshCookie } from "../auth/auth.cookies.js";
import { isProfessionalAppleAuthConfigured } from "./professional-apple-auth.client.js";
import type {
  ProfessionalAppleCallbackBody,
  ProfessionalAppleStartQuery,
} from "./professional-apple-auth.schema.js";
import type {
  ProfessionalAppleAuthService,
  ProfessionalAppleCallbackResult,
} from "./professional-apple-auth.service.js";

type CallbackStatus = "success" | "onboarding" | "account_exists" | "error";

/**
 * HTTP boundary only. NO nonce cookie. Owns the refresh cookie and the always-redirect contract.
 * Mirrors ProfessionalFacebookAuthController.
 */
export class ProfessionalAppleAuthController {
  public constructor(private readonly service: ProfessionalAppleAuthService) {}

  public start = async (request: Request, response: Response): Promise<void> => {
    if (!isProfessionalAppleAuthConfigured()) {
      response.redirect(this.frontendRedirect("error"));
      return;
    }

    const query = request.validated?.query as ProfessionalAppleStartQuery;
    const { url } = await this.service.buildAuthorization(query.visitType);
    response.redirect(url);
  };

  public callback = async (request: Request, response: Response): Promise<void> => {
    const body = request.validated?.body as ProfessionalAppleCallbackBody;

    if (body.error || !body.code || !body.state) {
      response.redirect(this.frontendRedirect("error"));
      return;
    }

    let result: ProfessionalAppleCallbackResult;
    try {
      result = await this.service.completeCallback(
        { code: body.code, idToken: body.id_token, state: body.state, appleUser: body.user },
        this.requestContext(request),
      );
    } catch (error) {
      logger.warn({ err: error }, "Business Owner Apple auth callback failed");
      response.redirect(this.frontendRedirect("error"));
      return;
    }

    if (result.type === "SESSION") {
      setRefreshCookie(response, result.auth.refreshToken);
      response.redirect(this.frontendRedirect("success"));
      return;
    }

    if (result.type === "REGISTRATION") {
      const visitTypeAlias = result.visitType === "AT_BUSINESS_LOCATION" ? "location" : "travel";
      response.redirect(
        this.frontendRedirect(
          "onboarding",
          `sessionId=${encodeURIComponent(result.sessionId)}&visitType=${visitTypeAlias}`,
        ),
      );
      return;
    }

    if (result.type === "ACCOUNT_EXISTS") {
      response.redirect(this.frontendRedirect("account_exists"));
      return;
    }

    response.redirect(this.frontendRedirect("error"));
  };

  private frontendRedirect(status: CallbackStatus, extra?: string): string {
    const base = `${env.FRONTEND_BASE_URL}/auth/apple/callback?flow=professional&status=${status}`;
    return extra ? `${base}&${extra}` : base;
  }

  private requestContext(request: Request): { userAgent?: string; ipAddress?: string } {
    return {
      ...(request.headers["user-agent"] ? { userAgent: request.headers["user-agent"] } : {}),
      ...(request.ip ? { ipAddress: request.ip } : {}),
    };
  }
}
