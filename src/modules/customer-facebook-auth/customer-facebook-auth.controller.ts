import type { Request, Response } from "express";

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { setRefreshCookie } from "../auth/auth.cookies.js";
import { isCustomerFacebookAuthConfigured } from "./customer-facebook-auth.client.js";
import {
  clearOAuthNonceCookie,
  readOAuthNonceCookie,
  setOAuthNonceCookie,
} from "./customer-facebook-auth.nonce.js";
import type { CustomerFacebookCallbackQuery } from "./customer-facebook-auth.schema.js";
import type {
  CustomerFacebookAuthService,
  CustomerFacebookCallbackResult,
} from "./customer-facebook-auth.service.js";

/** Coarse outcomes the frontend `/auth/facebook/callback` page branches on. Nothing else — no
 * tokens, emails, ids, or failure reasons — ever goes in the redirect URL. */
type CallbackStatus = "success" | "onboarding" | "account_exists" | "error";

/**
 * HTTP boundary only. Owns the Customer Facebook nonce cookie, the refresh cookie (via the shared
 * setRefreshCookie), and the always-redirect-to-frontend contract — it never renders an error
 * body and never leaks why a sign-in failed. Mirrors CustomerGoogleAuthController.
 */
export class CustomerFacebookAuthController {
  public constructor(private readonly service: CustomerFacebookAuthService) {}

  public start = async (_request: Request, response: Response): Promise<void> => {
    if (!isCustomerFacebookAuthConfigured()) {
      response.redirect(this.frontendRedirect("error"));
      return;
    }

    const { url, nonce } = await this.service.buildAuthorization();
    setOAuthNonceCookie(response, nonce);
    response.redirect(url);
  };

  public callback = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as CustomerFacebookCallbackQuery;

    // Read then immediately clear the single-use nonce cookie, whatever happens next.
    const nonceCookie = readOAuthNonceCookie(request);
    clearOAuthNonceCookie(response);

    if (query.error || !query.code || !query.state) {
      response.redirect(this.frontendRedirect("error"));
      return;
    }

    let result: CustomerFacebookCallbackResult;
    try {
      result = await this.service.completeCallback(
        { code: query.code, state: query.state, nonceCookie },
        this.requestContext(request),
      );
    } catch (error) {
      logger.warn({ err: error }, "Customer Facebook auth callback failed");
      response.redirect(this.frontendRedirect("error"));
      return;
    }

    if (result.type === "SESSION") {
      setRefreshCookie(response, result.auth.refreshToken);
      response.redirect(
        this.frontendRedirect(result.requiresPhoneCompletion ? "onboarding" : "success"),
      );
      return;
    }

    if (result.type === "ACCOUNT_EXISTS") {
      response.redirect(this.frontendRedirect("account_exists"));
      return;
    }

    response.redirect(this.frontendRedirect("error"));
  };

  private frontendRedirect(status: CallbackStatus): string {
    return `${env.FRONTEND_BASE_URL}/auth/facebook/callback?status=${status}`;
  }

  private requestContext(request: Request): { userAgent?: string; ipAddress?: string } {
    return {
      ...(request.headers["user-agent"] ? { userAgent: request.headers["user-agent"] } : {}),
      ...(request.ip ? { ipAddress: request.ip } : {}),
    };
  }
}
