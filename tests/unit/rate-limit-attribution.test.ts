import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import express, { type Express, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RateLimitRejectionEvent,
  RateLimitRejectionReporter,
} from "../../src/common/middleware/rate-limit-attribution.js";

// Each test loads a fresh module graph so env-driven limits (parsed at import) can be small and
// every limiter starts with an empty in-memory store. No database is touched: requests stop at
// validation, not-found, or the anonymous no-cookie refresh 401, before any repository call.
const loadModules = async (overrides: Record<string, string> = {}) => {
  vi.resetModules();
  // mongoose lives outside the reset module graph; drop compiled models so the fresh app graph
  // can register them again (no connection is opened by these tests).
  const { default: mongoose } = await import("mongoose");
  for (const name of mongoose.modelNames()) mongoose.deleteModel(name);
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
  const attribution = await import("../../src/common/middleware/rate-limit-attribution.js");
  const { logger } = await import("../../src/config/logger.js");
  const events: RateLimitRejectionEvent[] = [];
  const warn = vi.spyOn(logger, "warn").mockImplementation(((payload: RateLimitRejectionEvent) => {
    if (payload?.event === "rate_limit_rejected") events.push(payload);
  }) as never);
  return { attribution, logger, events, warn };
};

const withErrorHandler = async (app: Express) => {
  const { createErrorHandler } = await import("../../src/common/middleware/error-handler.js");
  const { notFoundMiddleware } = await import("../../src/common/middleware/not-found.js");
  app.use(notFoundMiddleware);
  app.use(createErrorHandler());
  return app;
};

const send = (
  app: Express,
  times: number,
  call: (agent: ReturnType<typeof request>) => request.Test,
) =>
  Array.from({ length: times }).reduce<Promise<request.Response[]>>(
    async (acc) => [...(await acc), await call(request(app))],
    Promise.resolve([]),
  );

const SENSITIVE = [
  "6ad45b2fccba66821733708f",
  "person@example.com",
  "SECRET",
  "Bearer",
  "refresh_token",
  "203.0.113.9",
  "::1",
  "127.0.0.1",
  "?",
  "custom-client-request-id",
];

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("rate-limit attribution — real Bookly limiters", () => {
  it("global limiter rejection logs exactly one global-api event with a sanitized endpoint", async () => {
    const { events } = await loadModules({ RATE_LIMIT_MAX: "2" });
    const { ExpressApplication } = await import("../../src/app/app.js");
    const app = new ExpressApplication({ getConnectionState: () => "connected" } as never).app;
    const responses = await send(app, 3, (agent) =>
      agent
        .get("/api/v1/no-such-route/6ad45b2fccba66821733708f/person@example.com?token=SECRET")
        .set("Authorization", "Bearer SECRET")
        .set("Cookie", "refresh_token=SECRET")
        .set("X-Forwarded-For", "203.0.113.9")
        .set("X-Request-Id", "custom-client-request-id"),
    );
    expect(responses.map((r) => r.status)).toEqual([404, 404, 429]);
    expect(responses[2]?.body).toEqual({ success: false, message: "Too many requests" });
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      event: "rate_limit_rejected",
      limiter: "global-api",
      method: "GET",
      endpoint: "/api/v1/no-such-route/:param/:param",
      requestId: "unresolved", // client-supplied, not UUID-shaped
      limit: 2,
      windowMs: 900000,
      used: 3,
      environment: "test",
    });
    expect(typeof event?.retryAfterSeconds).toBe("number");
    const serialized = JSON.stringify(events);
    for (const value of SENSITIVE) expect(serialized).not.toContain(value);
  });

  it("discovery limiter rejection logs discovery with the route template", async () => {
    const { events } = await loadModules({ RATE_LIMIT_MAX: "2" });
    const { createDiscoveryRoute } = await import("../../src/modules/discovery/discovery.route.js");
    const app = express();
    app.use("/api/v1/discovery", createDiscoveryRoute());
    await withErrorHandler(app);
    const responses = await send(app, 3, (agent) =>
      agent.get("/api/v1/discovery/businesses?visitType=NOPE&q=SECRET"),
    );
    expect(responses.map((r) => r.status)).toEqual([400, 400, 429]);
    expect(responses[2]?.body).toEqual({ success: false, message: "Too many requests" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      limiter: "discovery",
      endpoint: "/api/v1/discovery/businesses",
      limit: 2,
      windowMs: 60000,
    });
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("content limiter rejection logs content", async () => {
    const { events } = await loadModules({ RATE_LIMIT_MAX: "2" });
    const { createPublicContentRoute } = await import("../../src/modules/content/content.route.js");
    const app = express();
    app.use("/api/v1/content", createPublicContentRoute());
    await withErrorHandler(app);
    const responses = await send(app, 3, (agent) => agent.get("/api/v1/content/faqs"));
    expect(responses.map((r) => r.status)).toEqual([400, 400, 429]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      limiter: "content",
      endpoint: "/api/v1/content/faqs",
      windowMs: 60000,
    });
  });

  describe("auth limiters", () => {
    const authApp = async (overrides: Record<string, string>) => {
      const loaded = await loadModules(overrides);
      const { createAuthRoute } = await import("../../src/modules/auth/auth.route.js");
      const app = express();
      app.use(express.json());
      app.use("/api/v1/auth", createAuthRoute());
      await withErrorHandler(app);
      return { ...loaded, app };
    };

    it("auth-refresh: anonymous refresh 401s count; the rejection logs auth-refresh", async () => {
      const { app, events } = await authApp({ AUTH_REFRESH_RATE_LIMIT_MAX: "2" });
      const responses = await send(app, 3, (agent) =>
        agent.post("/api/v1/auth/refresh").set("Cookie", "refresh_token=SECRET"),
      );
      expect(responses.map((r) => r.status)).toEqual([401, 401, 429]);
      expect(responses[2]?.body).toEqual({
        success: false,
        message: "Too many authentication requests",
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        limiter: "auth-refresh",
        method: "POST",
        endpoint: "/api/v1/auth/refresh",
        limit: 2,
        windowMs: 900000,
      });
      expect(JSON.stringify(events)).not.toContain("SECRET");
    });

    it.each([
      ["auth-entry", "AUTH_ENTRY_RATE_LIMIT_MAX", "/api/v1/auth/customer/entry", 900000],
      ["auth-login", "AUTH_LOGIN_RATE_LIMIT_MAX", "/api/v1/auth/customer/login", 900000],
      [
        "auth-otp-send",
        "AUTH_OTP_SEND_RATE_LIMIT_MAX",
        "/api/v1/auth/customer/register/send-email-otp",
        3600000,
      ],
      [
        "auth-otp-verify",
        "AUTH_OTP_VERIFY_RATE_LIMIT_MAX",
        "/api/v1/auth/customer/register/verify-email-otp",
        900000,
      ],
    ])("%s rejection logs its own identifier", async (name, variable, endpoint, windowMs) => {
      const { app, events } = await authApp({ [variable]: "1" });
      // Invalid on purpose (numeric email) so every route stops at validation before any service call.
      const responses = await send(app, 2, (agent) =>
        agent.post(endpoint).send({ password: "SECRET", email: 12345, otp: "person@example.com" }),
      );
      expect(responses.map((r) => r.status)).toEqual([400, 429]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ limiter: name, method: "POST", endpoint, windowMs });
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("SECRET");
      expect(serialized).not.toContain("person@example.com");
    });
  });

  it("allowed requests produce no rejection events and no warn calls", async () => {
    const { events, warn } = await loadModules({ RATE_LIMIT_MAX: "5" });
    const { ExpressApplication } = await import("../../src/app/app.js");
    const app = new ExpressApplication({ getConnectionState: () => "connected" } as never).app;
    const responses = await send(app, 5, (agent) => agent.get("/api/v1/no-such-route"));
    expect(responses.every((r) => r.status === 404)).toBe(true);
    expect(events).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a request rejected by the full app's global limiter is never also attributed to a route limiter", async () => {
    const { events } = await loadModules({ RATE_LIMIT_MAX: "2" });
    const { ExpressApplication } = await import("../../src/app/app.js");
    const app = new ExpressApplication({ getConnectionState: () => "connected" } as never).app;
    const responses = await send(app, 3, (agent) => agent.get("/api/v1/content/faqs"));
    expect(responses.map((r) => r.status)).toEqual([400, 400, 429]);
    expect(events.map((e) => e.limiter)).toEqual(["global-api"]);
  });
});

describe("rate-limit attribution — wrapper semantics against an unwrapped twin", () => {
  const limiterOptions = {
    windowMs: 60_000,
    limit: 2,
    standardHeaders: "draft-8" as const,
    legacyHeaders: false,
    message: { success: false, message: "Too many requests" },
  };
  const appWith = (handler: RequestHandler) => {
    const app = express();
    app.get("/x/:id", handler, (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  };

  it("status, body, RateLimit/Retry-After headers and counting are identical to the unwrapped limiter", async () => {
    const { attribution, events } = await loadModules();
    const reporter = vi.fn<RateLimitRejectionReporter>();
    const plain = appWith(rateLimit(limiterOptions));
    const wrapped = appWith(
      attribution.attributeRateLimitRejections(
        rateLimit(limiterOptions),
        { name: "twin", limit: 2, windowMs: 60_000 },
        reporter,
      ),
    );
    const plainResponses = await send(plain, 4, (agent) => agent.get("/x/1"));
    const wrappedResponses = await send(wrapped, 4, (agent) => agent.get("/x/1"));
    expect(wrappedResponses.map((r) => r.status)).toEqual(plainResponses.map((r) => r.status));
    expect(wrappedResponses.map((r) => r.status)).toEqual([200, 200, 429, 429]);
    for (const [index, plainResponse] of plainResponses.entries()) {
      const wrappedResponse = wrappedResponses[index];
      expect(wrappedResponse?.body).toEqual(plainResponse.body);
      expect(wrappedResponse?.headers["ratelimit-policy"]).toEqual(
        plainResponse.headers["ratelimit-policy"],
      );
      // `t` (seconds to reset) may differ by one second between the two runs; `r` must be equal.
      const remaining = (h: string | undefined) => /r=(\d+)/.exec(h ?? "")?.[1];
      expect(remaining(wrappedResponse?.headers["ratelimit"])).toEqual(
        remaining(plainResponse.headers["ratelimit"]),
      );
      expect(Boolean(wrappedResponse?.headers["retry-after"])).toBe(
        Boolean(plainResponse.headers["retry-after"]),
      );
      if (plainResponse.headers["retry-after"]) {
        expect(
          Math.abs(
            Number(wrappedResponse?.headers["retry-after"]) -
              Number(plainResponse.headers["retry-after"]),
          ),
        ).toBeLessThanOrEqual(1);
      }
    }
    // One event per rejected request (two rejections), each from the real rejection boundary.
    expect(reporter).toHaveBeenCalledTimes(2);
    expect(reporter.mock.calls.map(([event]) => event.used)).toEqual([3, 4]);
    expect(events).toHaveLength(0); // custom reporter used, default reporter untouched
  });

  it("when two limiters apply, only the rejecting one is attributed", async () => {
    const { attribution } = await loadModules();
    const reporter = vi.fn<RateLimitRejectionReporter>();
    const outer = attribution.attributeRateLimitRejections(
      rateLimit({ ...limiterOptions, limit: 3 }),
      { name: "outer", limit: 3, windowMs: 60_000 },
      reporter,
    );
    const inner = attribution.attributeRateLimitRejections(
      rateLimit({ ...limiterOptions, limit: 1 }),
      { name: "inner", limit: 1, windowMs: 60_000 },
      reporter,
    );
    const app = express();
    app.get("/x", outer, inner, (_req, res) => {
      res.json({ ok: true });
    });
    const statuses = (await send(app, 4, (agent) => agent.get("/x"))).map((r) => r.status);
    expect(statuses).toEqual([200, 429, 429, 429]);
    expect(reporter.mock.calls.map(([event]) => event.limiter)).toEqual([
      "inner",
      "inner",
      "outer",
    ]);
  });

  it("a non-limiter 429 from a later handler is not attributed to a limiter", async () => {
    const { attribution } = await loadModules();
    const reporter = vi.fn<RateLimitRejectionReporter>();
    const app = express();
    app.get(
      "/x",
      attribution.attributeRateLimitRejections(
        rateLimit(limiterOptions),
        { name: "l", limit: 2, windowMs: 60_000 },
        reporter,
      ),
      (_req, res) => {
        res.status(429).json({ cooldown: true });
      },
    );
    expect((await request(app).get("/x")).status).toBe(429);
    expect(reporter).not.toHaveBeenCalled();
  });

  it("a throwing reporter or logger never changes the 429 response", async () => {
    const { attribution, warn } = await loadModules();
    warn.mockImplementation(() => {
      throw new Error("logger down");
    });
    const app = appWith(
      attribution.attributeRateLimitRejections(rateLimit({ ...limiterOptions, limit: 1 }), {
        name: "l",
        limit: 1,
        windowMs: 60_000,
      }),
    );
    const responses = await send(app, 2, (agent) => agent.get("/x/1"));
    expect(responses.map((r) => r.status)).toEqual([200, 429]);
    expect(responses[1]?.body).toEqual(limiterOptions.message);
    expect(responses[1]?.headers["retry-after"]).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("missing request id and route metadata resolve to safe values", async () => {
    const { attribution } = await loadModules();
    const reporter = vi.fn<RateLimitRejectionReporter>();
    const app = express();
    app.use(
      attribution.attributeRateLimitRejections(
        rateLimit({ ...limiterOptions, limit: 0 }),
        { name: "l", limit: 0, windowMs: 60_000 },
        reporter,
      ),
    );
    expect((await request(app).get("/a/B64TOKENxyz/7")).status).toBe(429);
    expect(reporter.mock.calls[0]?.[0]).toMatchObject({
      requestId: "unresolved",
      endpoint: "/a/:param/:param",
    });
    expect(
      attribution.describeRateLimitedEndpoint({
        baseUrl: "",
        path: `/${"a/".repeat(20)}`,
        routePath: undefined,
      }),
    ).toBe("unresolved");
    expect(
      attribution.describeRateLimitedEndpoint({
        baseUrl: "/api/v1/businesses/6ad45b2fccba66821733708f",
        path: "/x",
        routePath: "/staff/:staffId",
      }),
    ).toBe("/api/v1/businesses/:param/staff/:staffId");
  });
});

describe("rate-limit attribution — development JSONL sink", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "rl-attribution-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sample = (): RateLimitRejectionEvent => ({
    event: "rate_limit_rejected",
    timestamp: "2026-10-18T00:00:00.000Z",
    limiter: "global-api",
    method: "GET",
    endpoint: "/api/v1/discovery/categories",
    requestId: "unresolved",
    limit: 100,
    windowMs: 900000,
    used: 101,
    resetTime: "unresolved",
    retryAfterSeconds: 10,
    environment: "development",
  });

  it("appends one JSON line per event and rotates at the size cap (current + one .1 file)", async () => {
    const { attribution } = await loadModules();
    const file = path.join(dir, "nested", "rate-limit-rejections.jsonl");
    await attribution.appendRateLimitDiagnostic(sample(), file, 200);
    const firstLines = (await readFile(file, "utf8")).trim().split("\n");
    expect(firstLines.map((line) => JSON.parse(line).limiter)).toEqual(["global-api"]);
    await attribution.appendRateLimitDiagnostic(sample(), file, 200); // first file is ~300 bytes → rotate
    expect((await stat(`${file}.1`)).size).toBeGreaterThan(0);
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("a failing sink resolves silently", async () => {
    const { attribution } = await loadModules();
    const blocker = path.join(dir, "not-a-directory");
    await writeFile(blocker, "x");
    await expect(
      attribution.appendRateLimitDiagnostic(sample(), path.join(blocker, "f.jsonl")),
    ).resolves.toBeUndefined();
  });
});
