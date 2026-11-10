import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "../../src/config/env.js";
import { TwoFactorChallengeModel } from "../../src/modules/two-factor/two-factor.model.js";
import { assertTwoFactorEnrollmentReady } from "../../src/modules/two-factor/two-factor.readiness.js";

vi.mock("../../src/config/env.js", async (original) => ({
  env: { ...(await original<{ env: object }>()).env },
}));

const command = vi.fn();
const list = vi.fn();
const connection = TwoFactorChallengeModel.db;
let descriptor: PropertyDescriptor | undefined;
const expectedError = {
  statusCode: 503,
  details: [expect.objectContaining({ code: "TWO_FACTOR_ENROLLMENT_UNAVAILABLE" })],
};
const goodIndexes = () => [
  { key: { _id: 1 }, name: "_id_" },
  { key: { tokenHash: 1 }, unique: true, name: "tokenHash_1" },
  { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: "expiresAt_1" },
];

beforeEach(async () => {
  Object.assign(env, {
    TWO_FACTOR_ENROLLMENT_ENABLED: true,
    TOTP_ENCRYPTION_KEY_V1: (await import("node:crypto")).randomBytes(32).toString("hex"),
    NODE_ENV: "production",
    AUTH_COOKIE_SECURE: true,
    FRONTEND_BASE_URL: "https://bookly.example",
  });
  command.mockReset().mockResolvedValue({
    setName: "atlas-fixture",
    logicalSessionTimeoutMinutes: 30,
    maxWireVersion: 25,
  });
  list.mockReset().mockResolvedValue(goodIndexes());
  descriptor = Object.getOwnPropertyDescriptor(connection, "db");
  Object.defineProperty(connection, "db", {
    configurable: true,
    writable: true,
    value: { command },
  });
  vi.spyOn(TwoFactorChallengeModel.collection, "listIndexes").mockReturnValue({
    toArray: list,
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (descriptor) Object.defineProperty(connection, "db", descriptor);
  else Reflect.deleteProperty(connection, "db");
});

describe("Free-compatible 2FA enrollment readiness", () => {
  it("defaults off in the actual configuration when no rollout opt-in is supplied", async () => {
    vi.stubEnv("TWO_FACTOR_ENROLLMENT_ENABLED", undefined);
    vi.resetModules();
    const actual = await vi.importActual<{ env: typeof env }>("../../src/config/env.js");
    expect(actual.env.TWO_FACTOR_ENROLLMENT_ENABLED).toBe(false);
    vi.unstubAllEnvs();
  });
  it("off rollout denies enrollment without querying metadata or changing authentication state", async () => {
    Object.assign(env, { TWO_FACTOR_ENROLLMENT_ENABLED: false });
    await expect(assertTwoFactorEnrollmentReady()).rejects.toMatchObject(expectedError);
    expect(command).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
  it("a replica set with ordinary unique and TTL indexes passes using read-only metadata", async () => {
    await expect(assertTwoFactorEnrollmentReady()).resolves.toBeUndefined();
    expect(command).toHaveBeenCalledWith({ hello: 1, maxTimeMS: 3_000 }, { timeoutMS: 3_000 });
    expect(TwoFactorChallengeModel.collection.listIndexes).toHaveBeenCalledWith({
      maxTimeMS: 3_000,
    });
  });
  it("missing encryption key fails closed before database inspection", async () => {
    Object.assign(env, { TOTP_ENCRYPTION_KEY_V1: undefined });
    await expect(assertTwoFactorEnrollmentReady()).rejects.toMatchObject(expectedError);
    expect(command).not.toHaveBeenCalled();
  });
  it.each([{ AUTH_COOKIE_SECURE: false }, { FRONTEND_BASE_URL: "http://bookly.example" }])(
    "insecure production settings are rejected: %j",
    async (settings) => {
      Object.assign(env, settings);
      await expect(assertTwoFactorEnrollmentReady()).rejects.toMatchObject(expectedError);
      expect(command).not.toHaveBeenCalled();
    },
  );
  it("development remains compatible with existing local HTTP configuration", async () => {
    Object.assign(env, {
      NODE_ENV: "development",
      AUTH_COOKIE_SECURE: false,
      FRONTEND_BASE_URL: "http://localhost:3000",
    });
    await expect(assertTwoFactorEnrollmentReady()).resolves.toBeUndefined();
  });
  it.each([
    { logicalSessionTimeoutMinutes: 30, maxWireVersion: 25 },
    { setName: "rs", maxWireVersion: 25 },
    { setName: "rs", logicalSessionTimeoutMinutes: 0, maxWireVersion: 25 },
    { setName: "rs", logicalSessionTimeoutMinutes: 30, maxWireVersion: 6 },
  ])("unsupported topology fails closed: %j", async (topology) => {
    command.mockResolvedValue(topology);
    await expect(assertTwoFactorEnrollmentReady()).rejects.toMatchObject(expectedError);
    expect(list).not.toHaveBeenCalled();
  });
  it("an already available transaction-capable mongos is accepted without changing hosting", async () => {
    command.mockResolvedValue({
      msg: "isdbgrid",
      logicalSessionTimeoutMinutes: 30,
      maxWireVersion: 25,
    });
    await expect(assertTwoFactorEnrollmentReady()).resolves.toBeUndefined();
  });
  it.each([
    [{ key: { tokenHash: 1 } }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
    [
      { key: { tokenHash: 1 }, unique: true },
      { key: { expiresAt: 1 }, expireAfterSeconds: 300 },
    ],
    [
      { key: { tokenHash: 1 }, unique: true, sparse: true },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ],
    [
      { key: { tokenHash: 1 }, unique: true },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0, partialFilterExpression: { active: true } },
    ],
    [
      { key: { tokenHash: 1, userId: 1 }, unique: true },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ],
    [],
  ])("missing or weaker index contracts block enrollment: %j", async (...indexes) => {
    list.mockResolvedValue(indexes);
    await expect(assertTwoFactorEnrollmentReady()).rejects.toMatchObject(expectedError);
  });
  it("metadata failures are generic and do not leak topology or driver internals", async () => {
    command.mockRejectedValue(new Error("private-host-and-topology"));
    await expect(assertTwoFactorEnrollmentReady()).rejects.toMatchObject(expectedError);
    try {
      await assertTwoFactorEnrollmentReady();
    } catch (error) {
      expect(String(error)).not.toContain("private-host");
    }
  });
  it("an unavailable challenge collection blocks setup without automatic provisioning", async () => {
    list.mockRejectedValue(new Error("NamespaceNotFound"));
    await expect(assertTwoFactorEnrollmentReady()).rejects.toMatchObject(expectedError);
  });
  it("model declares only ordinary MongoDB indexes with the required constraints", () => {
    expect(TwoFactorChallengeModel.schema.indexes()).toEqual(
      expect.arrayContaining([
        [expect.objectContaining({ tokenHash: 1 }), expect.objectContaining({ unique: true })],
        [
          expect.objectContaining({ expiresAt: 1 }),
          expect.objectContaining({ expireAfterSeconds: 0 }),
        ],
      ]),
    );
  });

  it("readiness never creates indexes, synchronizes schemas or writes challenge records", async () => {
    const create = vi.spyOn(TwoFactorChallengeModel.collection, "createIndex");
    const synchronize = vi.spyOn(TwoFactorChallengeModel, "syncIndexes");
    const writes = vi.spyOn(TwoFactorChallengeModel, "updateMany");
    await assertTwoFactorEnrollmentReady();
    expect(create).not.toHaveBeenCalled();
    expect(synchronize).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });
});
