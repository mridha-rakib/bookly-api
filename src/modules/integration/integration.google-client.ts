import type { Credentials } from "google-auth-library";
import { OAuth2Client } from "google-auth-library";

import { env } from "../../config/env.js";
import { PackageCalendarProviderError } from "../booking/package-calendar-delivery.js";
import { IntegrationError } from "./integration.errors.js";

const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const USERINFO_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
const CALENDAR_METADATA_SCOPE = "https://www.googleapis.com/auth/calendar.calendars.readonly";
const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

export type GoogleTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
};

export type GoogleCalendarEventInput = {
  summary: string;
  description?: string;
  startAt: Date;
  endAt: Date;
  timezone: string;
};

/** Just the schedule fields a reschedule PATCH changes — never the event's content. */
export type GoogleCalendarEventScheduleInput = {
  startAt: Date;
  endAt: Date;
  timezone: string;
};

/**
 * "UPDATED" — the existing event was patched. "EVENT_NOT_FOUND" — Google returned 404/410, i.e.
 * the Owner (or another tool) deleted the event out from under us: a soft external-state
 * condition, NOT a broken integration, so the caller neither recreates it nor marks the whole
 * connection errored.
 */
export type GoogleCalendarPatchOutcome = "UPDATED" | "EVENT_NOT_FOUND" | "PRECONDITION_FAILED";

function requireGoogleOAuthConfig(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALENDAR_REDIRECT_URI } = env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_CALENDAR_REDIRECT_URI) {
    throw new IntegrationError("GOOGLE_CALENDAR_NOT_CONFIGURED", 503);
  }

  return {
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    redirectUri: GOOGLE_CALENDAR_REDIRECT_URI,
  };
}

function createOAuthClient(): OAuth2Client {
  const { clientId, clientSecret, redirectUri } = requireGoogleOAuthConfig();

  return new OAuth2Client({ clientId, clientSecret, redirectUri });
}

export function buildGoogleAuthUrl(state: string): string {
  const client = createOAuthClient();

  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["openid", CALENDAR_EVENTS_SCOPE, USERINFO_SCOPE, CALENDAR_METADATA_SCOPE],
    state,
  });
}

/** Exchanges an authorization `code` for tokens. Google only returns a refresh_token on the
 * FIRST consent (subsequent re-consents may omit it) — callers must not overwrite a
 * previously-stored refresh_token with an empty one. */
export async function exchangeGoogleAuthCode(
  code: string,
): Promise<GoogleTokenSet & { googleAccountEmail: string; googleAccountId?: string }> {
  const client = createOAuthClient();

  let tokens: Credentials;
  try {
    ({ tokens } = await client.getToken(code));
  } catch {
    throw new IntegrationError("GOOGLE_CALENDAR_OAUTH_FAILED", 502);
  }

  if (!tokens.access_token || !tokens.refresh_token || !tokens.expiry_date) {
    throw new IntegrationError("GOOGLE_CALENDAR_OAUTH_FAILED", 502);
  }

  const profile = await fetchGoogleAccountEmail(tokens.access_token);

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(tokens.expiry_date),
    ...profile,
  };
}

async function fetchGoogleAccountEmail(accessToken: string) {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new IntegrationError("GOOGLE_CALENDAR_OAUTH_FAILED", 502);
  }

  const body = (await response.json()) as { email?: string; sub?: string; id?: string };
  const accountId = body.sub ?? body.id;
  return {
    googleAccountEmail: body.email ?? "unknown",
    ...(accountId ? { googleAccountId: accountId } : {}),
  };
}

export async function refreshGoogleAccessToken(refreshToken: string): Promise<GoogleTokenSet> {
  const client = createOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });

  let credentials: Credentials;
  try {
    ({ credentials } = await client.refreshAccessToken());
  } catch {
    throw new IntegrationError("GOOGLE_CALENDAR_OAUTH_FAILED", 502);
  }

  if (!credentials.access_token || !credentials.expiry_date) {
    throw new IntegrationError("GOOGLE_CALENDAR_OAUTH_FAILED", 502);
  }

  return {
    accessToken: credentials.access_token,
    // Google may not return a new refresh_token on refresh — the caller keeps the existing one.
    refreshToken: credentials.refresh_token ?? refreshToken,
    expiresAt: new Date(credentials.expiry_date),
  };
}

/** Bounded, single-attempt calls only (see rate-limit ground rule) — no retry/backoff loop. */
async function callCalendarApi(
  accessToken: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const response = await fetch(`${CALENDAR_API_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  return response;
}

export async function createGoogleCalendarEvent(
  accessToken: string,
  calendarId: string,
  event: GoogleCalendarEventInput,
): Promise<string> {
  const response = await callCalendarApi(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      body: JSON.stringify({
        summary: event.summary,
        description: event.description,
        start: { dateTime: event.startAt.toISOString(), timeZone: event.timezone },
        end: { dateTime: event.endAt.toISOString(), timeZone: event.timezone },
      }),
    },
  );

  if (!response.ok) {
    throw new IntegrationError("GOOGLE_CALENDAR_OAUTH_FAILED", 502);
  }

  const body = (await response.json()) as { id: string };

  return body.id;
}

/**
 * Moves an already-synced event to a new start/end. Uses HTTP PATCH (a partial update), NOT a
 * full-resource PUT: the Owner may have added Google Meet / conferenceData, attendees, custom
 * reminders or extendedProperties after Bookly created the event, and a full update would wipe
 * every field not resent. This PATCH therefore carries ONLY `start` and `end` — never summary,
 * description, location, attendees, conferenceData, reminders, extendedProperties, or any
 * booking/customer data (a reschedule changes none of those). Single attempt, no retry/backoff
 * (see callCalendarApi's own contract).
 */
export async function patchGoogleCalendarEventSchedule(
  accessToken: string,
  calendarId: string,
  eventId: string,
  schedule: GoogleCalendarEventScheduleInput,
  conditional?: { etag: string },
): Promise<GoogleCalendarPatchOutcome> {
  const response = await callCalendarApi(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      ...(conditional
        ? { headers: { "If-Match": conditional.etag }, signal: AbortSignal.timeout(10_000) }
        : {}),
      body: JSON.stringify({
        start: { dateTime: schedule.startAt.toISOString(), timeZone: schedule.timezone },
        end: { dateTime: schedule.endAt.toISOString(), timeZone: schedule.timezone },
      }),
    },
  );

  // 404/410 = the event is gone (manually deleted by the Owner, or the id is stale). Soft
  // condition: the caller must not recreate it and must not mark the integration broken.
  if (response.status === 404 || response.status === 410) {
    return "EVENT_NOT_FOUND";
  }

  if (conditional && response.status === 412) return "PRECONDITION_FAILED";
  if (conditional && !response.ok) throwPackageCalendarFailure(response.status, true);
  if (!response.ok) {
    throw new IntegrationError("GOOGLE_CALENDAR_OAUTH_FAILED", 502);
  }

  return "UPDATED";
}

/**
 * P2C — Bookly ownership marker stored in `extendedProperties.private` of events created with a
 * deterministic id. Identifiers only; never customer data.
 */
export type BooklyEventMarker = { booklyBookingId: string; booklyBusinessId: string };

export type GoogleCalendarEventObservation =
  | { outcome: "NOT_FOUND" }
  | {
      outcome: "FOUND";
      /** Google `status`: "confirmed" | "tentative" | "cancelled" (deleted events keep ids). */
      status: string;
      startAt: Date | null;
      endAt: Date | null;
      marker: Partial<BooklyEventMarker>;
      etag?: string;
    };

/**
 * Inserts with a caller-chosen id (base32hex, 5–1024 long). A 409 requires read-back, not a
 * success claim. Google does not guarantee collision detection at creation and deleted-event
 * tombstones eventually disappear. Never use this helper as exactly-once delivery authority.
 * No attendees are supplied. Single bounded attempt, no retry.
 */
export async function insertGoogleCalendarEventWithId(
  accessToken: string,
  calendarId: string,
  eventId: string,
  event: GoogleCalendarEventInput,
  marker: BooklyEventMarker,
): Promise<"CREATED" | "ALREADY_EXISTS"> {
  if (!/^[a-v0-9]{5,1024}$/.test(eventId))
    throw new IntegrationError("GOOGLE_CALENDAR_OAUTH_FAILED", 502);
  const response = await callCalendarApi(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        id: eventId,
        summary: event.summary,
        description: event.description,
        start: { dateTime: event.startAt.toISOString(), timeZone: event.timezone },
        end: { dateTime: event.endAt.toISOString(), timeZone: event.timezone },
        extendedProperties: { private: marker },
      }),
    },
  );
  if (response.status === 409) return "ALREADY_EXISTS";
  if (!response.ok) throwPackageCalendarFailure(response.status, true);
  return "CREATED";
}

/** Reads one event by id. 404/410 → NOT_FOUND. Single attempt, no retry. */
export async function getGoogleCalendarEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<GoogleCalendarEventObservation> {
  const response = await callCalendarApi(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "GET", signal: AbortSignal.timeout(10_000) },
  );
  if (response.status === 404 || response.status === 410) return { outcome: "NOT_FOUND" };
  if (!response.ok) throwPackageCalendarFailure(response.status, false);
  const body = (await response.json()) as {
    status?: unknown;
    etag?: unknown;
    start?: { dateTime?: unknown };
    end?: { dateTime?: unknown };
    extendedProperties?: { private?: Record<string, unknown> };
  };
  const instant = (value: unknown) => {
    if (typeof value !== "string") return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  };
  const priv = body.extendedProperties?.private ?? {};
  return {
    outcome: "FOUND",
    status: typeof body.status === "string" ? body.status : "unknown",
    ...(typeof body.etag === "string" ? { etag: body.etag } : {}),
    startAt: instant(body.start?.dateTime),
    endAt: instant(body.end?.dateTime),
    marker: {
      ...(typeof priv["booklyBookingId"] === "string"
        ? { booklyBookingId: priv["booklyBookingId"] }
        : {}),
      ...(typeof priv["booklyBusinessId"] === "string"
        ? { booklyBusinessId: priv["booklyBusinessId"] }
        : {}),
    },
  };
}

/** Resolve an alias once under the connected account; persist the actual destination ID. */
export async function resolveGoogleCalendarDestination(accessToken: string, calendarId: string) {
  const response = await callCalendarApi(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}`,
    { method: "GET", signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok) throwPackageCalendarFailure(response.status, false);
  const body = (await response.json()) as { id?: unknown };
  if (typeof body.id !== "string" || !body.id || body.id === "primary")
    throw new PackageCalendarProviderError("BLOCKED_AUTHORITY");
  return body.id;
}

/** Same provider transport as ordinary deletion, with the package journal's observed ETag. */
export async function deleteGoogleCalendarEventConditionally(
  accessToken: string,
  calendarId: string,
  eventId: string,
  etag: string,
): Promise<"DELETED" | "PRECONDITION_FAILED"> {
  const response = await callCalendarApi(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "DELETE",
      headers: { "If-Match": etag },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (response.status === 412) return "PRECONDITION_FAILED";
  if (response.status === 404 || response.status === 410) return "DELETED";
  if (!response.ok) throwPackageCalendarFailure(response.status, true);
  return "DELETED";
}

function throwPackageCalendarFailure(status: number, mutation: boolean): never {
  if (status === 401 || status === 403)
    throw new PackageCalendarProviderError("BLOCKED_AUTHORITY", true);
  if (status === 400 || status === 422)
    throw new PackageCalendarProviderError("PERMANENT_FAILURE", true);
  if (status === 429) throw new PackageCalendarProviderError("RETRYABLE_FAILURE", true);
  throw new PackageCalendarProviderError(mutation ? "UNKNOWN_OUTCOME" : "RETRYABLE_FAILURE");
}

export async function deleteGoogleCalendarEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  const response = await callCalendarApi(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" },
  );

  // 404/410 = the event is already gone (or was never created) — deleting is still a success
  // from the caller's point of view (idempotent).
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    throw new IntegrationError("GOOGLE_CALENDAR_OAUTH_FAILED", 502);
  }
}
