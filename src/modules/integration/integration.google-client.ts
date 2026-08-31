import type { Credentials } from "google-auth-library";
import { OAuth2Client } from "google-auth-library";

import { env } from "../../config/env.js";
import { IntegrationError } from "./integration.errors.js";

const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const USERINFO_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
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
export type GoogleCalendarPatchOutcome = "UPDATED" | "EVENT_NOT_FOUND";

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
    scope: [CALENDAR_EVENTS_SCOPE, USERINFO_SCOPE],
    state,
  });
}

/** Exchanges an authorization `code` for tokens. Google only returns a refresh_token on the
 * FIRST consent (subsequent re-consents may omit it) — callers must not overwrite a
 * previously-stored refresh_token with an empty one. */
export async function exchangeGoogleAuthCode(
  code: string,
): Promise<GoogleTokenSet & { googleAccountEmail: string }> {
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

  const googleAccountEmail = await fetchGoogleAccountEmail(tokens.access_token);

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(tokens.expiry_date),
    googleAccountEmail,
  };
}

async function fetchGoogleAccountEmail(accessToken: string): Promise<string> {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new IntegrationError("GOOGLE_CALENDAR_OAUTH_FAILED", 502);
  }

  const body = (await response.json()) as { email?: string };

  return body.email ?? "unknown";
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
): Promise<GoogleCalendarPatchOutcome> {
  const response = await callCalendarApi(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
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

  if (!response.ok) {
    throw new IntegrationError("GOOGLE_CALENDAR_OAUTH_FAILED", 502);
  }

  return "UPDATED";
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
