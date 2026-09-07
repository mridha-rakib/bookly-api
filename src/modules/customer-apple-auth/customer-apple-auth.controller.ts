import type { Request, Response } from "express";

import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { setRefreshCookie } from "../auth/auth.cookies.js";
import { isCustomerAppleAuthConfigured } from "./customer-apple-auth.client.js";
import type { CustomerAppleCallbackBody } from "./customer-apple-auth.schema.js";
import type {
  CustomerAppleAuthService,
  CustomerAppleCallbackResult,
} from "./customer-apple-auth.service.js";

/** Coarse outcomes the frontend `/auth/apple/callback` page branches on. Nothing else — no
 * tokens, id_tokens, emails, subs, or failure reasons — ever goes in the redirect URL. */
type CallbackStatus = "success" | "onboarding" | "account_exists" | "error";

/**
 * HTTP boundary only. NO nonce cookie (Apple's callback is a cross-site POST). Owns the refresh
 * cookie and the always-redirect-to-frontend contract. Mirrors CustomerFacebookAuthController.
 */
export class CustomerAppleAuthController {
  public constructor(private readonly service: CustomerAppleAuthService) {}

  public start = async (_request: Request, response: Response): Promise<void> => {
    if (!isCustomerAppleAuthConfigured()) {
      response.redirect(this.frontendRedirect("error"));
      return;
    }

    const { url } = await this.service.buildAuthorization();
    response.redirect(url);
  };

  /** Apple form_post → fields are in the urlencoded BODY. */
  public callback = async (request: Request, response: Response): Promise<void> => {
    const body = request.validated?.body as CustomerAppleCallbackBody;

    if (body.error || !body.code || !body.state) {
      response.redirect(this.frontendRedirect("error"));
      return;
    }

    let result: CustomerAppleCallbackResult;
    try {
      result = await this.service.completeCallback(
        { code: body.code, idToken: body.id_token, state: body.state, appleUser: body.user },
        this.requestContext(request),
      );
    } catch (error) {
      logger.warn({ err: error }, "Customer Apple auth callback failed");
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
    return `${env.FRONTEND_BASE_URL}/auth/apple/callback?status=${status}`;
  }

  private requestContext(request: Request): { userAgent?: string; ipAddress?: string } {
    return {
      ...(request.headers["user-agent"] ? { userAgent: request.headers["user-agent"] } : {}),
      ...(request.ip ? { ipAddress: request.ip } : {}),
    };
  }
}
