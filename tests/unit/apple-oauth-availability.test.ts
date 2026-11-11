import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  env: {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    APPLE_OAUTH_ENABLED: false,
    APPLE_CLIENT_ID: "fixture-client",
    APPLE_TEAM_ID: "fixture-team",
    APPLE_KEY_ID: "fixture-key",
    APPLE_PRIVATE_KEY: "fixture-private",
    APPLE_CUSTOMER_OAUTH_REDIRECT_URI: "https://api.example.test/customer",
    APPLE_PROFESSIONAL_OAUTH_REDIRECT_URI: "https://api.example.test/professional",
    APPLE_ACCOUNT_LINK_REDIRECT_URI: "https://api.example.test/link",
  },
}));
vi.mock("../../src/config/env.js", async (original) => {
  const overrides = { ...fixture.env };
  Object.assign(fixture.env, (await original<{ env: object }>()).env, overrides);
  return fixture;
});

import { ExpressApplication } from "../../src/app/app.js";
import { getAppleClientSecret } from "../../src/common/oauth/apple-client-secret.js";
import { createAuthProviderRoute } from "../../src/modules/auth/auth-provider.route.js";
import type { CustomerAppleAuthController } from "../../src/modules/customer-apple-auth/customer-apple-auth.controller.js";
import { createCustomerAppleAuthRoute } from "../../src/modules/customer-apple-auth/customer-apple-auth.route.js";
import type { LinkedAccountController } from "../../src/modules/linked-account/linked-account.controller.js";
import { createLinkedAccountRoute } from "../../src/modules/linked-account/linked-account.route.js";
import type { ProfessionalAppleAuthController } from "../../src/modules/professional-apple-auth/professional-apple-auth.controller.js";
import { createProfessionalAppleAuthRoute } from "../../src/modules/professional-apple-auth/professional-apple-auth.route.js";

afterEach(() => {
  fixture.env.APPLE_OAUTH_ENABLED = false;
});
describe("Apple pending state HTTP boundaries", () => {
  it("mounts non-secret provider capabilities through the complete API without connecting a database", async () => {
    const api = new ExpressApplication({ getConnectionState: () => "disconnected" });
    const response = await request(api.app).get("/api/v1/auth/providers").expect(200);
    expect(response.body.data.apple).toEqual({
      customer: false,
      professional: false,
      linking: false,
    });
    await request(api.app).get("/api/v1/auth/customer/oauth/apple/start").expect(503);
  });

  const make = () => {
    const app = express();
    const handler = vi.fn((_req: express.Request, res: express.Response) => {
      res.sendStatus(200);
    });
    const next: express.RequestHandler = (_req, _res, next) => next();
    const controller = { start: handler, callback: handler };
    app.use(
      createCustomerAppleAuthRoute({
        controller: controller as unknown as CustomerAppleAuthController,
        startLimiter: next,
        callbackLimiter: next,
      }),
    );
    app.use(
      createProfessionalAppleAuthRoute({
        controller: controller as unknown as ProfessionalAppleAuthController,
        startLimiter: next,
        callbackLimiter: next,
      }),
    );
    app.use(
      createLinkedAccountRoute({
        authenticate: handler,
        controller: {
          getAppleAuthorizeUrl: handler,
          handleAppleCallback: handler,
        } as unknown as LinkedAccountController,
        authorizeUrlLimiter: next,
        unlinkLimiter: next,
      }),
    );
    return { app, handler };
  };
  it.each([
    ["get", "/customer/oauth/apple/start"],
    ["post", "/customer/oauth/apple/callback"],
    ["get", "/professional/oauth/apple/start"],
    ["post", "/professional/oauth/apple/callback"],
    ["get", "/me/linked-accounts/apple/authorize-url"],
    ["post", "/oauth/apple/callback"],
  ] as const)("rejects %s %s before auth/session/provider work", async (method, path) => {
    const { app, handler } = make();
    const response = await request(app)[method](path).expect(503);
    expect(response.body.errors[0].code).toBe("APPLE_OAUTH_UNAVAILABLE");
    expect(handler).not.toHaveBeenCalled();
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
  it("publishes only disabled non-secret capabilities with no-store", async () => {
    const app = express();
    app.use(createAuthProviderRoute());
    const response = await request(app).get("/providers").expect(200);
    expect(response.body.data).toEqual({
      apple: { customer: false, professional: false, linking: false },
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(response.body)).not.toContain("fixture-private");
  });
  it("allows the UI only configured enabled capabilities", async () => {
    fixture.env.APPLE_OAUTH_ENABLED = true;
    const app = express();
    app.use(createAuthProviderRoute());
    expect((await request(app).get("/providers").expect(200)).body.data.apple).toEqual({
      customer: true,
      professional: true,
      linking: true,
    });
  });
  it("refuses client-secret generation while disabled even if credentials are present", async () => {
    await expect(getAppleClientSecret()).rejects.toThrow(
      "Failed to generate the Apple client secret",
    );
  });
});
