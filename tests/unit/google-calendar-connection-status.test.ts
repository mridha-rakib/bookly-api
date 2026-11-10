import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BusinessRepository } from "../../src/modules/business/business.repository.js";
import type { GoogleCalendarIntegrationDocument } from "../../src/modules/integration/integration.model.js";
import type { IntegrationRepository } from "../../src/modules/integration/integration.repository.js";

// P2.2.9 — connection lifecycle and Owner-facing status. Google transport and token refresh
// are mocked; parsing/classification helpers and the event body builder are the real code.
const mocks = vi.hoisted(() => ({
  env: {
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    GOOGLE_CALENDAR_REDIRECT_URI: "http://localhost:3000/callback",
    GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: "c".repeat(64),
  },
  delivery: false,
  refresh: vi.fn(),
  create: vi.fn(),
  patch: vi.fn(),
  remove: vi.fn(),
  getEvent: vi.fn(),
}));
vi.mock("../../src/config/env.js", () => ({ env: mocks.env }));
vi.mock("../../src/config/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../../src/modules/booking/ordinary-calendar-journal-authority.js", () => ({
  ordinaryCalendarAuthoritativeModeAvailable: async () => false,
  verifyOrdinaryCalendarDeliveryAuthority: async () => {
    if (!mocks.delivery) throw new Error("ORDINARY_CALENDAR_DELIVERY_UNAVAILABLE");
  },
}));
vi.mock("../../src/modules/integration/integration.google-client.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/modules/integration/integration.google-client.js")
  >()),
  refreshGoogleAccessToken: mocks.refresh,
  createGoogleCalendarEvent: mocks.create,
  patchGoogleCalendarEventSchedule: mocks.patch,
  deleteGoogleCalendarEvent: mocks.remove,
  getGoogleCalendarEvent: mocks.getEvent,
}));

const { IntegrationService } = await import("../../src/modules/integration/integration.service.js");
const { IntegrationError } = await import("../../src/modules/integration/integration.errors.js");
const { IntegrationRepository: RealIntegrationRepository } = await import(
  "../../src/modules/integration/integration.repository.js"
);
const { GoogleCalendarIntegrationModel } = await import(
  "../../src/modules/integration/integration.model.js"
);
const { encryptSecret } = await import("../../src/modules/integration/integration.crypto.js");
const google = await vi.importActual<
  typeof import("../../src/modules/integration/integration.google-client.js")
>("../../src/modules/integration/integration.google-client.js");
const { PackageCalendarProviderError } = await import(
  "../../src/modules/booking/package-calendar-delivery.js"
);

const ownerId = new Types.ObjectId();
const businessId = new Types.ObjectId();
const generation = "22222222-2222-4222-8222-222222222222";

const integration = (overrides: Partial<GoogleCalendarIntegrationDocument> = {}) =>
  ({
    _id: new Types.ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb"),
    businessId,
    googleAccountEmail: "owner@gmail.com",
    googleAccountId: "acct-1",
    calendarId: "primary",
    connectionGeneration: generation,
    encryptedAccessToken: encryptSecret("access-secret"),
    encryptedRefreshToken: encryptSecret("refresh-secret"),
    tokenExpiresAt: new Date(Date.now() - 1_000), // expired → refresh needed
    status: "CONNECTED",
    connectedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  }) as unknown as GoogleCalendarIntegrationDocument;

function setup(
  row: GoogleCalendarIntegrationDocument | null,
  journal?: { summarizeForBusiness: ReturnType<typeof vi.fn> },
) {
  const repo = {
    findByBusinessId: vi.fn(async () => row),
    updateTokens: vi.fn(async () => true),
    markSyncError: vi.fn(async () => undefined),
    markSyncSucceeded: vi.fn(async () => undefined),
    markReconnectRequired: vi.fn(async () => true),
  };
  const businesses = {
    findById: vi.fn(async (id: string) =>
      String(id) === String(businessId) ? { _id: businessId, ownerUserId: ownerId } : null,
    ),
  };
  const service = new IntegrationService(
    repo as unknown as IntegrationRepository,
    businesses as unknown as BusinessRepository,
    (journal ?? { summarizeForBusiness: vi.fn() }) as never,
  );
  return { repo, service };
}

const event = {
  summary: "Bookly — BK-1",
  description: "Booking BK-1 (1 service line(s))",
  startAt: new Date("2026-03-29T01:30:00.000Z"),
  endAt: new Date("2026-03-29T02:30:00.000Z"),
  timezone: "Europe/Nicosia",
};

beforeEach(() => {
  mocks.delivery = false;
  for (const fn of [mocks.refresh, mocks.create, mocks.patch, mocks.remove, mocks.getEvent])
    fn.mockReset();
  mocks.refresh.mockResolvedValue({
    accessToken: "new-access",
    refreshToken: "refresh-secret",
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  mocks.create.mockResolvedValue("evt-1");
});
afterEach(() => vi.restoreAllMocks());

describe("P2.2.9 provider answer classification", () => {
  it("parses Retry-After seconds and HTTP-dates, ignoring junk and past values", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    expect(google.parseRetryAfterMs("120", now)).toBe(120_000);
    expect(google.parseRetryAfterMs("Thu, 01 Jan 2026 00:05:00 GMT", now)).toBe(300_000);
    expect(google.parseRetryAfterMs("soon", now)).toBeUndefined();
    expect(google.parseRetryAfterMs("Wed, 31 Dec 2025 23:00:00 GMT", now)).toBeUndefined();
    expect(google.parseRetryAfterMs(null, now)).toBeUndefined();
    expect(google.parseRetryAfterMs("999999", now)).toBe(24 * 60 * 60_000);
  });

  it("recognizes a revoked/expired grant only from the OAuth error code", () => {
    expect(google.isRevokedGrantError({ response: { data: { error: "invalid_grant" } } })).toBe(
      true,
    );
    expect(
      google.isRevokedGrantError(new Error("invalid_grant: Token has been expired or revoked.")),
    ).toBe(true);
    expect(
      google.isRevokedGrantError({ response: { data: { error: "temporarily_unavailable" } } }),
    ).toBe(false);
    expect(google.isRevokedGrantError(new Error("socket hang up"))).toBe(false);
  });

  it("429 carries Google's Retry-After; 5xx on a write stays an uncertain outcome", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response("{}", { status: 429, headers: { "Retry-After": "90" } }),
    );
    await expect(
      google.insertGoogleCalendarEventWithId("t", "primary", "oabcdef01", event, {
        booklyBookingId: "b",
        booklyBusinessId: "x",
      }),
    ).rejects.toMatchObject({
      kind: "RETRYABLE_FAILURE",
      definitiveNoEffect: true,
      retryAfterMs: 90_000,
    });
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    await expect(
      google.insertGoogleCalendarEventWithId("t", "primary", "oabcdef01", event, {
        booklyBookingId: "b",
        booklyBusinessId: "x",
      }),
    ).rejects.toMatchObject({ kind: "UNKNOWN_OUTCOME", definitiveNoEffect: false });
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await expect(
      google.insertGoogleCalendarEventWithId("t", "primary", "oabcdef01", event, {
        booklyBookingId: "b",
        booklyBusinessId: "x",
      }),
    ).rejects.toMatchObject({ kind: "BLOCKED_AUTHORITY", definitiveNoEffect: true });
  });

  it("the Google request carries the exact UTC instant, the Booking timezone and only scheduling content", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "oabcdef01" }), { status: 200 }));
    await google.insertGoogleCalendarEventWithId("t", "primary", "oabcdef01", event, {
      booklyBookingId: "b1",
      booklyBusinessId: "x1",
    });
    const body = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.body));
    expect(body.start).toEqual({
      dateTime: "2026-03-29T01:30:00.000Z",
      timeZone: "Europe/Nicosia",
    });
    expect(body.end).toEqual({ dateTime: "2026-03-29T02:30:00.000Z", timeZone: "Europe/Nicosia" });
    expect(body.id).toBe("oabcdef01");
    const text = JSON.stringify(body);
    for (const forbidden of ["@", "pm_", "pi_", "secret", "card", "phone"])
      expect(text).not.toContain(forbidden);
  });
});

describe("P2.2.9 revoked access and reconnection", () => {
  it("a revoked grant marks the connection RECONNECT_REQUIRED (fenced on its generation) and makes no Google write", async () => {
    mocks.refresh.mockRejectedValue(
      new IntegrationError("GOOGLE_CALENDAR_RECONNECT_REQUIRED", 409),
    );
    const { repo, service } = setup(integration());
    expect(await service.createEventForBooking(businessId, event)).toBeUndefined();
    expect(repo.markReconnectRequired).toHaveBeenCalledWith(integration()._id, generation);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(repo.markSyncSucceeded).not.toHaveBeenCalled();
  });

  it("while RECONNECT_REQUIRED every best-effort path pauses: no refresh, no Google call, no retry loop", async () => {
    const { repo, service } = setup(integration({ status: "RECONNECT_REQUIRED" }));
    expect(await service.createEventForBooking(businessId, event)).toBeUndefined();
    await service.updateEventScheduleForBooking(businessId, "evt-1", event);
    await service.deleteEventForBooking(businessId, "evt-1");
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(repo.markSyncError).not.toHaveBeenCalled();
  });

  it("the reliable path sees a revoked connection as not connected (blocks, never writes)", async () => {
    mocks.delivery = true;
    const { service } = setup(integration({ status: "RECONNECT_REQUIRED" }));
    const provider = service.ordinaryCalendarProvider();
    expect(await provider.currentDestination(String(businessId))).toBeNull();
    await expect(
      provider.assertCurrent(String(businessId), {
        integrationId: integration()._id,
        generation,
        accountId: "acct-1",
        accountEmail: "owner@gmail.com",
        configuredCalendarId: "primary",
      }),
    ).rejects.toBeInstanceOf(PackageCalendarProviderError);
  });

  it("a transient refresh failure is recorded as a sync failure, not as reconnect-required", async () => {
    mocks.refresh.mockRejectedValue(new IntegrationError("GOOGLE_CALENDAR_OAUTH_FAILED", 502));
    const { repo, service } = setup(integration());
    expect(await service.createEventForBooking(businessId, event)).toBeUndefined();
    expect(repo.markReconnectRequired).not.toHaveBeenCalled();
    expect(repo.markSyncError).toHaveBeenCalledOnce();
  });

  it("a confirmed best-effort write records success for the generation that made it", async () => {
    const { repo, service } = setup(
      integration({ tokenExpiresAt: new Date(Date.now() + 3_600_000) }),
    );
    expect(await service.createEventForBooking(businessId, event)).toBe("evt-1");
    expect(repo.markSyncSucceeded).toHaveBeenCalledWith(businessId, generation);
  });

  it("repository writes are fenced: failures never downgrade RECONNECT_REQUIRED; reconnect clears failure markers", async () => {
    const updates: Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }> = [];
    vi.spyOn(GoogleCalendarIntegrationModel, "updateOne").mockImplementation(((
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ) => {
      updates.push({ filter, update });
      return { exec: async () => ({ matchedCount: 1 }) };
    }) as never);
    const upserts: Array<Record<string, unknown>> = [];
    vi.spyOn(GoogleCalendarIntegrationModel, "findOneAndUpdate").mockImplementation(((
      _f: unknown,
      update: Record<string, unknown>,
    ) => {
      upserts.push(update);
      return { exec: async () => ({}) };
    }) as never);
    const repository = new RealIntegrationRepository();

    await repository.markSyncError(businessId, "boom");
    await repository.markSyncSucceeded(businessId, generation);
    await repository.markReconnectRequired(integration()._id, generation);
    await repository.upsert({
      businessId,
      googleAccountEmail: "owner@gmail.com",
      googleAccountId: "acct-1",
      calendarId: "primary",
      encryptedAccessToken: "a",
      encryptedRefreshToken: "r",
      tokenExpiresAt: new Date(),
    });

    expect(updates[0]?.filter).toMatchObject({ businessId, status: { $ne: "RECONNECT_REQUIRED" } });
    expect(updates[1]?.filter).toMatchObject({
      businessId,
      status: { $ne: "RECONNECT_REQUIRED" },
      connectionGeneration: generation,
    });
    expect(updates[1]?.update).toMatchObject({
      $set: { status: "CONNECTED" },
      $unset: { lastSyncError: "" },
    });
    expect(updates[2]?.filter).toEqual({
      _id: integration()._id,
      connectionGeneration: generation,
    });
    expect(updates[2]?.update).toMatchObject({ $set: { status: "RECONNECT_REQUIRED" } });
    expect(upserts[0]).toMatchObject({
      $set: { status: "CONNECTED", connectionGeneration: expect.any(String) },
      $unset: { lastSyncError: "", lastSyncFailedAt: "" },
    });
  });
});

describe("P2.2.9 Owner integration status", () => {
  const journalRow = (state: string, extra: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    bookingId: new Types.ObjectId(),
    businessId,
    mode: "AUTHORITATIVE",
    state,
    latest: { sequence: 1, desired: { kind: "PRESENT" } },
    eventIdentity: { kind: "ALLOCATED", eventId: "o1" },
    ...extra,
  });

  it("reports reconnection required truthfully, with categories only (no raw provider error, no tokens)", async () => {
    const { service } = setup(
      integration({
        status: "RECONNECT_REQUIRED",
        lastSyncError: "invalid_grant: secret provider detail",
        lastSyncFailedAt: new Date("2026-01-05T10:00:00.000Z"),
        lastSyncSucceededAt: new Date("2026-01-04T09:00:00.000Z"),
      }),
    );
    const status = await service.getStatus(String(ownerId), String(businessId));
    expect(status).toMatchObject({
      connected: true,
      status: "RECONNECT_REQUIRED",
      needsReconnection: true,
      lastSyncProblem: "RECONNECT_REQUIRED",
      lastSyncFailedAt: "2026-01-05T10:00:00.000Z",
      lastSuccessfulSyncAt: "2026-01-04T09:00:00.000Z",
      delivery: { mode: "BEST_EFFORT", available: true },
    });
    const text = JSON.stringify(status);
    for (const leak of [
      "secret",
      "invalid_grant",
      "access-secret",
      "refresh-secret",
      String(integration()._id),
    ])
      expect(text).not.toContain(leak);
  });

  it("a transient ERROR is SYNC_FAILED; a healthy connection reports no problem", async () => {
    const failed = await setup(
      integration({ status: "ERROR", lastSyncFailedAt: new Date(0) }),
    ).service.getStatus(String(ownerId), String(businessId));
    expect(failed).toMatchObject({ needsReconnection: false, lastSyncProblem: "SYNC_FAILED" });
    const healthy = await setup(integration()).service.getStatus(
      String(ownerId),
      String(businessId),
    );
    expect(healthy).not.toHaveProperty("lastSyncProblem");
    expect(healthy).not.toHaveProperty("lastSyncFailedAt");
  });

  it("best-effort mode never reads the journal; reliable mode buckets this Business's rows only", async () => {
    const summarize = vi.fn();
    await setup(integration(), { summarizeForBusiness: summarize }).service.getStatus(
      String(ownerId),
      String(businessId),
    );
    expect(summarize).not.toHaveBeenCalled();

    mocks.delivery = true;
    summarize.mockResolvedValue({
      rows: [
        journalRow("PENDING"),
        journalRow("RETRYABLE_FAILURE", { retryableFailures: 2 }),
        journalRow("BLOCKED_AUTHORITY", { reason: "RETRY_LIMIT_REACHED" }),
        journalRow("PERMANENT_FAILURE", { reason: "PROVIDER_PERMANENT_FAILURE" }),
        journalRow("BLOCKED_AUTHORITY", { reason: "CALENDAR_NOT_CONNECTED_AT_CREATION" }),
        journalRow("UNKNOWN_OUTCOME"),
        journalRow("PENDING", { businessId: new Types.ObjectId() }), // never counted
      ],
      truncated: true,
      lastConfirmedAt: new Date("2026-01-06T00:00:00.000Z"),
    });
    const status = await setup(
      integration({ lastSyncSucceededAt: new Date("2026-01-01T00:00:00.000Z") }),
      {
        summarizeForBusiness: summarize,
      },
    ).service.getStatus(String(ownerId), String(businessId));
    expect(summarize).toHaveBeenCalledWith(String(businessId));
    expect(status.delivery).toEqual({
      mode: "RELIABLE",
      available: true,
      pending: 1,
      retrying: 1,
      recoveryRequired: 3,
      retryLimitReached: 1,
      permanentFailure: 1,
      notConnected: 1,
      truncated: true,
    });
    expect(status.lastSuccessfulSyncAt).toBe("2026-01-06T00:00:00.000Z");
  });

  it("an unreadable journal is reported as unavailable — never as synced", async () => {
    mocks.delivery = true;
    const status = await setup(integration(), {
      summarizeForBusiness: vi.fn().mockRejectedValue(new Error("timeout")),
    }).service.getStatus(String(ownerId), String(businessId));
    expect(status.delivery).toMatchObject({ mode: "RELIABLE", available: false, pending: 0 });
  });

  it("another Business's Owner gets the same 404 and nothing is read", async () => {
    const summarize = vi.fn();
    const { repo, service } = setup(integration(), { summarizeForBusiness: summarize });
    await expect(
      service.getStatus(String(new Types.ObjectId()), String(businessId)),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.getStatus(String(ownerId), String(new Types.ObjectId())),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(repo.findByBusinessId).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
  });
});
