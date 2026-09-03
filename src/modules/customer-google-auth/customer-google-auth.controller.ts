import type { Request, Response } from "express";

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { setRefreshCookie } from "../auth/auth.cookies.js";
import { isCustomerGoogleAuthConfigured } from "./customer-google-auth.client.js";
import {
  clearOAuthNonceCookie,
  readOAuthNonceCookie,
  setOAuthNonceCookie,
} from "./customer-google-auth.nonce.js";
import type { CustomerGoogleCallbackQuery } from "./customer-google-auth.schema.js";
import type {
  CustomerGoogleAuthService,
  CustomerGoogleCallbackResult,
} from "./customer-google-auth.service.js";

/** Coarse outcomes the frontend landing page (`/auth/google/callback`) branches on. Nothing
 * else — no tokens, emails, ids, or failure reasons — is ever put in the redirect URL. */
type CallbackStatus = "success" | "onboarding" | "account_exists" | "error";

/**
 * HTTP boundary only. Owns the nonce cookie, the refresh cookie (via the shared setRefreshCookie),
 * and the always-redirect-to-frontend contract — it never renders an error body and never leaks
 * why a sign-in failed, mirroring IntegrationController / LinkedAccountController.
 */
export class CustomerGoogleAuthController {
  public constructor(private readonly service: CustomerGoogleAuthService) {}

  public start = async (_request: Request, response: Response): Promise<void> => {
    if (!isCustomerGoogleAuthConfigured()) {
      response.redirect(this.frontendRedirect("error"));
      return;
    }

    const { url, nonce } = await this.service.buildAuthorization();
    setOAuthNonceCookie(response, nonce);
    response.redirect(url);
  };

  public callback = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as CustomerGoogleCallbackQuery;

    // Read then immediately clear the single-use nonce cookie, whatever happens next.
    const nonceCookie = readOAuthNonceCookie(request);
    clearOAuthNonceCookie(response);

    if (query.error || !query.code || !query.state) {
      response.redirect(this.frontendRedirect("error"));
      return;
    }

    let result: CustomerGoogleCallbackResult;
    try {
      result = await this.service.completeCallback(
        { code: query.code, state: query.state, nonceCookie },
        this.requestContext(request),
      );
    } catch (error) {
      logger.warn({ err: error }, "Customer Google auth callback failed");
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
    return `${env.FRONTEND_BASE_URL}/auth/google/callback?status=${status}`;
  }

  private requestContext(request: Request): { userAgent?: string; ipAddress?: string } {
    return {
      ...(request.headers["user-agent"] ? { userAgent: request.headers["user-agent"] } : {}),
      ...(request.ip ? { ipAddress: request.ip } : {}),
    };
  }
}
