import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { signOAuthState } from "../../../src/modules/integration/integration.state.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { createApiRouter } from "../../../src/routes/api-router.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const TIMEZONE = "Europe/Nicosia";

/**
 * HTTP-level test for the Google Calendar OAuth callback routing bug: the callback used to be
 * intercepted by createBusinessReviewRoute()'s blanket `authenticate` gate (registered before it
 * in api-router.ts), returning 401 SESSION_EXPIRED before handleGoogleCalendarCallback ever ran,
 * even though Google's browser redirect can never carry a Bearer access token. Mounts the real
 * createApiRouter() (the actual live mount order) rather than a single module's router, so this
 * test would fail again if a future router got re-registered ahead of the callback.
 */
describe("HTTP-level Google Calendar integration routing", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let tokenService: TokenService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    tokenService = new TokenService(new SessionRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const createBusiness = async () => {
    const owner = await userRepository.create({
      normalizedEmail: `owner-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const business = await businessRepository.create({
      ownerUserId: owner._id,
      name: "Ledra Barbers",
      ownerName: "Owner Name",
      email: owner.normalizedEmail,
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: "AT_BUSINESS_LOCATION",
      timezone: TIMEZONE,
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "A great business",
      category: "Barber",
      subcategories: ["Haircut"],
    });
    return { owner, business };
  };

  const createUser = async (role: "CUSTOMER" | "BUSINESS_OWNER") =>
    userRepository.create({
      normalizedEmail: `user-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role,
      status: "ACTIVE",
    });

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    const dbStateReader = { getConnectionState: () => "connected" as const };
    app.use("/api/v1", createApiRouter(dbStateReader));
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (userId: Types.ObjectId | string, role: "CUSTOMER" | "BUSINESS_OWNER") =>
    `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  const callbackPath = "/api/v1/businesses/integrations/google-calendar/callback";

  it("reaches the callback handler without any Authorization header — no more SESSION_EXPIRED", async () => {
    const app = buildApp();

    const response = await request(app).get(callbackPath).query({ state: "any-non-empty-value" });

    // The handler always redirects (success or error) — it never 401s for a missing Bearer
    // token, because it isn't gated by `authenticate` at all.
    expect(response.status).toBe(302);
    expect(response.headers["location"]).not.toContain("SESSION_EXPIRED");
  });

  it("a validly signed state reaches the callback handler (redirected, not rejected by auth middleware)", async () => {
    const { owner, business } = await createBusiness();
    const app = buildApp();
    const state = await signOAuthState({
      businessId: String(business._id),
      userId: String(owner._id),
    });

    // No `code` param — the controller short-circuits to the error redirect before any Google
    // API call, which is enough to prove the request reached handleGoogleCalendarCallback with
    // its state intact rather than being rejected upstream by access-token auth.
    const response = await request(app).get(callbackPath).query({ state });

    expect(response.status).toBe(302);
    expect(response.headers["location"]).toContain("/business-dashboard");
  });

  it("rejects a request with no state param at the validation layer (400, not 401)", async () => {
    const app = buildApp();

    const response = await request(app).get(callbackPath);

    expect(response.status).toBe(400);
  });

  it("a forged/tampered state does not throw an auth error and does not connect anything", async () => {
    const app = buildApp();

    const response = await request(app)
      .get(callbackPath)
      .query({ state: "forged-state-token", code: "some-code" });

    // The controller catches the state-verification failure itself and redirects to the error
    // page — it must not surface as a 401/500, and it must not be treated as a valid connection.
    expect(response.status).toBe(302);
    expect(response.headers["location"]).toContain("googleCalendar=error");
  });

  it("an expired signed state is rejected", async () => {
    vi.useFakeTimers();
    try {
      const { owner, business } = await createBusiness();
      const state = await signOAuthState({
        businessId: String(business._id),
        userId: String(owner._id),
      });

      vi.advanceTimersByTime(11 * 60 * 1000); // past the 10-minute state TTL

      const app = buildApp();
      const response = await request(app).get(callbackPath).query({ state, code: "some-code" });

      expect(response.status).toBe(302);
      expect(response.headers["location"]).toContain("googleCalendar=error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Connect/Status/Disconnect remain Owner-authenticated: no Bearer token is rejected", async () => {
    const { business } = await createBusiness();
    const app = buildApp();

    const [connect, status, disconnect] = await Promise.all([
      request(app).get(`/api/v1/businesses/${business._id}/integrations/google-calendar/connect`),
      request(app).get(`/api/v1/businesses/${business._id}/integrations/google-calendar/status`),
      request(app).delete(`/api/v1/businesses/${business._id}/integrations/google-calendar`),
    ]);

    expect(connect.status).toBe(401);
    expect(status.status).toBe(401);
    expect(disconnect.status).toBe(401);
  });

  it("Connect/Status/Disconnect reject a CUSTOMER caller (Owner-only surface)", async () => {
    const { business } = await createBusiness();
    const customer = await createUser("CUSTOMER");
    const app = buildApp();
    const auth = await bearerFor(customer._id, "CUSTOMER");

    const [connect, status, disconnect] = await Promise.all([
      request(app)
        .get(`/api/v1/businesses/${business._id}/integrations/google-calendar/connect`)
        .set("Authorization", auth),
      request(app)
        .get(`/api/v1/businesses/${business._id}/integrations/google-calendar/status`)
        .set("Authorization", auth),
      request(app)
        .delete(`/api/v1/businesses/${business._id}/integrations/google-calendar`)
        .set("Authorization", auth),
    ]);

    expect(connect.status).toBe(403);
    expect(status.status).toBe(403);
    expect(disconnect.status).toBe(403);
  });

  it("an authenticated Owner can reach Status (proves the callback fix did not make the router blanket-public)", async () => {
    const { owner, business } = await createBusiness();
    const app = buildApp();

    const response = await request(app)
      .get(`/api/v1/businesses/${business._id}/integrations/google-calendar/status`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"));

    expect(response.status).toBe(200);
    expect(response.body.data.connected).toBe(false);
  });

  it("the public callback route does not leak into other /businesses endpoints — the Owner-only gate still applies", async () => {
    const { business } = await createBusiness();
    const app = buildApp();

    const response = await request(app).get(`/api/v1/businesses/${business._id}`);

    expect(response.status).toBe(401);
  });
});
