import type { Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { Types } from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BusinessDocument } from "../../src/modules/business/business.model.js";
import type { BusinessRepository } from "../../src/modules/business/business.repository.js";
import { IntegrationController } from "../../src/modules/integration/integration.controller.js";
import { decryptSecret } from "../../src/modules/integration/integration.crypto.js";
import {
  buildGoogleAuthUrl,
  exchangeGoogleAuthCode,
} from "../../src/modules/integration/integration.google-client.js";
import type {
  IntegrationRepository,
  UpsertGoogleCalendarIntegrationInput,
} from "../../src/modules/integration/integration.repository.js";
import { IntegrationService } from "../../src/modules/integration/integration.service.js";
import { verifyOAuthState } from "../../src/modules/integration/integration.state.js";

/**
 * Google Calendar: an Owner connects ANY eligible Google account (personal Gmail or Workspace),
 * independent of their Bookly login email, through Google's account chooser — and one Google
 * account serves one Business. Mocked Google only: this is not real OAuth evidence.
 */
const mockEnv = vi.hoisted(() => ({
  GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_CALENDAR_REDIRECT_URI:
    "https://api.test.local/api/v1/integrations/google-calendar/callback",
  GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: "b".repeat(64),
  CORS_ORIGINS: ["http://localhost:3000"],
}));
vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));
vi.mock("../../src/config/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const stubUserinfo = (body: Record<string, unknown>, ok = true) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        ({ ok, status: ok ? 200 : 401, json: async () => body }) as unknown as globalThis.Response,
    ),
  );
const stubTokens = (tokens: Record<string, unknown>) =>
  vi
    .spyOn(OAuth2Client.prototype, "getToken")
    .mockImplementation(async () => ({ tokens, res: null }) as never);
const fullTokens = {
  access_token: "raw-access",
  refresh_token: "raw-refresh",
  expiry_date: Date.now() + 3_600_000,
};

describe("authorization URL (real google-auth-library)", () => {
  it("always shows Google's account chooser and is not tied to the Bookly email or a domain", () => {
    const url = new URL(buildGoogleAuthUrl("signed-state"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const prompt = url.searchParams.get("prompt")?.split(" ") ?? [];
    expect(prompt).toEqual(expect.arrayContaining(["select_account", "consent"]));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("client_id")).toBe(mockEnv.GOOGLE_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(mockEnv.GOOGLE_CALENDAR_REDIRECT_URI);
    expect(url.searchParams.has("login_hint")).toBe(false);
    expect(url.searchParams.has("hd")).toBe(false);
    // The established one-way sync scope set is unchanged.
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual(
      [
        "openid",
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/calendar.calendars.readonly",
      ].sort(),
    );
  });
});

describe("token exchange: the chosen account's identity", () => {
  it("accepts any Google account with a stable id and email (Gmail or Workspace)", async () => {
    stubTokens(fullTokens);
    for (const email of ["someone.else@gmail.com", "bookings@salon-workspace.example"]) {
      stubUserinfo({ sub: `sub-${email}`, email });
      await expect(exchangeGoogleAuthCode("code")).resolves.toMatchObject({
        googleAccountEmail: email,
        googleAccountId: `sub-${email}`,
        refreshToken: "raw-refresh",
      });
    }
  });

  it("refuses a response without account id, email or refresh token (never stores a placeholder)", async () => {
    stubTokens(fullTokens);
    stubUserinfo({ sub: "sub-1" });
    await expect(exchangeGoogleAuthCode("code")).rejects.toMatchObject({ statusCode: 502 });
    stubUserinfo({ email: "a@gmail.com" });
    await expect(exchangeGoogleAuthCode("code")).rejects.toMatchObject({ statusCode: 502 });
    stubUserinfo({ sub: "sub-1", email: "a@gmail.com" }, false);
    await expect(exchangeGoogleAuthCode("code")).rejects.toMatchObject({ statusCode: 502 });
    stubTokens({ access_token: "a", expiry_date: Date.now() + 1000 });
    stubUserinfo({ sub: "sub-1", email: "a@gmail.com" });
    await expect(exchangeGoogleAuthCode("code")).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe("callback: one Google account per Business", () => {
  const owner = new Types.ObjectId();
  const business = { _id: new Types.ObjectId(), ownerUserId: owner } as BusinessDocument;
  const businessRepository = {
    findById: vi.fn(async () => business),
  } as unknown as BusinessRepository;
  const setup = (otherBusinessConnection: unknown) => {
    const integrationRepository = {
      upsert: vi.fn(async (_input: UpsertGoogleCalendarIntegrationInput) => ({})),
      findByGoogleAccountForOtherBusiness: vi.fn(async () => otherBusinessConnection),
    };
    const service = new IntegrationService(
      integrationRepository as unknown as IntegrationRepository,
      businessRepository,
    );
    return { service, integrationRepository };
  };
  const stateFor = async (service: IntegrationService) =>
    new URL(await service.getConnectAuthUrl(String(owner), String(business._id))).searchParams.get(
      "state",
    ) as string;

  it("the state is bound to this Business and Owner (not to any Google email)", async () => {
    const { service } = setup(null);
    await expect(verifyOAuthState(await stateFor(service))).resolves.toMatchObject({
      businessId: String(business._id),
      userId: String(owner),
    });
  });

  it("connects an account that differs from the Bookly login email and stores tokens encrypted", async () => {
    const { service, integrationRepository } = setup(null);
    stubTokens(fullTokens);
    stubUserinfo({ sub: "sub-personal", email: "not-the-bookly-email@gmail.com" });
    await service.handleOAuthCallback("code", await stateFor(service));
    expect(integrationRepository.findByGoogleAccountForOtherBusiness).toHaveBeenCalledWith(
      "sub-personal",
      String(business._id),
    );
    const saved = integrationRepository.upsert.mock.calls[0]![0];
    expect(saved).toMatchObject({
      googleAccountEmail: "not-the-bookly-email@gmail.com",
      googleAccountId: "sub-personal",
      calendarId: "primary",
    });
    expect(saved.encryptedRefreshToken).not.toContain("raw-refresh");
    expect(decryptSecret(saved.encryptedRefreshToken)).toBe("raw-refresh");
  });

  it("refuses an account already connected to ANOTHER Business, before any write", async () => {
    const { service, integrationRepository } = setup({ businessId: new Types.ObjectId() });
    stubTokens(fullTokens);
    stubUserinfo({ sub: "sub-shared", email: "shared@gmail.com" });
    await expect(
      service.handleOAuthCallback("code", await stateFor(service)),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: [{ code: "GOOGLE_CALENDAR_ACCOUNT_IN_USE" }],
    });
    expect(integrationRepository.upsert).not.toHaveBeenCalled();
  });

  it("switching this Business to a different account replaces its one connection", async () => {
    const { service, integrationRepository } = setup(null);
    stubTokens(fullTokens);
    stubUserinfo({ sub: "sub-a", email: "a@gmail.com" });
    await service.handleOAuthCallback("code", await stateFor(service));
    stubUserinfo({ sub: "sub-b", email: "b@workspace.example" });
    await service.handleOAuthCallback("code", await stateFor(service));
    const calls = integrationRepository.upsert.mock.calls.map((call) => call[0]);
    expect(calls.map((c) => [String(c.businessId), c.googleAccountId])).toEqual([
      [String(business._id), "sub-a"],
      [String(business._id), "sub-b"],
    ]);
  });
});

describe("callback redirect reasons", () => {
  const run = async (query: Record<string, string>, failure?: unknown) => {
    const controller = new IntegrationController({
      handleOAuthCallback: failure
        ? vi.fn().mockRejectedValue(failure)
        : vi.fn().mockResolvedValue(undefined),
    } as unknown as IntegrationService);
    const redirect = vi.fn();
    await controller.handleGoogleCalendarCallback(
      { validated: { query } } as unknown as Request,
      { redirect } as unknown as Response,
    );
    return new URL(redirect.mock.calls[0]?.[0] as string).searchParams;
  };

  it("reports a cancelled account choice and an account already in use; other failures stay generic", async () => {
    const cancelled = await run({ error: "access_denied", state: "s" });
    expect([cancelled.get("googleCalendar"), cancelled.get("reason")]).toEqual([
      "error",
      "cancelled",
    ]);

    const { IntegrationError } = await import(
      "../../src/modules/integration/integration.errors.js"
    );
    const inUse = await run(
      { code: "c", state: "s" },
      new IntegrationError("GOOGLE_CALENDAR_ACCOUNT_IN_USE", 409),
    );
    expect([inUse.get("googleCalendar"), inUse.get("reason")]).toEqual(["error", "account_in_use"]);

    const generic = await run({ code: "c", state: "s" }, new Error("provider said: secret detail"));
    expect(generic.get("googleCalendar")).toBe("error");
    expect(generic.has("reason")).toBe(false);
    expect(generic.toString()).not.toContain("secret");
  });
});
