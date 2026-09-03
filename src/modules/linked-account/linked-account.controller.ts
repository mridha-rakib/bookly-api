import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AuthError } from "../auth/auth.errors.js";
import type { GoogleLinkCallbackQuery, UnlinkGoogleAccountBody } from "./linked-account.schema.js";
import type { LinkedAccountService } from "./linked-account.service.js";

type CallbackResult = "connected" | "error";

/**
 * HTTP boundary only — resolves the acting user, delegates to LinkedAccountService, and shapes
 * the response. The OAuth callback follows the same contract as
 * IntegrationController.handleGoogleCalendarCallback: it ALWAYS redirects back to the settings
 * page (never renders an error body), and never leaks why a link failed.
 */
export class LinkedAccountController {
  public constructor(private readonly linkedAccountService: LinkedAccountService) {}

  public getGoogleAuthorizeUrl = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const authUrl = await this.linkedAccountService.buildGoogleAuthorizeUrl(userId);
    sendSuccess(response, 200, "Google account link authorization URL", { authUrl });
  };

  public handleGoogleCallback = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as GoogleLinkCallbackQuery;

    if (query.error || !query.code) {
      response.redirect(this.settingsRedirectUrl("error"));
      return;
    }

    try {
      await this.linkedAccountService.linkGoogleFromCallback(query.code, query.state);
      response.redirect(this.settingsRedirectUrl("connected"));
    } catch (error) {
      logger.warn({ err: error }, "Google account link callback failed");
      response.redirect(this.settingsRedirectUrl("error"));
    }
  };

  public unlinkGoogle = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    await this.linkedAccountService.unlinkGoogle(
      userId,
      request.validated?.body as UnlinkGoogleAccountBody,
    );
    sendSuccess(response, 200, "Google account unlinked");
  };

  private settingsRedirectUrl(result: CallbackResult): string {
    return `${env.FRONTEND_BASE_URL}/customer/settings?linkedAccount=google&result=${result}`;
  }

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }
}
