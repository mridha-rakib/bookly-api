import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BusinessRepository } from "../../src/modules/business/business.repository.js";
import type { GoogleCalendarIntegrationDocument } from "../../src/modules/integration/integration.model.js";
import type { IntegrationRepository } from "../../src/modules/integration/integration.repository.js";

// P4B-2B — the real ordinary Calendar provider port with the shared Google helpers mocked.
const mocks = vi.hoisted(() => ({
  env: {
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    GOOGLE_CALENDAR_REDIRECT_URI: "http://localhost:3000/callback",
    GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: "b".repeat(64),
  },
  delivery: true,
  consume: vi.fn(async (..._args: unknown[]) => undefined),
  getGoogleCalendarEvent: vi.fn(),
  insertGoogleCalendarEventWithId: vi.fn(),
  patchGoogleCalendarEventSchedule: vi.fn(),
  deleteGoogleCalendarEventConditionally: vi.fn(),
  refreshGoogleAccessToken: vi.fn(),
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
vi.mock("../../src/modules/booking/ordinary-calendar-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/modules/booking/ordinary-calendar-dispatch.js")
  >()),
  consumeOrdinaryCalendarSendPermission: mocks.consume,
}));
vi.mock("../../src/modules/integration/integration.google-client.js", () => ({
  buildGoogleAuthUrl: vi.fn(),
  exchangeGoogleAuthCode: vi.fn(),
  createGoogleCalendarEvent: vi.fn(),
  deleteGoogleCalendarEvent: vi.fn(),
  resolveGoogleCalendarDestination: vi.fn(),
  refreshGoogleAccessToken: mocks.refreshGoogleAccessToken,
  getGoogleCalendarEvent: mocks.getGoogleCalendarEvent,
  insertGoogleCalendarEventWithId: mocks.insertGoogleCalendarEventWithId,
  patchGoogleCalendarEventSchedule: mocks.patchGoogleCalendarEventSchedule,
  deleteGoogleCalendarEventConditionally: mocks.deleteGoogleCalendarEventConditionally,
}));

const { IntegrationService } = await import("../../src/modules/integration/integration.service.js");
const { encryptSecret } = await import("../../src/modules/integration/integration.crypto.js");
const { PackageCalendarProviderError } = await import(
  "../../src/modules/booking/package-calendar-delivery.js"
);

const generation = "11111111-1111-4111-8111-111111111111";
const businessId = new Types.ObjectId();
const bookingId = new Types.ObjectId();
const integration = (overrides: Partial<GoogleCalendarIntegrationDocument> = {}) =>
  ({
    _id: new Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa"),
    businessId,
    googleAccountEmail: "owner@gmail.com",
    googleAccountId: "acct-1",
    calendarId: "primary",
    connectionGeneration: generation,
    encryptedAccessToken: encryptSecret("scoped-access"),
    encryptedRefreshToken: encryptSecret("refresh"),
    tokenExpiresAt: new Date(Date.now() + 3_600_000),
    status: "CONNECTED",
    connectedAt: new Date(),
    ...overrides,
  }) as unknown as GoogleCalendarIntegrationDocument;

const setup = (
  row: GoogleCalendarIntegrationDocument | null = integration(),
  updateTokens = true,
) => {
  const repository = {
    findByBusinessId: vi.fn(async () => row),
    updateTokens: vi.fn(async () => updateTokens),
    markSyncError: vi.fn(),
  };
  const service = new IntegrationService(
    repository as unknown as IntegrationRepository,
    {} as BusinessRepository,
  );
  const provider = service.ordinaryCalendarProvider();
  const destination = {
    integrationId: new Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa"),
    generation,
    accountId: "acct-1",
    accountEmail: "owner@gmail.com",
    configuredCalendarId: "primary",
  };
  const port = provider.bind({
    journalId: new Types.ObjectId(),
    bookingId: String(bookingId),
    businessId: String(businessId),
    eventId: `o${bookingId.toHexString()}`,
    destination,
  });
  return { provider, port, destination, repository };
};

const event = {
  summary: "Bookly — BK-1",
  description: "Booking BK-1 (1 service line(s))",
  startAt: new Date("2030-08-20T09:00:00Z"),
  endAt: new Date("2030-08-20T09:45:00Z"),
  timezone: "Europe/Nicosia",
};

describe("IntegrationService ordinary Calendar provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.delivery = true;
  });

  it("reports the current destination only for a CONNECTED, generation-bound connection", async () => {
    expect(await setup().provider.currentDestination(String(businessId))).toMatchObject({
      generation,
      accountId: "acct-1",
    });
    for (const row of [
      null,
      integration({ status: "ERROR" }),
      integration({ connectionGeneration: undefined }),
      integration({ googleAccountId: undefined }),
      integration({ businessId: new Types.ObjectId() }),
    ])
      expect(await setup(row).provider.currentDestination(String(businessId))).toBeNull();
  });

  it("blocks a reconnect, another account or another calendar", async () => {
    const { provider, destination } = setup(
      integration({ connectionGeneration: "22222222-2222-4222-8222-222222222222" }),
    );
    await expect(provider.assertCurrent(String(businessId), destination)).rejects.toMatchObject({
      kind: "BLOCKED_AUTHORITY",
    });
    await expect(
      setup(integration({ googleAccountId: "acct-2" })).provider.assertCurrent(
        String(businessId),
        destination,
      ),
    ).rejects.toMatchObject({ kind: "BLOCKED_AUTHORITY" });
    await expect(
      setup(integration({ calendarId: "team@group.calendar.google.com" })).provider.assertCurrent(
        String(businessId),
        destination,
      ),
    ).rejects.toMatchObject({ kind: "BLOCKED_AUTHORITY" });
  });

  it("reads the exact event from the recorded calendar, and reports a changed connection as NOT_CONNECTED", async () => {
    mocks.getGoogleCalendarEvent.mockResolvedValue({ outcome: "NOT_FOUND" });
    expect(await setup().port.read()).toEqual({ outcome: "NOT_FOUND" });
    expect(mocks.getGoogleCalendarEvent).toHaveBeenCalledWith(
      "scoped-access",
      "primary",
      `o${bookingId.toHexString()}`,
    );
    mocks.getGoogleCalendarEvent.mockClear();
    expect(
      await setup(
        integration({ connectionGeneration: "22222222-2222-4222-8222-222222222222" }),
      ).port.read(),
    ).toEqual({ outcome: "NOT_CONNECTED" });
    expect(mocks.getGoogleCalendarEvent).not.toHaveBeenCalled();
  });

  it("consumes the send permission before inserting with the ownership marker", async () => {
    mocks.insertGoogleCalendarEventWithId.mockResolvedValue("CREATED");
    const { port } = setup();
    expect(await port.insert(event, "req-1")).toBe("CREATED");
    expect(mocks.consume).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: `o${bookingId.toHexString()}` }),
      { kind: "INSERT", requestId: "req-1", event },
    );
    expect(mocks.consume.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.insertGoogleCalendarEventWithId.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.insertGoogleCalendarEventWithId).toHaveBeenCalledWith(
      "scoped-access",
      "primary",
      `o${bookingId.toHexString()}`,
      event,
      { booklyBookingId: String(bookingId), booklyBusinessId: String(businessId) },
    );
  });

  it("a refused send permission or a fenced token refresh is a no-effect answer and never calls Google", async () => {
    mocks.consume.mockRejectedValueOnce(
      new PackageCalendarProviderError("BLOCKED_AUTHORITY", true),
    );
    await expect(setup().port.insert(event, "req-1")).rejects.toMatchObject({
      kind: "BLOCKED_AUTHORITY",
      definitiveNoEffect: true,
    });
    mocks.refreshGoogleAccessToken.mockResolvedValue({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: new Date(),
    });
    await expect(
      setup(integration({ tokenExpiresAt: new Date(0) }), false).port.insert(event, "req-2"),
    ).rejects.toMatchObject({ kind: "BLOCKED_AUTHORITY", definitiveNoEffect: true });
    mocks.refreshGoogleAccessToken.mockRejectedValueOnce(new Error("oauth down"));
    await expect(
      setup(integration({ tokenExpiresAt: new Date(0) })).port.insert(event, "req-3"),
    ).rejects.toMatchObject({ kind: "RETRYABLE_FAILURE", definitiveNoEffect: true });
    mocks.delivery = false;
    await expect(setup().port.insert(event, "req-4")).rejects.toMatchObject({
      definitiveNoEffect: true,
    });
    expect(mocks.insertGoogleCalendarEventWithId).not.toHaveBeenCalled();
  });

  it("after the permission is consumed, an unclassified failure is UNKNOWN; classified answers pass through", async () => {
    mocks.insertGoogleCalendarEventWithId.mockRejectedValueOnce(
      new DOMException("timed out", "TimeoutError"),
    );
    await expect(setup().port.insert(event, "req-1")).rejects.toMatchObject({
      kind: "UNKNOWN_OUTCOME",
      definitiveNoEffect: false,
    });
    mocks.insertGoogleCalendarEventWithId.mockRejectedValueOnce(
      new PackageCalendarProviderError("RETRYABLE_FAILURE", true),
    );
    await expect(setup().port.insert(event, "req-2")).rejects.toMatchObject({
      kind: "RETRYABLE_FAILURE",
      definitiveNoEffect: true,
    });
    mocks.insertGoogleCalendarEventWithId.mockResolvedValueOnce("ALREADY_EXISTS");
    expect(await setup().port.insert(event, "req-3")).toBe("ALREADY_EXISTS");
  });

  it("patches and deletes only with the If-Match ETag, mapping a missing event to NOT_FOUND", async () => {
    mocks.patchGoogleCalendarEventSchedule
      .mockResolvedValueOnce("EVENT_NOT_FOUND")
      .mockResolvedValueOnce("PRECONDITION_FAILED");
    const schedule = { startAt: event.startAt, endAt: event.endAt, timezone: event.timezone };
    expect(await setup().port.patchSchedule(schedule, '"e1"', "req-1")).toBe("NOT_FOUND");
    expect(await setup().port.patchSchedule(schedule, '"e1"', "req-2")).toBe("PRECONDITION_FAILED");
    expect(mocks.patchGoogleCalendarEventSchedule).toHaveBeenCalledWith(
      "scoped-access",
      "primary",
      `o${bookingId.toHexString()}`,
      schedule,
      { etag: '"e1"' },
    );
    mocks.deleteGoogleCalendarEventConditionally.mockResolvedValueOnce("DELETED");
    expect(await setup().port.remove('"e2"', "req-3")).toBe("DELETED");
    expect(mocks.deleteGoogleCalendarEventConditionally).toHaveBeenCalledWith(
      "scoped-access",
      "primary",
      `o${bookingId.toHexString()}`,
      '"e2"',
    );
    expect(mocks.consume).toHaveBeenCalledWith(expect.anything(), {
      kind: "DELETE",
      requestId: "req-3",
      etag: '"e2"',
    });
  });
});
