import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BusinessDocument } from "../../src/modules/business/business.model.js";
import type { BusinessRepository } from "../../src/modules/business/business.repository.js";
import type { GoogleCalendarIntegrationDocument } from "../../src/modules/integration/integration.model.js";
import type { IntegrationRepository } from "../../src/modules/integration/integration.repository.js";

const mockEnv = {
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_CALENDAR_REDIRECT_URI:
    "http://localhost:3000/api/v1/businesses/integrations/google-calendar/callback",
  GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: "b".repeat(64),
};

vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));
vi.mock("../../src/config/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const buildGoogleAuthUrl = vi.fn(() => "https://accounts.google.com/o/oauth2/v2/auth?mock=1");
const exchangeGoogleAuthCode = vi.fn();
const refreshGoogleAccessToken = vi.fn();
const createGoogleCalendarEvent = vi.fn();
const deleteGoogleCalendarEvent = vi.fn();

vi.mock("../../src/modules/integration/integration.google-client.js", () => ({
  buildGoogleAuthUrl,
  exchangeGoogleAuthCode,
  refreshGoogleAccessToken,
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
}));

const { IntegrationService } = await import("../../src/modules/integration/integration.service.js");
const { verifyOAuthState } = await import("../../src/modules/integration/integration.state.js");
const { decryptSecret } = await import("../../src/modules/integration/integration.crypto.js");

const buildBusiness = (overrides: Partial<BusinessDocument> = {}): BusinessDocument =>
  ({
    _id: new Types.ObjectId(),
    ownerUserId: new Types.ObjectId(),
    ...overrides,
  }) as BusinessDocument;

const buildIntegration = (
  overrides: Partial<GoogleCalendarIntegrationDocument> = {},
): GoogleCalendarIntegrationDocument =>
  ({
    _id: new Types.ObjectId(),
    businessId: new Types.ObjectId(),
    googleAccountEmail: "owner@gmail.com",
    calendarId: "primary",
    encryptedAccessToken: "",
    encryptedRefreshToken: "",
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    status: "CONNECTED",
    connectedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as GoogleCalendarIntegrationDocument;

describe("IntegrationService (Google Calendar)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getConnectAuthUrl", () => {
    it("rejects a user who does not own the business (cross-business access denied)", async () => {
      const business = buildBusiness();
      const businessRepository = {
        findById: vi.fn().mockResolvedValue(business),
      } as unknown as BusinessRepository;
      const integrationRepository = {} as IntegrationRepository;
      const service = new IntegrationService(integrationRepository, businessRepository);

      await expect(
        service.getConnectAuthUrl(String(new Types.ObjectId()), String(business._id)),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("signs a state bound to the authenticated owner + business, and returns Google's auth URL", async () => {
      const business = buildBusiness();
      const businessRepository = {
        findById: vi.fn().mockResolvedValue(business),
      } as unknown as BusinessRepository;
      const integrationRepository = {} as IntegrationRepository;
      const service = new IntegrationService(integrationRepository, businessRepository);

      const url = await service.getConnectAuthUrl(
        String(business.ownerUserId),
        String(business._id),
      );

      expect(url).toBe("https://accounts.google.com/o/oauth2/v2/auth?mock=1");
      expect(buildGoogleAuthUrl).toHaveBeenCalledTimes(1);
      const state = buildGoogleAuthUrl.mock.calls[0]?.[0] as string;
      const payload = await verifyOAuthState(state);
      expect(payload).toEqual({
        businessId: String(business._id),
        userId: String(business.ownerUserId),
      });
    });
  });

  describe("handleOAuthCallback", () => {
    it("rejects a forged/tampered state (invalid signature)", async () => {
      const businessRepository = { findById: vi.fn() } as unknown as BusinessRepository;
      const integrationRepository = { upsert: vi.fn() } as unknown as IntegrationRepository;
      const service = new IntegrationService(integrationRepository, businessRepository);

      await expect(
        service.handleOAuthCallback("auth-code", "not-a-real-signed-state-token"),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(integrationRepository.upsert).not.toHaveBeenCalled();
    });

    it("re-verifies ownership at redemption time — rejects if the business is no longer owned by the state's userId", async () => {
      const business = buildBusiness();
      const businessRepository = {
        findById: vi
          .fn()
          // First call: during getConnectAuthUrl, ownership genuinely holds.
          .mockResolvedValueOnce(business)
          // Second call: at callback redemption time, the business is now owned by someone else
          // (e.g. re-linked/transferred in between) — the state alone must not be trusted.
          .mockResolvedValueOnce(buildBusiness({ _id: business._id })),
      } as unknown as BusinessRepository;
      const integrationRepository = { upsert: vi.fn() } as unknown as IntegrationRepository;
      const service = new IntegrationService(integrationRepository, businessRepository);

      await service.getConnectAuthUrl(String(business.ownerUserId), String(business._id));
      const stateParam = buildGoogleAuthUrl.mock.calls[0]?.[0] as string;

      await expect(service.handleOAuthCallback("auth-code", stateParam)).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(integrationRepository.upsert).not.toHaveBeenCalled();
    });

    it("exchanges the code and stores encrypted tokens on success", async () => {
      const business = buildBusiness();
      const businessRepository = {
        findById: vi.fn().mockResolvedValue(business),
      } as unknown as BusinessRepository;
      const integrationRepository = {
        upsert: vi.fn().mockResolvedValue(buildIntegration()),
      } as unknown as IntegrationRepository;
      const service = new IntegrationService(integrationRepository, businessRepository);

      await service.getConnectAuthUrl(String(business.ownerUserId), String(business._id));
      const stateParam = buildGoogleAuthUrl.mock.calls[0]?.[0] as string;

      exchangeGoogleAuthCode.mockResolvedValue({
        accessToken: "raw-access-token",
        refreshToken: "raw-refresh-token",
        expiresAt: new Date(Date.now() + 3600_000),
        googleAccountEmail: "owner@gmail.com",
      });

      await service.handleOAuthCallback("auth-code", stateParam);

      expect(integrationRepository.upsert).toHaveBeenCalledTimes(1);
      const upsertArg = (integrationRepository.upsert as ReturnType<typeof vi.fn>).mock
        .calls[0]![0];
      // Tokens must never be stored in plaintext — only the encrypted form reaches the repository.
      expect(upsertArg.encryptedAccessToken).not.toContain("raw-access-token");
      expect(decryptSecret(upsertArg.encryptedAccessToken)).toBe("raw-access-token");
      expect(decryptSecret(upsertArg.encryptedRefreshToken)).toBe("raw-refresh-token");
    });
  });

  describe("getStatus / disconnect", () => {
    it("reports not connected when no integration row exists", async () => {
      const business = buildBusiness();
      const businessRepository = {
        findById: vi.fn().mockResolvedValue(business),
      } as unknown as BusinessRepository;
      const integrationRepository = {
        findByBusinessId: vi.fn().mockResolvedValue(null),
      } as unknown as IntegrationRepository;
      const service = new IntegrationService(integrationRepository, businessRepository);

      const status = await service.getStatus(String(business.ownerUserId), String(business._id));

      expect(status).toEqual({ connected: false });
    });

    it("never exposes tokens in the status DTO", async () => {
      const business = buildBusiness();
      const integration = buildIntegration({
        businessId: business._id,
        encryptedAccessToken: "should-never-leak",
        encryptedRefreshToken: "should-never-leak-either",
      });
      const businessRepository = {
        findById: vi.fn().mockResolvedValue(business),
      } as unknown as BusinessRepository;
      const integrationRepository = {
        findByBusinessId: vi.fn().mockResolvedValue(integration),
      } as unknown as IntegrationRepository;
      const service = new IntegrationService(integrationRepository, businessRepository);

      const status = await service.getStatus(String(business.ownerUserId), String(business._id));

      expect(JSON.stringify(status)).not.toContain("should-never-leak");
      expect(status).toEqual({
        connected: true,
        googleAccountEmail: integration.googleAccountEmail,
        status: "CONNECTED",
        connectedAt: integration.connectedAt.toISOString(),
      });
    });

    it("disconnect deletes the stored connection, scoped to the owned business", async () => {
      const business = buildBusiness();
      const businessRepository = {
        findById: vi.fn().mockResolvedValue(business),
      } as unknown as BusinessRepository;
      const integrationRepository = {
        deleteByBusinessId: vi.fn().mockResolvedValue(true),
      } as unknown as IntegrationRepository;
      const service = new IntegrationService(integrationRepository, businessRepository);

      await service.disconnect(String(business.ownerUserId), String(business._id));

      expect(integrationRepository.deleteByBusinessId).toHaveBeenCalledWith(String(business._id));
    });
  });

  describe("createEventForBooking / deleteEventForBooking (booking sync)", () => {
    it("no-ops (returns undefined) when the business has no Google Calendar connection", async () => {
      const businessRepository = {} as BusinessRepository;
      const integrationRepository = {
        findByBusinessId: vi.fn().mockResolvedValue(null),
      } as unknown as IntegrationRepository;
      const service = new IntegrationService(integrationRepository, businessRepository);

      const eventId = await service.createEventForBooking(new Types.ObjectId(), {
        summary: "Bookly — BK-TEST",
        startAt: new Date(),
        endAt: new Date(),
        timezone: "Europe/Nicosia",
      });

      expect(eventId).toBeUndefined();
      expect(createGoogleCalendarEvent).not.toHaveBeenCalled();
    });

    it("swallows a Google API failure and records it, never throwing (booking must not be corrupted)", async () => {
      const integration = buildIntegration({
        encryptedAccessToken: (
          await import("../../src/modules/integration/integration.crypto.js")
        ).encryptSecret("valid-access-token"),
        encryptedRefreshToken: (
          await import("../../src/modules/integration/integration.crypto.js")
        ).encryptSecret("valid-refresh-token"),
      });
      const businessRepository = {} as BusinessRepository;
      const integrationRepository = {
        findByBusinessId: vi.fn().mockResolvedValue(integration),
        markSyncError: vi.fn(),
      } as unknown as IntegrationRepository;
      createGoogleCalendarEvent.mockRejectedValue(new Error("Google API is down"));
      const service = new IntegrationService(integrationRepository, businessRepository);

      const eventId = await service.createEventForBooking(integration.businessId, {
        summary: "Bookly — BK-TEST",
        startAt: new Date(),
        endAt: new Date(),
        timezone: "Europe/Nicosia",
      });

      expect(eventId).toBeUndefined();
      expect(integrationRepository.markSyncError).toHaveBeenCalledTimes(1);
    });

    it("deleteEventForBooking is idempotent-friendly and never throws on failure", async () => {
      const integration = buildIntegration();
      const businessRepository = {} as BusinessRepository;
      const integrationRepository = {
        findByBusinessId: vi.fn().mockResolvedValue(integration),
        markSyncError: vi.fn(),
      } as unknown as IntegrationRepository;
      deleteGoogleCalendarEvent.mockRejectedValue(new Error("network error"));
      const service = new IntegrationService(integrationRepository, businessRepository);

      await expect(
        service.deleteEventForBooking(integration.businessId, "some-event-id"),
      ).resolves.toBeUndefined();
      expect(integrationRepository.markSyncError).toHaveBeenCalledTimes(1);
    });

    it("refreshes an expiring access token before syncing, and persists the new tokens", async () => {
      const crypto = await import("../../src/modules/integration/integration.crypto.js");
      const integration = buildIntegration({
        tokenExpiresAt: new Date(Date.now() - 1000), // already expired
        encryptedAccessToken: crypto.encryptSecret("stale-access-token"),
        encryptedRefreshToken: crypto.encryptSecret("refresh-token"),
      });
      const businessRepository = {} as BusinessRepository;
      const integrationRepository = {
        findByBusinessId: vi.fn().mockResolvedValue(integration),
        updateTokens: vi.fn(),
      } as unknown as IntegrationRepository;
      refreshGoogleAccessToken.mockResolvedValue({
        accessToken: "fresh-access-token",
        refreshToken: "refresh-token",
        expiresAt: new Date(Date.now() + 3600_000),
      });
      createGoogleCalendarEvent.mockResolvedValue("google-event-123");
      const service = new IntegrationService(integrationRepository, businessRepository);

      const eventId = await service.createEventForBooking(integration.businessId, {
        summary: "Bookly — BK-TEST",
        startAt: new Date(),
        endAt: new Date(),
        timezone: "Europe/Nicosia",
      });

      expect(eventId).toBe("google-event-123");
      expect(refreshGoogleAccessToken).toHaveBeenCalledWith("refresh-token");
      expect(integrationRepository.updateTokens).toHaveBeenCalledTimes(1);
      expect(createGoogleCalendarEvent).toHaveBeenCalledWith(
        "fresh-access-token",
        integration.calendarId,
        expect.any(Object),
      );
    });
  });
});
