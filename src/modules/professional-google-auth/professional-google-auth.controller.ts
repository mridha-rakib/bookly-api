import type { Request, Response } from "express";

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { setRefreshCookie } from "../auth/auth.cookies.js";
import { isProfessionalGoogleAuthConfigured } from "./professional-google-auth.client.js";
import {
  clearOAuthNonceCookie,
  readOAuthNonceCookie,
  setOAuthNonceCookie,
} from "./professional-google-auth.nonce.js";
import type {
  ProfessionalGoogleCallbackQuery,
  ProfessionalGoogleStartQuery,
} from "./professional-google-auth.schema.js";
import type {
  ProfessionalGoogleAuthService,
  ProfessionalGoogleCallbackResult,
} from "./professional-google-auth.service.js";

/** Coarse outcomes the frontend `/auth/google/callback` page branches on (with `flow=professional`).
 * Nothing else — no tokens, emails, ids, or failure reasons — goes in the redirect URL, except a
 * `sessionId` on `onboarding` (an ObjectId gated by TTL + step checks, not a credential). */
type CallbackStatus = "success" | "onboarding" | "account_exists" | "error";

/**
 * HTTP boundary only. Owns the professional nonce cookie, the refresh cookie (via the shared
 * setRefreshCookie), and the always-redirect-to-frontend contract — it never renders an error
 * body and never leaks why a sign-in failed. Mirrors CustomerGoogleAuthController.
 */
export class ProfessionalGoogleAuthController {
  public constructor(private readonly service: ProfessionalGoogleAuthService) {}

  public start = async (request: Request, response: Response): Promise<void> => {
    if (!isProfessionalGoogleAuthConfigured()) {
      response.redirect(this.frontendRedirect("error"));
      return;
    }

    const query = request.validated?.query as ProfessionalGoogleStartQuery;
    const { url, nonce } = await this.service.buildAuthorization(query.visitType);
    setOAuthNonceCookie(response, nonce);
    response.redirect(url);
  };

  public callback = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as ProfessionalGoogleCallbackQuery;

    // Read then immediately clear the single-use nonce cookie, whatever happens next.
    const nonceCookie = readOAuthNonceCookie(request);
    clearOAuthNonceCookie(response);

    if (query.error || !query.code || !query.state) {
      response.redirect(this.frontendRedirect("error"));
      return;
    }

    let result: ProfessionalGoogleCallbackResult;
    try {
      result = await this.service.completeCallback(
        { code: query.code, state: query.state, nonceCookie },
        this.requestContext(request),
      );
    } catch (error) {
      logger.warn({ err: error }, "Business Owner Google auth callback failed");
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
    const base = `${env.FRONTEND_BASE_URL}/auth/google/callback?flow=professional&status=${status}`;
    return extra ? `${base}&${extra}` : base;
  }

  private requestContext(request: Request): { userAgent?: string; ipAddress?: string } {
    return {
      ...(request.headers["user-agent"] ? { userAgent: request.headers["user-agent"] } : {}),
      ...(request.ip ? { ipAddress: request.ip } : {}),
    };
  }
}
