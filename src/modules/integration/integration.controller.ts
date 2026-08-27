import type { Request, Response } from "express";

import { sendSuccess } from "../../common/http/responses.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AuthError } from "../auth/auth.errors.js";
import type {
  GoogleCalendarCallbackQuery,
  IntegrationBusinessParams,
} from "./integration.schema.js";
import type { IntegrationService } from "./integration.service.js";

// The single Business-facing frontend origin bookings/settings live on — reuses the already-
// configured CORS allow-list's first entry rather than introducing a second "our frontend URL"
// env var (no such var exists in this codebase yet; see env.ts's own CORS_ORIGINS).
function frontendSettingsUrl(status: "connected" | "error"): string {
  const origin = env.CORS_ORIGINS[0] ?? "http://localhost:3000";

  return `${origin}/business-dashboard?settingsTab=Integration&googleCalendar=${status}`;
}

export class IntegrationController {
  public constructor(private readonly integrationService: IntegrationService) {}

  /** Called via an authenticated fetch (not a raw browser navigation) — this API only accepts a
   * Bearer access token, which a plain `window.location` navigation can't carry, so the frontend
   * fetches the real Google auth URL here first and then navigates the browser to it itself. */
  public connectGoogleCalendar = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as IntegrationBusinessParams;
    const authUrl = await this.integrationService.getConnectAuthUrl(userId, params.businessId);
    sendSuccess(response, 200, "Google Calendar authorization URL", { authUrl });
  };

  /**
   * Google redirects the browser here after consent — a plain top-level navigation that cannot
   * carry this API's Bearer access token, so this route is deliberately NOT behind
   * `authenticate` (see integration.route.ts for how it's mounted outside that gate). See
   * IntegrationService.handleOAuthCallback's own comment for what actually secures this endpoint
   * instead (the signed `state` param).
   */
  public handleGoogleCalendarCallback = async (
    request: Request,
    response: Response,
  ): Promise<void> => {
    const query = request.validated?.query as GoogleCalendarCallbackQuery;

    if (query.error || !query.code) {
      response.redirect(frontendSettingsUrl("error"));
      return;
    }

    try {
      await this.integrationService.handleOAuthCallback(query.code, query.state);
      response.redirect(frontendSettingsUrl("connected"));
    } catch (error) {
      logger.warn({ err: error }, "Google Calendar OAuth callback failed");
      response.redirect(frontendSettingsUrl("error"));
    }
  };

  public getGoogleCalendarStatus = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as IntegrationBusinessParams;
    const result = await this.integrationService.getStatus(userId, params.businessId);
    sendSuccess(response, 200, "Google Calendar status", result);
  };

  public disconnectGoogleCalendar = async (request: Request, response: Response): Promise<void> => {
    const userId = this.requireUserId(request);
    const params = request.validated?.params as IntegrationBusinessParams;
    await this.integrationService.disconnect(userId, params.businessId);
    sendSuccess(response, 200, "Google Calendar disconnected");
  };

  private requireUserId(request: Request): string {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AuthError("SESSION_EXPIRED", 401);
    }

    return userId;
  }
}
