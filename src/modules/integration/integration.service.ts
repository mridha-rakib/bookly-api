import { isDeepStrictEqual } from "node:util";
import { Types } from "mongoose";

import { logger } from "../../config/logger.js";
import {
  consumeOrdinaryCalendarSendPermission,
  type OrdinaryCalendarBinding,
  OrdinaryCalendarDispatch,
  type OrdinaryCalendarPort,
  type OrdinaryCalendarProvider,
  sameOrdinaryCalendarDestination,
} from "../booking/ordinary-calendar-dispatch.js";
import type { OrdinaryCalendarDestination } from "../booking/ordinary-calendar-journal.model.js";
import { verifyOrdinaryCalendarDeliveryAuthority } from "../booking/ordinary-calendar-journal-authority.js";
import { PackageCalendarRepository } from "../booking/package-calendar.repository.js";
import { verifyPackageCalendarProductionAuthority } from "../booking/package-calendar-authority.js";
import {
  type CalendarDestination,
  type CalendarTaskReference,
  calendarBookingIntent,
  calendarDestinationSchema,
  calendarJournalSchema,
} from "../booking/package-calendar-contract.js";
import {
  type PackageCalendarDeliveryPort,
  PackageCalendarProviderError,
  PackageCalendarWriteAuthorityUnavailableError,
} from "../booking/package-calendar-delivery.js";
import { PackageCalendarDispatch } from "../booking/package-calendar-dispatch.js";
import type { BusinessRepository } from "../business/business.repository.js";
import { decryptSecret, encryptSecret } from "./integration.crypto.js";
import { IntegrationError } from "./integration.errors.js";
import {
  type BooklyEventMarker,
  buildGoogleAuthUrl,
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  deleteGoogleCalendarEventConditionally,
  exchangeGoogleAuthCode,
  type GoogleCalendarEventInput,
  type GoogleCalendarEventScheduleInput,
  getGoogleCalendarEvent,
  insertGoogleCalendarEventWithId,
  patchGoogleCalendarEventSchedule,
  refreshGoogleAccessToken,
  resolveGoogleCalendarDestination,
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
      ...(tokens.googleAccountId ? { googleAccountId: tokens.googleAccountId } : {}),
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

  /**
   * Moves a previously-synced event to the booking's new start/end (reschedule). Never throws —
   * a Google API failure must not roll back a valid reschedule (same contract as
   * createEventForBooking / deleteEventForBooking). No-ops when the business has no connection.
   * A 404/410 (event manually deleted) is treated as a soft outcome: logged, NOT recorded as an
   * integration error, and the event is never recreated here.
   */
  public async updateEventScheduleForBooking(
    businessId: Types.ObjectId | string,
    eventId: string,
    schedule: GoogleCalendarEventScheduleInput,
  ): Promise<void> {
    const integration = await this.integrationRepository.findByBusinessId(businessId);

    if (!integration) {
      return;
    }

    try {
      const accessToken = await this.getValidAccessToken(integration);
      const outcome = await patchGoogleCalendarEventSchedule(
        accessToken,
        integration.calendarId,
        eventId,
        schedule,
      );

      if (outcome === "EVENT_NOT_FOUND") {
        logger.warn(
          { businessId: String(businessId) },
          "Google Calendar event no longer exists — skipping reschedule sync (not recreating it)",
        );
      }
    } catch (error) {
      await this.recordSyncFailure(businessId, error);
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

  /** Complete package delivery implementation, unregistered and gated separately from purchase.
   * Release is explicit; neither this factory nor a worker scans/releases historical tasks. */
  public packageCalendarDelivery(): PackageCalendarDispatch {
    return new PackageCalendarDispatch({
      resolve: async (businessId) => {
        await verifyPackageCalendarProductionAuthority();
        const integration = await this.integrationRepository.findByBusinessId(businessId);
        if (
          !integration ||
          integration.status !== "CONNECTED" ||
          String(integration.businessId) !== businessId ||
          !integration.connectionGeneration ||
          !integration.googleAccountId
        )
          throw new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);
        const calendarId = await resolveGoogleCalendarDestination(
          await this.getValidAccessToken(integration),
          integration.calendarId,
        );
        const destination = calendarDestinationSchema.parse({
          businessId,
          integrationId: String(integration._id),
          generation: integration.connectionGeneration,
          accountId: integration.googleAccountId,
          accountEmail: integration.googleAccountEmail,
          configuredCalendarId: integration.calendarId,
          calendarId,
        });
        await this.assertPackageCalendarDestination(destination);
        return destination;
      },
      assertCurrent: (destination) => this.assertPackageCalendarDestination(destination),
      bind: (destination, identity) => this.packageCalendarPort(destination, identity),
    });
  }

  private async assertPackageCalendarDestination(destination: CalendarDestination) {
    const integration = await this.integrationRepository.findByBusinessId(destination.businessId);
    if (
      !integration ||
      integration.status !== "CONNECTED" ||
      String(integration.businessId) !== destination.businessId ||
      String(integration._id) !== destination.integrationId ||
      integration.connectionGeneration !== destination.generation ||
      integration.googleAccountId !== destination.accountId ||
      integration.googleAccountEmail !== destination.accountEmail ||
      integration.calendarId !== destination.configuredCalendarId
    )
      throw new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);
  }

  /** Unbound raw mutations remain denied. Bound mutations must consume an exact durable
   * REQUEST_ISSUED intent once, after refreshing credentials and rechecking the connection. */
  public packageCalendarPort(
    destination?: CalendarDestination,
    identity?: { bookingId: string; eventId: string },
  ): PackageCalendarDeliveryPort {
    const repository = new PackageCalendarRepository();
    const withCalendar = async <T>(
      businessId: string,
      call: (accessToken: string, calendarId: string) => Promise<T>,
      mutation?: {
        kind: "INSERT" | "PATCH" | "DELETE";
        eventId: string;
        etag?: string;
        requestId?: string;
        event?: GoogleCalendarEventInput;
        marker?: BooklyEventMarker;
      },
    ): Promise<T | "NOT_CONNECTED"> => {
      if (mutation) {
        await verifyPackageCalendarProductionAuthority();
        if (
          !destination ||
          !identity ||
          identity.eventId !== mutation.eventId ||
          destination.businessId !== businessId
        )
          throw new PackageCalendarWriteAuthorityUnavailableError();
      }
      if (destination) {
        calendarDestinationSchema.parse(destination);
        if (destination.businessId !== businessId)
          throw new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);
        await this.assertPackageCalendarDestination(destination);
      }
      const integration = await this.integrationRepository.findByBusinessId(businessId);
      if (
        !integration ||
        integration.status !== "CONNECTED" ||
        String(integration.businessId) !== businessId ||
        !integration.calendarId
      )
        return "NOT_CONNECTED";
      let providerAttempted = false;
      try {
        const token = await this.getValidAccessToken(integration);
        if (destination) await this.assertPackageCalendarDestination(destination);
        if (mutation && identity && destination) {
          const booking = await repository.read(identity.bookingId, businessId);
          if (!booking) throw new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);
          const journal = calendarJournalSchema.parse(booking.packageCalendarDelivery);
          if (
            journal.state !== "REQUEST_ISSUED" ||
            journal.eventId !== identity.eventId ||
            journal.request?.kind !== mutation.kind ||
            journal.request.id !== mutation.requestId ||
            (booking.googleCalendarEventId !== undefined &&
              booking.googleCalendarEventId !== journal.eventId) ||
            journal.request.settled ||
            journal.request.providerStarted ||
            journal.latest.revision !== journal.request.revision ||
            calendarBookingIntent(booking).revision !== journal.latest.revision ||
            !isDeepStrictEqual(calendarBookingIntent(booking).desired, journal.latest.desired) ||
            !isDeepStrictEqual(journal.destination, destination)
          )
            throw new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);
          if (
            mutation.kind !== "INSERT" &&
            (!mutation.etag || mutation.etag !== journal.request.etag)
          )
            throw new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);
          if (mutation.kind === "DELETE" && journal.latest.desired.kind !== "ABSENT")
            throw new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);
          if (mutation.kind !== "DELETE") {
            const desired = journal.latest.desired;
            if (
              desired.kind !== "PRESENT" ||
              !mutation.event ||
              mutation.event.startAt.getTime() !== desired.startAt.getTime() ||
              mutation.event.endAt.getTime() !== desired.endAt.getTime() ||
              mutation.event.timezone !== desired.timezone ||
              (mutation.kind === "INSERT" &&
                (mutation.event.summary !== desired.summary ||
                  mutation.event.description !== desired.description ||
                  mutation.marker?.booklyBookingId !== journal.bookingId ||
                  mutation.marker?.booklyBusinessId !== businessId))
            )
              throw new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);
          }
          const started = { ...journal, request: { ...journal.request, providerStarted: true } };
          if (!(await repository.compareAndSet(booking, journal, started)))
            throw new PackageCalendarProviderError("RETRYABLE_FAILURE", true);
          await this.assertPackageCalendarDestination(destination);
        }
        providerAttempted = true;
        return await call(token, destination?.calendarId ?? integration.calendarId);
      } catch (error) {
        if (
          !(error instanceof PackageCalendarProviderError) ||
          (providerAttempted && error.kind === "BLOCKED_AUTHORITY")
        ) {
          if (destination)
            await this.integrationRepository.markSyncError(
              businessId,
              "Package Calendar authorization failed",
              destination.generation,
            );
          else await this.recordSyncFailure(businessId, error);
        }
        throw error;
      }
    };
    return {
      ...(!destination
        ? {
            deliver: (reference: CalendarTaskReference) =>
              this.packageCalendarDelivery().deliver(reference),
          }
        : {}),
      read: async (businessId: string, eventId: string) => {
        const result = await withCalendar(businessId, (token, calendarId) =>
          getGoogleCalendarEvent(token, calendarId, eventId),
        );
        return result === "NOT_CONNECTED" ? { outcome: "NOT_CONNECTED" as const } : result;
      },
      insert: (
        businessId: string,
        eventId: string,
        event: GoogleCalendarEventInput,
        marker: BooklyEventMarker,
        requestId?: string,
      ) =>
        withCalendar(
          businessId,
          (token, calendarId) =>
            insertGoogleCalendarEventWithId(token, calendarId, eventId, event, marker),
          { kind: "INSERT", eventId, event, marker, ...(requestId ? { requestId } : {}) },
        ),
      patchSchedule: async (
        businessId: string,
        eventId: string,
        schedule: GoogleCalendarEventScheduleInput,
        ifMatch?: string,
        requestId?: string,
      ) => {
        const result = await withCalendar(
          businessId,
          (token, calendarId) =>
            patchGoogleCalendarEventSchedule(
              token,
              calendarId,
              eventId,
              schedule,
              ifMatch ? { etag: ifMatch } : undefined,
            ),
          {
            kind: "PATCH",
            eventId,
            event: { ...schedule, summary: "" },
            ...(ifMatch ? { etag: ifMatch } : {}),
            ...(requestId ? { requestId } : {}),
          },
        );
        return result === "EVENT_NOT_FOUND" ? ("NOT_FOUND" as const) : result;
      },
      remove: async (businessId: string, eventId: string, ifMatch?: string, requestId?: string) => {
        const result = await withCalendar(
          businessId,
          async (token, calendarId) => {
            if (!ifMatch) throw new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);
            return deleteGoogleCalendarEventConditionally(token, calendarId, eventId, ifMatch);
          },
          {
            kind: "DELETE",
            eventId,
            ...(ifMatch ? { etag: ifMatch } : {}),
            ...(requestId ? { requestId } : {}),
          },
        );
        return result;
      },
    };
  }

  /**
   * P4B-2B — ordinary Booking Calendar provider. Uses the same Google client helpers, token
   * refresh and connection-generation fence as P2C, but a separate journal and authority.
   * Calls go to the destination recorded on the journal row (account id, generation and
   * configured calendar of that connection); a reconnect or a different account blocks.
   * Any failure before the send permission is consumed is a definitive no-effect answer;
   * after it, anything Google did not classify (timeout, network) is UNKNOWN_OUTCOME.
   * Unregistered: only the default-denied delivery authority lets it run.
   */
  public ordinaryCalendarProvider(): OrdinaryCalendarProvider {
    const currentDestination = async (
      businessId: string,
    ): Promise<OrdinaryCalendarDestination | null> => {
      const integration = await this.integrationRepository.findByBusinessId(businessId);
      if (
        !integration ||
        integration.status !== "CONNECTED" ||
        String(integration.businessId) !== businessId ||
        !integration.connectionGeneration ||
        !integration.googleAccountId ||
        !integration.calendarId
      )
        return null;
      return {
        integrationId: integration._id,
        generation: integration.connectionGeneration,
        accountId: integration.googleAccountId,
        accountEmail: integration.googleAccountEmail,
        configuredCalendarId: integration.calendarId,
      };
    };
    const assertCurrent = async (businessId: string, destination: OrdinaryCalendarDestination) => {
      if (
        !sameOrdinaryCalendarDestination(
          (await currentDestination(businessId)) ?? undefined,
          destination,
        )
      )
        throw new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);
    };
    const bind = (binding: OrdinaryCalendarBinding): OrdinaryCalendarPort => {
      const calendarId = binding.destination.configuredCalendarId;
      const accessToken = async () => {
        await verifyOrdinaryCalendarDeliveryAuthority();
        await assertCurrent(binding.businessId, binding.destination);
        const integration = await this.integrationRepository.findByBusinessId(binding.businessId);
        if (!integration) throw new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);
        // Refresh is fenced on the recorded generation; a concurrent reconnect blocks here.
        const token = await this.getValidAccessToken(integration);
        await assertCurrent(binding.businessId, binding.destination);
        return token;
      };
      const mutate = async <T>(
        mutation: Parameters<typeof consumeOrdinaryCalendarSendPermission>[1],
        call: (token: string) => Promise<T>,
      ): Promise<T> => {
        let token: string;
        try {
          token = await accessToken();
          await consumeOrdinaryCalendarSendPermission(binding, mutation);
        } catch (error) {
          // Google was never called for this request.
          throw error instanceof PackageCalendarProviderError
            ? new PackageCalendarProviderError(error.kind, true)
            : new PackageCalendarProviderError("RETRYABLE_FAILURE", true);
        }
        try {
          return await call(token);
        } catch (error) {
          if (error instanceof PackageCalendarProviderError) throw error;
          throw new PackageCalendarProviderError("UNKNOWN_OUTCOME");
        }
      };
      return {
        read: async () => {
          let token: string;
          try {
            token = await accessToken();
          } catch (error) {
            if (error instanceof PackageCalendarProviderError && error.kind === "BLOCKED_AUTHORITY")
              return { outcome: "NOT_CONNECTED" as const };
            throw error;
          }
          return getGoogleCalendarEvent(token, calendarId, binding.eventId);
        },
        insert: (event, requestId) =>
          mutate({ kind: "INSERT", requestId, event }, (token) =>
            insertGoogleCalendarEventWithId(token, calendarId, binding.eventId, event, {
              booklyBookingId: binding.bookingId,
              booklyBusinessId: binding.businessId,
            }),
          ),
        patchSchedule: (schedule, etag, requestId) =>
          mutate({ kind: "PATCH", requestId, etag, event: schedule }, async (token) => {
            const result = await patchGoogleCalendarEventSchedule(
              token,
              calendarId,
              binding.eventId,
              schedule,
              { etag },
            );
            return result === "EVENT_NOT_FOUND" ? ("NOT_FOUND" as const) : result;
          }),
        remove: (etag, requestId) =>
          mutate({ kind: "DELETE", requestId, etag }, (token) =>
            deleteGoogleCalendarEventConditionally(token, calendarId, binding.eventId, etag),
          ),
      };
    };
    return { currentDestination, assertCurrent, bind };
  }

  /** P4B-2B — the ordinary Calendar consumer, unregistered and default-denied. */
  public ordinaryCalendarDelivery(): OrdinaryCalendarDispatch {
    return new OrdinaryCalendarDispatch(this.ordinaryCalendarProvider());
  }

  private async getValidAccessToken(
    integration: GoogleCalendarIntegrationDocument,
  ): Promise<string> {
    if (integration.tokenExpiresAt.getTime() - TOKEN_REFRESH_SKEW_MS > Date.now()) {
      return decryptSecret(integration.encryptedAccessToken);
    }

    const refreshToken = decryptSecret(integration.encryptedRefreshToken);
    const refreshed = await refreshGoogleAccessToken(refreshToken);

    const updated = await this.integrationRepository.updateTokens(
      integration._id,
      {
        encryptedAccessToken: encryptSecret(refreshed.accessToken),
        encryptedRefreshToken: encryptSecret(refreshed.refreshToken),
        tokenExpiresAt: refreshed.expiresAt,
      },
      integration.connectionGeneration,
    );
    if (updated === false) throw new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);

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
