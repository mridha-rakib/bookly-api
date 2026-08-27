import { Types } from "mongoose";

import { logger } from "../../config/logger.js";
import type { BusinessRepository } from "../business/business.repository.js";
import { decryptSecret, encryptSecret } from "./integration.crypto.js";
import { IntegrationError } from "./integration.errors.js";
import {
  buildGoogleAuthUrl,
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  exchangeGoogleAuthCode,
  type GoogleCalendarEventInput,
  refreshGoogleAccessToken,
} from "./integration.google-client.js";
import type { GoogleCalendarIntegrationDocument } from "./integration.model.js";
import type { IntegrationRepository } from "./integration.repository.js";
import { signOAuthState, verifyOAuthState } from "./integration.state.js";

// Refresh a little before actual expiry so a sync call never races token expiry mid-request.
const TOKEN_REFRESH_SKEW_MS = 60_000;

export type GoogleCalendarStatusDto = {
  connected: boolean;
  googleAccountEmail?: string;
  status?: "CONNECTED" | "ERROR";
  connectedAt?: string;
};

export class IntegrationService {
  public constructor(
    private readonly integrationRepository: IntegrationRepository,
    private readonly businessRepository: BusinessRepository,
  ) {}

  /** Only the Business Owner who owns `businessId` may start a Connect flow for it — mirrors
   * BusinessRepository.updateOwnedById's own ownership-filter pattern (never trusts a
   * client-supplied businessId alone). */
  public async getConnectAuthUrl(userId: string, businessId: string): Promise<string> {
    await this.requireOwnedBusiness(userId, businessId);

    const state = await signOAuthState({ businessId, userId });

    return buildGoogleAuthUrl(state);
  }

  /**
   * Google redirects the end user's browser directly to this callback — a plain top-level GET
   * navigation with no way to carry this API's Bearer access token (see integration.route.ts's
   * own comment on why the callback route is deliberately NOT behind `authenticate`). Security
   * instead comes entirely from the signed `state` param itself: it was minted server-side (see
   * signOAuthState), only ever handed to the browser that was already authenticated as a real
   * Business Owner when it called `getConnectAuthUrl`, is HMAC-signed with a key derived from
   * GOOGLE_CLIENT_SECRET (unforgeable without that secret), and expires after 10 minutes. Nobody
   * without that secret can mint a state naming a businessId/userId of their choosing, which is
   * exactly what prevents a stolen/forged state from linking a Google account to someone else's
   * Business (CSRF / cross-account-linking protection, per the OAuth security ground rules).
   * `requireOwnedBusiness` below re-confirms the ownership relationship still holds at redemption
   * time too, not just when the state was originally signed.
   */
  public async handleOAuthCallback(code: string, state: string): Promise<void> {
    const { businessId, userId } = await verifyOAuthState(state);

    await this.requireOwnedBusiness(userId, businessId);

    const tokens = await exchangeGoogleAuthCode(code);

    await this.integrationRepository.upsert({
      businessId: new Types.ObjectId(businessId),
      googleAccountEmail: tokens.googleAccountEmail,
      calendarId: "primary",
      encryptedAccessToken: encryptSecret(tokens.accessToken),
      encryptedRefreshToken: encryptSecret(tokens.refreshToken),
      tokenExpiresAt: tokens.expiresAt,
    });
  }

  public async getStatus(userId: string, businessId: string): Promise<GoogleCalendarStatusDto> {
    await this.requireOwnedBusiness(userId, businessId);

    const integration = await this.integrationRepository.findByBusinessId(businessId);

    if (!integration) {
      return { connected: false };
    }

    return {
      connected: true,
      googleAccountEmail: integration.googleAccountEmail,
      status: integration.status,
      connectedAt: integration.connectedAt.toISOString(),
    };
  }

  public async disconnect(userId: string, businessId: string): Promise<void> {
    await this.requireOwnedBusiness(userId, businessId);
    await this.integrationRepository.deleteByBusinessId(businessId);
  }

  /**
   * Creates a Google Calendar event for a confirmed Booking. Never throws — a Google API
   * failure must not corrupt the Bookly Booking transaction (ground rule). Returns the
   * created event id, or undefined if the business has no connection or the call failed
   * (failure is recorded via markSyncError for the owner to see, not surfaced to the booking
   * flow / customer).
   */
  public async createEventForBooking(
    businessId: Types.ObjectId | string,
    event: GoogleCalendarEventInput,
  ): Promise<string | undefined> {
    const integration = await this.integrationRepository.findByBusinessId(businessId);

    if (!integration) {
      return undefined;
    }

    try {
      const accessToken = await this.getValidAccessToken(integration);

      return await createGoogleCalendarEvent(accessToken, integration.calendarId, event);
    } catch (error) {
      await this.recordSyncFailure(businessId, error);

      return undefined;
    }
  }

  /** Deletes a previously-synced event. Never throws — see createEventForBooking. */
  public async deleteEventForBooking(
    businessId: Types.ObjectId | string,
    googleCalendarEventId: string,
  ): Promise<void> {
    const integration = await this.integrationRepository.findByBusinessId(businessId);

    if (!integration) {
      return;
    }

    try {
      const accessToken = await this.getValidAccessToken(integration);
      await deleteGoogleCalendarEvent(accessToken, integration.calendarId, googleCalendarEventId);
    } catch (error) {
      await this.recordSyncFailure(businessId, error);
    }
  }

  private async getValidAccessToken(
    integration: GoogleCalendarIntegrationDocument,
  ): Promise<string> {
    if (integration.tokenExpiresAt.getTime() - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      return decryptSecret(integration.encryptedAccessToken);
    }

    const refreshToken = decryptSecret(integration.encryptedRefreshToken);
    const refreshed = await refreshGoogleAccessToken(refreshToken);

    await this.integrationRepository.updateTokens(integration._id, {
      encryptedAccessToken: encryptSecret(refreshed.accessToken),
      encryptedRefreshToken: encryptSecret(refreshed.refreshToken),
      tokenExpiresAt: refreshed.expiresAt,
    });

    return refreshed.accessToken;
  }

  private async recordSyncFailure(
    businessId: Types.ObjectId | string,
    error: unknown,
  ): Promise<void> {
    // Never log the raw Google/provider error's payload if it might carry a token — messages
    // from IntegrationError/google-auth-library here are safe, static strings.
    const message = error instanceof Error ? error.message : "Unknown Google Calendar sync error";
    logger.error({ businessId: String(businessId) }, `Google Calendar sync failed: ${message}`);
    await this.integrationRepository.markSyncError(businessId, message);
  }

  private async requireOwnedBusiness(userId: string, businessId: string): Promise<void> {
    if (!Types.ObjectId.isValid(businessId)) {
      throw new IntegrationError("GOOGLE_CALENDAR_ACCESS_DENIED", 404);
    }

    const business = await this.businessRepository.findById(businessId);

    if (!business?.ownerUserId.equals(userId)) {
      throw new IntegrationError("GOOGLE_CALENDAR_ACCESS_DENIED", 404);
    }
  }
}
