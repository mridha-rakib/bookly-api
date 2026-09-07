import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AuthError } from "../auth/auth.errors.js";
import type {
  AppleLinkCallbackBody,
  LinkCallbackQuery,
  UnlinkLinkedAccountBody,
} from "./linked-account.schema.js";
import type { LinkedAccountService } from "./linked-account.service.js";

type CallbackResult = "connected" | "error";
type CallbackProvider = "google" | "facebook" | "apple";

/**
 * HTTP boundary only — resolves the acting user, delegates to LinkedAccountService, and shapes
 * the response. Every OAuth callback follows the same contract as
 * IntegrationController.handleGoogleCalendarCallback: it ALWAYS redirects back to the settings
 * page (never renders an error body), and never leaks why a link failed.
 */
export class LinkedAccountController {
  public constructor(private readonly linkedAccountService: LinkedAccountService) {}

  // --- Google ---------------------------------------------------------------

  public getGoogleAuthorizeUrl = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const authUrl = await this.linkedAccountService.buildGoogleAuthorizeUrl(userId);
    sendSuccess(response, 200, "Google account link authorization URL", { authUrl });
  };

  public handleGoogleCallback = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as LinkCallbackQuery;

    if (query.error || !query.code) {
      response.redirect(this.settingsRedirectUrl("google", "error"));
      return;
    }

    try {
      await this.linkedAccountService.linkGoogleFromCallback(query.code, query.state);
      response.redirect(this.settingsRedirectUrl("google", "connected"));
    } catch (error) {
      logger.warn({ err: error }, "Google account link callback failed");
      response.redirect(this.settingsRedirectUrl("google", "error"));
    }
  };

  public unlinkGoogle = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    await this.linkedAccountService.unlinkGoogle(
      userId,
      request.validated?.body as UnlinkLinkedAccountBody,
    );
    sendSuccess(response, 200, "Google account unlinked");
  };

  // --- Facebook (linking only) --------------------------------------------

  public getFacebookAuthorizeUrl = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const authUrl = await this.linkedAccountService.buildFacebookAuthorizeUrl(userId);
    sendSuccess(response, 200, "Facebook account link authorization URL", { authUrl });
  };

  public handleFacebookCallback = async (request: Request, response: Response): Promise<void> => {
    const query = request.validated?.query as LinkCallbackQuery;

    if (query.error || !query.code) {
      response.redirect(this.settingsRedirectUrl("facebook", "error"));
      return;
    }

    try {
      await this.linkedAccountService.linkFacebookFromCallback(query.code, query.state);
      response.redirect(this.settingsRedirectUrl("facebook", "connected"));
    } catch (error) {
      logger.warn({ err: error }, "Facebook account link callback failed");
      response.redirect(this.settingsRedirectUrl("facebook", "error"));
    }
  };

  public unlinkFacebook = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    await this.linkedAccountService.unlinkFacebook(
      userId,
      request.validated?.body as UnlinkLinkedAccountBody,
    );
    sendSuccess(response, 200, "Facebook account unlinked");
  };

  // --- Apple (linking only) --------------------------------------------

  public getAppleAuthorizeUrl = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const authUrl = await this.linkedAccountService.buildAppleAuthorizeUrl(userId);
    sendSuccess(response, 200, "Apple account link authorization URL", { authUrl });
  };

  /** Apple form_post → fields are in the urlencoded BODY, not the query. */
  public handleAppleCallback = async (request: Request, response: Response): Promise<void> => {
    const body = request.validated?.body as AppleLinkCallbackBody;

    if (body.error || !body.code || !body.state) {
      response.redirect(this.settingsRedirectUrl("apple", "error"));
      return;
    }

    try {
      await this.linkedAccountService.linkAppleFromCallback({
        code: body.code,
        idToken: body.id_token,
        state: body.state,
      });
      response.redirect(this.settingsRedirectUrl("apple", "connected"));
    } catch (error) {
      logger.warn({ err: error }, "Apple account link callback failed");
      response.redirect(this.settingsRedirectUrl("apple", "error"));
    }
  };

  public unlinkApple = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    await this.linkedAccountService.unlinkApple(
      userId,
      request.validated?.body as UnlinkLinkedAccountBody,
    );
    sendSuccess(response, 200, "Apple account unlinked");
  };

  // --- shared ------------------------------------------------------------

  private settingsRedirectUrl(provider: CallbackProvider, result: CallbackResult): string {
    return `${env.FRONTEND_BASE_URL}/customer/settings?linkedAccount=${provider}&result=${result}`;
  }

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }
}
