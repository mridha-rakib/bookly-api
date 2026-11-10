// biome-ignore-all lint/suspicious/noExplicitAny: Minimal in-memory Mongo adapter handles heterogeneous model operators.
// biome-ignore-all lint/style/noNonNullAssertion: Fixed seeded collections are asserted by each scenario.
import { randomBytes } from "node:crypto";
import express from "express";
import { type ClientSession, Types } from "mongoose";
import { Secret, TOTP } from "otpauth";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorHandler } from "../../src/common/middleware/error-handler.js";
import { env } from "../../src/config/env.js";
import { logger } from "../../src/config/logger.js";
import { AuthError } from "../../src/modules/auth/auth.errors.js";
import { issueAuthSession } from "../../src/modules/auth/auth-session.js";
import { TokenService } from "../../src/modules/auth/token.service.js";
import { BookingModel } from "../../src/modules/booking/booking.model.js";
import { PaymentAttemptModel } from "../../src/modules/payment/payment-attempt.model.js";
import { ProfessionalAppleAuthController } from "../../src/modules/professional-apple-auth/professional-apple-auth.controller.js";
import { ProfessionalFacebookAuthController } from "../../src/modules/professional-facebook-auth/professional-facebook-auth.controller.js";
import { ProfessionalGoogleAuthController } from "../../src/modules/professional-google-auth/professional-google-auth.controller.js";
import { SessionModel } from "../../src/modules/session/session.model.js";
import { SessionRepository } from "../../src/modules/session/session.repository.js";
import {
  hashCredential,
  openTotp,
  sealTotp,
  verifyTotpStep,
} from "../../src/modules/two-factor/two-factor.crypto.js";
import { TwoFactorRequired } from "../../src/modules/two-factor/two-factor.http.js";
import { TwoFactorChallengeModel } from "../../src/modules/two-factor/two-factor.model.js";
import { assertTwoFactorEnrollmentReady } from "../../src/modules/two-factor/two-factor.readiness.js";
import { createTwoFactorRoute } from "../../src/modules/two-factor/two-factor.route.js";
import { TwoFactorService } from "../../src/modules/two-factor/two-factor.service.js";
import { type UserDocument, UserModel } from "../../src/modules/user/user.model.js";

vi.mock("../../src/config/env.js", async (original) => ({
  env: {
    ...(await original<{ env: object }>()).env,
    TOTP_ENCRYPTION_KEY_V1: (await import("node:crypto")).randomBytes(32).toString("hex"),
  },
}));

// Persistence behavior uses the existing mocked model harness. Readiness metadata and the
// real rollout flag are tested independently in two-factor-readiness.test.ts.
vi.mock("../../src/modules/two-factor/two-factor.readiness.js", () => ({
  assertTwoFactorEnrollmentReady: vi.fn().mockResolvedValue(undefined),
}));

// Minimal in-memory Mongo operators for the production model calls. Transaction callbacks
// serialize and roll back on error; this exercises the service without a database/driver.
type Row = Record<string, any>;
let users: Row[], challenges: Row[], sessions: Row[];
const id = "650000000000000000000001";
const other = "650000000000000000000002";
const family = "fixture-family";
let service: TwoFactorService;
let tokens: TokenService;
let queue: Promise<unknown>;
let failRevocation: boolean;
const get = (row: Row, path: string): any =>
  path.split(".").reduce((value, key) => value?.[key], row);
const eq = (a: any, b: any): boolean =>
  a instanceof Types.ObjectId || b instanceof Types.ObjectId
    ? String(a) === String(b)
    : a instanceof Date || b instanceof Date
      ? +new Date(a) === +new Date(b)
      : a === b;
const match = (row: Row, filter: Row): boolean =>
  Object.entries(filter).every(([path, expected]) => {
    if (path === "$or") return expected.some((part: Row) => match(row, part));
    const value = get(row, path);
    if (
      expected &&
      typeof expected === "object" &&
      !(expected instanceof Date) &&
      !(expected instanceof Types.ObjectId)
    )
      return Object.entries(expected).every(([operator, operand]: [string, any]) => {
        if (operator === "$exists") return (value !== undefined) === operand;
        if (operator === "$ne") return !eq(value, operand);
        if (operator === "$in") return operand.some((candidate: any) => eq(value, candidate));
        if (operator === "$nin") return !operand.some((candidate: any) => eq(value, candidate));
        if (operator === "$gt") return value > operand;
        if (operator === "$lt") return value < operand;
        if (operator === "$lte") return value <= operand;
        return false;
      });
    return Array.isArray(value) ? value.includes(expected) : eq(value, expected);
  });
const set = (row: Row, path: string, value: any) => {
  const parts = path.split(".");
  const last = parts.pop() as string;
  let target = row;
  for (const part of parts) target = target[part] ??= {};
  if (value === undefined) delete target[last];
  else target[last] = value;
};
const update = (row: Row, changes: Row) => {
  for (const [path, value] of Object.entries(changes["$set"] ?? {})) set(row, path, value);
  for (const [path, value] of Object.entries(changes["$inc"] ?? {}))
    set(row, path, (get(row, path) ?? 0) + Number(value));
  for (const path of Object.keys(changes["$unset"] ?? {})) set(row, path, undefined);
  for (const [path, value] of Object.entries(changes["$pull"] ?? {}))
    set(
      row,
      path,
      get(row, path).filter((item: any) => item !== value),
    );
};
const clone = (value: any): any =>
  value instanceof Types.ObjectId
    ? new Types.ObjectId(String(value))
    : value instanceof Date
      ? new Date(value)
      : Array.isArray(value)
        ? value.map(clone)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]))
          : value;
const query = (work: () => any): any => ({
  select() {
    return this;
  },
  session() {
    return this;
  },
  read() {
    return this;
  },
  async exec() {
    return clone(work());
  },
  // biome-ignore lint/suspicious/noThenProperty: Models the intentionally awaitable Mongoose Query.
  then(resolve: any, reject: any) {
    return this.exec().then(resolve, reject);
  },
});
function mockModel(model: any, rows: () => Row[]) {
  vi.spyOn(model, "findById").mockImplementation((value) =>
    query(() => rows().find((row) => eq(row["_id"], value)) ?? null),
  );
  vi.spyOn(model, "findOne").mockImplementation((filter) =>
    query(() => rows().find((row) => match(row, filter as Row)) ?? null),
  );
  vi.spyOn(model, "exists").mockImplementation((filter) =>
    query(() => (rows().find((row) => match(row, filter as Row)) ? { _id: id } : null)),
  );
  vi.spyOn(model, "findOneAndUpdate").mockImplementation((filter, changes) =>
    query(() => {
      const row = rows().find((row) => match(row, filter as Row));
      if (!row) return null;
      update(row, changes as Row);
      return row;
    }),
  );
  vi.spyOn(model, "updateOne").mockImplementation((filter, changes) =>
    query(() => {
      const row = rows().find((row) => match(row, filter as Row));
      if (row) update(row, changes as Row);
      return { modifiedCount: row ? 1 : 0 };
    }),
  );
}
const account = () => users[0] as unknown as UserDocument;
const currentCode = (secret: string) =>
  new TOTP({ secret: Secret.fromBase32(secret), period: 30, digits: 6 }).generate({
    timestamp: Date.now(),
  });
async function activate() {
  const setup = await service.start(id, family);
  const result = await service.activate(id, family, setup.setupId, currentCode(setup.manualKey));
  // A later complete first-factor authentication is represented by a new current family.
  sessions.push({
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(id),
    tokenFamilyId: "fresh",
    authenticatedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return { setup, result };
}
async function challenge(): Promise<string> {
  try {
    await service.requireSecondFactor(account());
  } catch (error) {
    if (!(error instanceof TwoFactorRequired)) throw error;
  }
  // The actual raw secret is available only at the HTTP boundary; capture its generated hash
  // using a deterministic replacement here for service-level verification tests.
  const token = randomBytes(32).toString("hex");
  challenges[challenges.length - 1]!["tokenHash"] = hashCredential(token);
  return token;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-07T09:00:00Z"));
  users = [
    {
      _id: new Types.ObjectId(id),
      normalizedEmail: "owner@example.test",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    },
    {
      _id: new Types.ObjectId(other),
      normalizedEmail: "other@example.test",
      role: "STAFF",
      status: "ACTIVE",
    },
  ];
  challenges = [];
  sessions = [id, other].map((userId) => ({
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(userId),
    tokenFamilyId: userId === id ? family : "other",
    expiresAt: new Date(Date.now() + 86_400_000),
    authenticatedAt: new Date(),
  }));
  queue = Promise.resolve();
  failRevocation = false;
  mockModel(UserModel, () => users);
  mockModel(TwoFactorChallengeModel, () => challenges);
  mockModel(SessionModel, () => sessions);
  vi.spyOn(UserModel.db, "transaction").mockImplementation(((
    work: (session: ClientSession) => Promise<any>,
  ) => {
    const run = queue.then(async () => {
      const snapshot = clone([users, challenges, sessions]);
      try {
        return await work({} as ClientSession);
      } catch (error) {
        [users, challenges, sessions] = snapshot;
        throw error;
      }
    });
    queue = run.catch(() => {});
    return run;
  }) as never);
  vi.spyOn(TwoFactorChallengeModel, "create").mockImplementation((async (input: Row) => {
    const row = { _id: new Types.ObjectId(), ...input };
    challenges.push(row);
    return row;
  }) as never);
  vi.spyOn(SessionModel.prototype, "save").mockImplementation(async function (this: Row) {
    const row = this["toObject"]();
    sessions.push(row);
    return row;
  } as never);
  vi.spyOn(SessionModel, "updateMany").mockImplementation(((filter: Row, changes: Row) =>
    query(() => {
      if (failRevocation) throw new Error("revocation unavailable");
      const matching = sessions.filter((row) => match(row, filter));
      matching.forEach((row) => {
        update(row, changes);
      });
      return { modifiedCount: matching.length };
    })) as never);
  vi.spyOn(TwoFactorChallengeModel, "deleteOne").mockImplementation(((filter: Row) =>
    query(() => {
      challenges = challenges.filter((row) => !match(row, filter));
      return {};
    })) as never);
  vi.spyOn(logger, "info").mockImplementation(() => {});
  service = new TwoFactorService();
  tokens = new TokenService(new SessionRepository());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Professional 2FA enrollment and management", () => {
  it("encrypts a pending secret, returns local QR/manual setup, and activates only after proof", async () => {
    const setup = await service.start(id, family);
    expect(setup.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(account().twoFactorEnabled).not.toBe(true);
    expect(JSON.stringify(account().twoFactor)).not.toContain(setup.manualKey);
    await expect(service.activate(id, family, setup.setupId, "invalid")).rejects.toMatchObject({
      statusCode: 400,
    });
    const result = await service.activate(id, family, setup.setupId, currentCode(setup.manualKey));
    expect(account().twoFactorEnabled).toBe(true);
    expect(result.recoveryCodes).toHaveLength(10);
    expect(result.recoveryCodes.every((code) => /^[a-f0-9]{32}$/.test(code))).toBe(true);
    for (const code of result.recoveryCodes) expect(JSON.stringify(account())).not.toContain(code);
    expect(sessions.find((row) => row["tokenFamilyId"] === family)?.["revocationReason"]).toBe(
      "REVOKE_ALL",
    );
    expect(sessions.find((row) => row["tokenFamilyId"] === "other")?.["revokedAt"]).toBeUndefined();
    expect(await service["status"](id)).toEqual({ enabled: true, recoveryCodesRemaining: 10 });
  });
  it("expires setup and rejects a superseded or another account's setup id", async () => {
    const first = await service.start(id, family);
    const second = await service.start(id, family);
    await expect(
      service.activate(id, family, first.setupId, currentCode(first.manualKey)),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      service.activate(other, "other", second.setupId, currentCode(second.manualKey)),
    ).rejects.toMatchObject({ statusCode: 400 });
    vi.setSystemTime(Date.now() + 300_001);
    await expect(
      service.activate(id, family, second.setupId, currentCode(second.manualKey)),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(account().twoFactorEnabled).not.toBe(true);
  });
  it("requires a recent complete authentication, not a recently rotated legacy session", async () => {
    delete sessions[0]!["authenticatedAt"];
    await expect(service.start(id, family)).rejects.toMatchObject({ statusCode: 403 });
    sessions[0]!["authenticatedAt"] = new Date(Date.now() - 300_001);
    await expect(service.start(id, family)).rejects.toMatchObject({ statusCode: 403 });
  });
  it.each(["CUSTOMER", "SUPER_ADMIN"])("refuses %s management", async (role) => {
    users[0]!["role"] = role;
    await expect(service.start(id, family)).rejects.toMatchObject({ statusCode: 403 });
    expect(account().twoFactor).toBeUndefined();
  });
  it.each(["SUPERVISOR", "STAFF"])("supports account-owned %s enrollment", async (role) => {
    users[0]!["role"] = role;
    const { result } = await activate();
    expect(result.recoveryCodes).toHaveLength(10);
  });
  it("binds AES-GCM ciphertext to its owning User and fails closed without the key", async () => {
    const sealed = sealTotp("fixture-secret", id);
    expect(openTotp(sealed, id)).toBe("fixture-secret");
    expect(() => openTotp(sealed, other)).toThrow();
    const original = env.TOTP_ENCRYPTION_KEY_V1;
    Object.assign(env, { TOTP_ENCRYPTION_KEY_V1: undefined });
    try {
      await expect(service.start(id, family)).rejects.toMatchObject({ statusCode: 503 });
    } finally {
      Object.assign(env, { TOTP_ENCRYPTION_KEY_V1: original });
    }
    expect(account().twoFactorEnabled).not.toBe(true);
  });
  it("rolls back activation and audit state if session revocation fails", async () => {
    const setup = await service.start(id, family);
    failRevocation = true;
    await expect(
      service.activate(id, family, setup.setupId, currentCode(setup.manualKey)),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(account().twoFactorEnabled).not.toBe(true);
    expect(account().twoFactor?.pending).toBeTruthy();
    failRevocation = false;
    await expect(
      service.activate(id, family, setup.setupId, currentCode(setup.manualKey)),
    ).resolves.toMatchObject({ signInRequired: true });
  });
  it("regeneration invalidates old codes and challenges, consumes proof and ends sessions", async () => {
    const { result } = await activate();
    const token = await challenge();
    const replacement = await service.manage(
      id,
      "fresh",
      result.recoveryCodes[0] as string,
      "regenerate",
    );
    expect(replacement.recoveryCodes).toHaveLength(10);
    expect(account().twoFactor?.recoveryHashes).not.toContain(
      hashCredential(`${id}:${result.recoveryCodes[1]}`),
    );
    await expect(
      service.verifyLogin(token, result.recoveryCodes[1] as string, tokens, {}),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(sessions.find((row) => row["tokenFamilyId"] === "fresh")?.["revokedAt"]).toBeTruthy();
  });
  it("disable requires fresh authentication and valid factor; clears secrets and recovery material", async () => {
    const { result } = await activate();
    await expect(service.manage(id, "fresh", "invalid", "disable")).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(account().twoFactorEnabled).toBe(true);
    await service.manage(id, "fresh", result.recoveryCodes[0] as string, "disable");
    expect(account().twoFactorEnabled).toBe(false);
    expect(account().twoFactor?.secret).toBeUndefined();
    expect(account().twoFactor?.recoveryHashes).toBeUndefined();
    expect(account().twoFactor?.pending).toBeUndefined();
  });
  it("does not write booking or financial records, or log generated secrets", async () => {
    const booking = vi.spyOn(BookingModel, "updateMany");
    const payments = vi.spyOn(PaymentAttemptModel, "updateMany");
    const { setup, result } = await activate();
    expect(booking).not.toHaveBeenCalled();
    expect(payments).not.toHaveBeenCalled();
    const logs = JSON.stringify(vi.mocked(logger.info).mock.calls);
    for (const secret of [setup.manualKey, ...result.recoveryCodes])
      expect(logs).not.toContain(secret);
  });
});

describe("Professional pre-authentication challenges", () => {
  it("issues no credentials before proof; consumes a challenge and code once with one new family", async () => {
    const { result } = await activate();
    const create = vi.spyOn(tokens, "createRefreshSession");
    await expect(
      issueAuthSession(
        tokens,
        {
          userId: new Types.ObjectId(id),
          email: "owner@example.test",
          role: "BUSINESS_OWNER",
          status: "ACTIVE",
          twoFactorEnabled: true,
        },
        {},
      ),
    ).rejects.toBeInstanceOf(TwoFactorRequired);
    expect(create).not.toHaveBeenCalled();
    const token = randomBytes(32).toString("hex");
    challenges[challenges.length - 1]!["tokenHash"] = hashCredential(token);
    const responses = await Promise.allSettled([
      service.verifyLogin(token, result.recoveryCodes[0] as string, tokens, {}),
      service.verifyLogin(token, result.recoveryCodes[0] as string, tokens, {}),
    ]);
    expect(responses.filter((response) => response["status"] === "fulfilled")).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(account().twoFactor?.recoveryHashes).toHaveLength(9);
  });
  it("a recovery code cannot be consumed by two different challenges", async () => {
    const { result } = await activate();
    const a = await challenge(),
      b = await challenge();
    const responses = await Promise.allSettled([
      service.verifyLogin(a, result.recoveryCodes[0] as string, tokens, {}),
      service.verifyLogin(b, result.recoveryCodes[0] as string, tokens, {}),
    ]);
    expect(responses.filter((response) => response["status"] === "fulfilled")).toHaveLength(1);
  });
  it("rejects the enrollment TOTP step and accepts the next step only once", async () => {
    const { setup } = await activate();
    const token = await challenge();
    await expect(
      service.verifyLogin(token, currentCode(setup.manualKey), tokens, {}),
    ).rejects.toMatchObject({ statusCode: 400 });
    vi.setSystemTime(Date.now() + 30_000);
    const code = currentCode(setup.manualKey);
    await expect(service.verifyLogin(token, code, tokens, {})).resolves.toHaveProperty(
      "accessToken",
    );
    const next = await challenge();
    await expect(service.verifyLogin(next, code, tokens, {})).rejects.toMatchObject({
      statusCode: 400,
    });
  });
  it("expires or cancels challenges and never accepts a challenge token as an access JWT", async () => {
    const { result } = await activate();
    const token = await challenge();
    await expect(tokens.verifyAccessToken(token)).rejects.toThrow();
    vi.setSystemTime(Date.now() + 300_001);
    await expect(
      service.verifyLogin(token, result.recoveryCodes[0] as string, tokens, {}),
    ).rejects.toMatchObject({ statusCode: 400 });
    const next = await challenge();
    await service.cancel(next);
    await expect(
      service.verifyLogin(next, result.recoveryCodes[0] as string, tokens, {}),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
  it("bounds challenge attempts and account-wide challenge creation with an expiring budget", async () => {
    await activate();
    const token = await challenge();
    for (let i = 0; i < 5; i++)
      await expect(service.verifyLogin(token, "invalid", tokens, {})).rejects.toMatchObject({
        statusCode: 400,
      });
    expect(challenges[0]?.["attempts"]).toBe(5);
    await expect(service.challengeStatus(token)).rejects.toMatchObject({ statusCode: 400 });
    await challenge();
    await challenge();
    await expect(challenge()).rejects.toMatchObject({ statusCode: 429 });
    vi.setSystemTime(Date.now() + 300_001);
    await expect(challenge()).resolves.toBeTruthy();
  });
  it("denies direct session creation or rotation lacking the current second-factor version", async () => {
    await activate();
    await expect(
      tokens.createRefreshSession({ userId: new Types.ObjectId(id) }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      tokens.createRefreshSession({ userId: new Types.ObjectId(id), twoFactorVersion: 0 }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      tokens.createRefreshSession({
        userId: new Types.ObjectId(id),
        twoFactorVersion: account().twoFactorVersion as number,
      }),
    ).resolves.toHaveProperty("refreshToken");
  });
  it.each(["SUSPENDED", "DELETED"])("cannot override %s status", async (status) => {
    const { result } = await activate();
    const token = await challenge();
    users[0]!["status"] = status;
    await expect(
      service.verifyLogin(token, result.recoveryCodes[0] as string, tokens, {}),
    ).rejects.toMatchObject({ statusCode: status === "SUSPENDED" ? 403 : 401 });
    expect(account().twoFactor?.recoveryHashes).toHaveLength(10);
  });
  it("rolls back recovery-code/challenge consumption if session creation fails", async () => {
    const { result } = await activate();
    const token = await challenge();
    const create = vi
      .spyOn(tokens, "createRefreshSession")
      .mockRejectedValueOnce(new Error("storage failed"));
    await expect(
      service.verifyLogin(token, result.recoveryCodes[0] as string, tokens, {}),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(account().twoFactor?.recoveryHashes).toHaveLength(10);
    expect(challenges[0]?.["usedAt"]).toBeUndefined();
    create.mockRestore();
    await expect(
      service.verifyLogin(token, result.recoveryCodes[0] as string, tokens, {}),
    ).resolves.toHaveProperty("accessToken");
  });
  it("matches the RFC TOTP fixture with strict six digits and one-step drift", () => {
    const secret = Secret.fromUTF8("12345678901234567890").base32;
    expect(verifyTotpStep(secret, "287082", 59_000)).toBe(1);
    expect(verifyTotpStep(secret, "287082", 89_000)).toBe(1);
    expect(verifyTotpStep(secret, "287082", 119_000)).toBeNull();
    expect(verifyTotpStep(secret, "1", 59_000)).toBeNull();
  });
});

describe("2FA HTTP boundary", () => {
  function app(role: string = "BUSINESS_OWNER") {
    const app = express();
    app.use(express.json());
    app.post("/first", (_req, _res, next) => next(new TwoFactorRequired("a".repeat(64))));
    app.use(
      "/auth/two-factor",
      createTwoFactorRoute(
        tokens,
        (req, _res, next) => {
          req.auth = { userId: id, role: role as never, status: "ACTIVE", sessionFamilyId: family };
          next();
        },
        (_req, _res, next) => next(),
      ),
    );
    app.use(createErrorHandler());
    return app;
  }
  it("first-factor response contains only a pre-auth HttpOnly cookie and safe 428 code", async () => {
    const response = await request(app()).post("/first");
    expect(response["status"]).toBe(428);
    expect(response.body.errors[0].code).toBe("TWO_FACTOR_REQUIRED");
    expect(JSON.stringify(response.body)).not.toContain("a".repeat(64));
    expect(String(response.headers["set-cookie"])).toContain("bookly_2fa_challenge=");
    expect(String(response.headers["set-cookie"])).toContain("HttpOnly");
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("strictly rejects target-user injection and out-of-scope roles", async () => {
    expect(
      (await request(app()).post("/auth/two-factor/enroll").send({ userId: other }))["status"],
    ).toBe(400);
    expect((await request(app("CUSTOMER")).get("/auth/two-factor/status"))["status"]).toBe(403);
    expect((await request(app("SUPER_ADMIN")).get("/auth/two-factor/status"))["status"]).toBe(403);
  });
  it("requires a challenge cookie and rejects foreign Origin for cookie-only verification", async () => {
    expect(
      (await request(app()).post("/auth/two-factor/verify").send({ code: "123456" }))["status"],
    ).toBe(400);
    expect(
      (
        await request(app())
          .post("/auth/two-factor/verify")
          .set("Origin", "https://foreign.test")
          .set("Cookie", `bookly_2fa_challenge=${"a".repeat(64)}`)
          .send({ code: "123456" })
      )["status"],
    ).toBe(403);
  });
});

it.each([
  ProfessionalGoogleAuthController,
  ProfessionalFacebookAuthController,
  ProfessionalAppleAuthController,
])("OAuth callback %s carries the challenge only in its cookie", async (Controller) => {
  const controller = new Controller({
    completeCallback: vi.fn().mockRejectedValue(new TwoFactorRequired("a".repeat(64))),
  } as never);
  const app = express();
  app.get(
    "/oauth",
    (req, _res, next) => {
      req.validated = {
        query: { code: "first-factor", state: "verified-by-service" },
        body: { code: "first-factor", state: "verified-by-service" },
      };
      next();
    },
    controller.callback,
  );
  const response = await request(app).get("/oauth");
  expect(response.status).toBe(302);
  expect(response.headers["location"]).toMatch(/\/professional\/two-factor$/);
  expect(response.headers["location"]).not.toContain("a".repeat(64));
  expect(String(response.headers["set-cookie"])).toContain("bookly_2fa_challenge=");
  expect(String(response.headers["set-cookie"])).toContain("HttpOnly");
});

it("password/identity changes invalidate outstanding login challenges without consuming recovery codes", async () => {
  const { result } = await activate();
  const token = await challenge();
  users[0]!["security"] = { passwordUpdatedAt: new Date(Date.now() + 1) };
  await expect(
    service.verifyLogin(token, result.recoveryCodes[0] as string, tokens, {}),
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(account().twoFactor?.recoveryHashes).toHaveLength(10);
});

it("expired pending enrollment stays unusable even with a fresh reauthenticated family", async () => {
  const setup = await service.start(id, family);
  vi.setSystemTime(Date.now() + 300_001);
  sessions[0]!["authenticatedAt"] = new Date();
  await expect(
    service.activate(id, family, setup.setupId, currentCode(setup.manualKey)),
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(account().twoFactorEnabled).not.toBe(true);
});

it("an enabled account rotates normally, keeps its complete-authentication time, and detects actual replay", async () => {
  const { result } = await activate();
  const token = await challenge();
  const auth = await service.verifyLogin(token, result.recoveryCodes[0] as string, tokens, {});
  const claims = await tokens.verifyAccessToken(auth.accessToken);
  const original = sessions.find((row) => row["tokenFamilyId"] === claims.sid);
  const authenticatedAt = original?.["authenticatedAt"];
  vi.setSystemTime(Date.now() + 60_000);
  const next = await tokens.rotateRefreshToken(auth.refreshToken);
  expect(next.tokenFamilyId).toBe(claims.sid);
  const successor = sessions.find(
    (row) => row["tokenFamilyId"] === claims.sid && !row["revokedAt"],
  );
  expect(successor?.["authenticatedAt"]).toEqual(authenticatedAt);
  expect(successor?.["twoFactorVersion"]).toBe(account().twoFactorVersion);
  expect(await tokens.isAccessTokenSessionLive(claims)).toBe(true);
  await expect(tokens.rotateRefreshToken(auth.refreshToken)).rejects.toThrow(
    "REFRESH_TOKEN_REUSED",
  );
  expect(await tokens.isAccessTokenSessionLive(claims)).toBe(false);
  expect(sessions.find((row) => row["tokenFamilyId"] === "other")?.["revokedAt"]).toBeUndefined();
});

it("enrollment racing behind a first-factor session insertion revokes that newly inserted family", async () => {
  const setup = await service.start(id, family);
  const [sessionResult, activation] = await Promise.allSettled([
    tokens.createRefreshSession({ userId: new Types.ObjectId(id) }),
    service.activate(id, family, setup.setupId, currentCode(setup.manualKey)),
  ]);
  expect(activation.status).toBe("fulfilled");
  expect(account().twoFactorEnabled).toBe(true);
  expect(
    sessions.filter((row) => String(row["userId"]) === id).every((row) => row["revokedAt"]),
  ).toBe(true);
  if (sessionResult.status === "fulfilled") {
    expect(
      await tokens.isAccessTokenSessionLive({
        sub: id,
        role: "BUSINESS_OWNER",
        sid: sessionResult.value.tokenFamilyId,
      }),
    ).toBe(false);
  }
});

it("security changes expire the previously verified refresh credential without a false theft result", async () => {
  const { result } = await activate();
  const token = await challenge();
  const auth = await service.verifyLogin(token, result.recoveryCodes[0] as string, tokens, {});
  const claims = await tokens.verifyAccessToken(auth.accessToken);
  await service.manage(id, claims.sid, result.recoveryCodes[1] as string, "regenerate");
  await expect(tokens.rotateRefreshToken(auth.refreshToken)).rejects.toThrow("SESSION_EXPIRED");
  expect(await tokens.isAccessTokenSessionLive(claims)).toBe(false);
});

it("the last recovery code can atomically replace the set during a fresh recovery sign-in", async () => {
  const { result } = await activate();
  const lastCode = result.recoveryCodes[0] as string;
  account().twoFactor!.recoveryHashes = [hashCredential(`${id}:${lastCode}`)];
  const token = await challenge();
  const auth = await service.verifyLogin(token, lastCode, tokens, {}, true);
  expect(auth.recoveryCodes).toHaveLength(10);
  expect(account().twoFactor?.recoveryHashes).not.toContain(hashCredential(`${id}:${lastCode}`));
  expect(sessions.find((row) => row["tokenFamilyId"] === "fresh")?.["revokedAt"]).toBeTruthy();
  const claims = await tokens.verifyAccessToken(auth.accessToken);
  expect(await tokens.isAccessTokenSessionLive(claims)).toBe(true);
  expect(account().twoFactorVersion).toBe(2);
  await expect(service.verifyLogin(token, lastCode, tokens, {}, true)).rejects.toMatchObject({
    statusCode: 400,
  });
});

it("recovery sign-in replacement rolls back code consumption and new credentials if revocation fails", async () => {
  const { result } = await activate();
  const token = await challenge();
  failRevocation = true;
  await expect(
    service.verifyLogin(token, result.recoveryCodes[0] as string, tokens, {}, true),
  ).rejects.toMatchObject({ statusCode: 503 });
  expect(account().twoFactorVersion).toBe(1);
  expect(account().twoFactor?.recoveryHashes).toHaveLength(10);
  expect(challenges[0]?.["usedAt"]).toBeUndefined();
});

it("HTTP recovery sign-in returns the replacement set once and keeps the refresh credential HttpOnly", async () => {
  const { result } = await activate();
  const token = await challenge();
  const app = express();
  app.use(express.json());
  app.use(
    "/auth/two-factor",
    createTwoFactorRoute(
      tokens,
      (_req, _res, next) => next(),
      (_req, _res, next) => next(),
    ),
  );
  app.use(createErrorHandler());
  const response = await request(app)
    .post("/auth/two-factor/verify")
    .set("Cookie", `bookly_2fa_challenge=${token}`)
    .send({ code: result.recoveryCodes[0], replaceRecoveryCodes: true });
  expect(response.status).toBe(200);
  expect(response.body.data.recoveryCodes).toHaveLength(10);
  expect(response.body.data.refreshToken).toBeUndefined();
  expect(response.body.data.accessToken).toBeTruthy();
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(String(response.headers["set-cookie"])).toContain("HttpOnly");
});

it("the rollout gate blocks setup and pending activation without changing sessions or active state", async () => {
  const gate = vi.mocked(assertTwoFactorEnrollmentReady);
  gate.mockRejectedValueOnce(new AuthError("TWO_FACTOR_ENROLLMENT_UNAVAILABLE", 503));
  await expect(service.start(id, family)).rejects.toMatchObject({ statusCode: 503 });
  expect(account().twoFactor?.pending).toBeUndefined();
  const setup = await service.start(id, family);
  gate.mockRejectedValueOnce(new AuthError("TWO_FACTOR_ENROLLMENT_UNAVAILABLE", 503));
  await expect(
    service.activate(id, family, setup.setupId, currentCode(setup.manualKey)),
  ).rejects.toMatchObject({ statusCode: 503 });
  expect(account().twoFactorEnabled).not.toBe(true);
  expect(sessions.every((row) => !row["revokedAt"])).toBe(true);
});

it("stopping enrollment never bypasses or disables an existing account's factor and management", async () => {
  const { result } = await activate();
  const gate = vi.mocked(assertTwoFactorEnrollmentReady);
  const before = gate.mock.calls.length;
  gate.mockRejectedValue(new AuthError("TWO_FACTOR_ENROLLMENT_UNAVAILABLE", 503));
  try {
    const token = await challenge();
    const auth = await service.verifyLogin(token, result.recoveryCodes[0] as string, tokens, {});
    expect(auth.accessToken).toBeTruthy();
    const claims = await tokens.verifyAccessToken(auth.accessToken);
    await service.manage(id, claims.sid, result.recoveryCodes[1] as string, "disable");
    expect(account().twoFactorEnabled).toBe(false);
    expect(gate.mock.calls.length).toBe(before);
  } finally {
    gate.mockResolvedValue(undefined);
  }
});

it("P2.2.7.2 — status tells a disabled account whether enrollment is available, from the real gate", async () => {
  const gate = vi.mocked(assertTwoFactorEnrollmentReady);
  expect(await service.status(id)).toEqual({
    enabled: false,
    recoveryCodesRemaining: 0,
    enrollmentAvailable: true,
  });
  gate.mockRejectedValueOnce(new AuthError("TWO_FACTOR_ENROLLMENT_UNAVAILABLE", 503));
  expect(await service.status(id)).toEqual({
    enabled: false,
    recoveryCodesRemaining: 0,
    enrollmentAvailable: false,
  });
});

it("P2.2.7.2 — an enabled account's status never consults the enrollment gate", async () => {
  await activate();
  const gate = vi.mocked(assertTwoFactorEnrollmentReady);
  const before = gate.mock.calls.length;
  gate.mockRejectedValue(new AuthError("TWO_FACTOR_ENROLLMENT_UNAVAILABLE", 503));
  try {
    const status = await service.status(id);
    expect(status).toEqual({ enabled: true, recoveryCodesRemaining: 10 });
    expect(gate.mock.calls.length).toBe(before);
  } finally {
    gate.mockResolvedValue(undefined);
  }
});

it("P2.2.7.4 — a TOTP sign-in after enrollment yields a live, refreshable session untouched by enrollment's revocation", async () => {
  const { setup } = await activate();
  // Enrollment ended every pre-existing family (all-session revocation).
  expect(
    sessions
      .filter((row) => String(row["userId"]) === id && row["tokenFamilyId"] !== "fresh")
      .every((row) => row["revokedAt"]),
  ).toBe(true);
  vi.setSystemTime(Date.now() + 30_000);
  const token = await challenge();
  const auth = await service.verifyLogin(token, currentCode(setup.manualKey), tokens, {});
  expect(auth).toMatchObject({ user: { role: "BUSINESS_OWNER", status: "ACTIVE" } });
  expect(auth.accessToken).toBeTruthy();
  expect(auth.refreshToken).toBeTruthy();
  const claims = await tokens.verifyAccessToken(auth.accessToken);
  // What every authenticated request (including /auth/me and the dashboard) checks.
  expect(await tokens.isAccessTokenSessionLive(claims)).toBe(true);
  const row = sessions.find((session) => session["tokenFamilyId"] === claims.sid);
  expect(row?.["revokedAt"]).toBeUndefined();
  expect(row?.["twoFactorVersion"]).toBe(account().twoFactorVersion);
  // A reload refreshes with the cookie: the family survives rotation.
  vi.setSystemTime(Date.now() + 60_000);
  const rotated = await tokens.rotateRefreshToken(auth.refreshToken);
  expect(rotated.tokenFamilyId).toBe(claims.sid);
  expect(await tokens.isAccessTokenSessionLive(claims)).toBe(true);
  // The consumed challenge can never mint a second session.
  await expect(
    service.verifyLogin(token, currentCode(setup.manualKey), tokens, {}),
  ).rejects.toMatchObject({
    statusCode: 400,
  });
});
