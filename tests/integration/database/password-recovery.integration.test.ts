import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../../src/config/env.js";
import { Argon2PasswordHasher } from "../../../src/modules/auth/password-hasher.js";
import { PasswordRecoveryModel } from "../../../src/modules/auth/password-recovery.model.js";
import { PasswordRecoveryService } from "../../../src/modules/auth/password-recovery.service.js";
import { SessionModel } from "../../../src/modules/session/session.model.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { UserModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const hasher = new Argon2PasswordHasher();
const sendOtp = vi.fn(async (_input: { to: string; code: string; purpose?: string }) => {});
const service = new PasswordRecoveryService(
  { sendOtp, sendNotice: vi.fn() },
  hasher,
  new SessionRepository(),
);
const users = new UserRepository();
const oldPassword = "old-password";
const code = () => {
  const call = sendOtp.mock.calls.at(-1);
  if (!call) throw new Error("Expected mocked delivery");
  return call[0].code;
};
const createUser = async (email: string, role: "CUSTOMER" | "BUSINESS_OWNER") =>
  users.create({
    normalizedEmail: email,
    role,
    status: "ACTIVE",
    passwordHash: await hasher.hash(oldPassword),
  });

beforeAll(async () => {
  await connectIsolatedDatabase();
}, 120000);
afterAll(async () => {
  await stopIsolatedReplicaSet();
}, 30000);
beforeEach(async () => {
  await clearIsolatedDatabase();
  sendOtp.mockClear();
});

describe("password recovery isolated replica set", () => {
  for (const [portal, role] of [
    ["CUSTOMER", "CUSTOMER"],
    ["PROFESSIONAL", "BUSINESS_OWNER"],
  ] as const) {
    it(`${portal}: updates password once and revokes existing sessions`, async () => {
      const user = await createUser(`${portal.toLowerCase()}@example.test`, role);
      await SessionModel.create({
        userId: user._id,
        refreshTokenHash: `hash-${portal}`,
        tokenFamilyId: `family-${portal}`,
        expiresAt: new Date(Date.now() + 3600000),
      });
      const { challenge } = await service.request(portal, user.normalizedEmail);
      expect(sendOtp).toHaveBeenCalledOnce();
      const { resetToken } = await service.verify(portal, challenge, code());
      await expect(service.verify(portal, challenge, code())).rejects.toThrow();
      await service.complete(portal, resetToken, "new-password");
      await expect(service.complete(portal, resetToken, "other-password")).rejects.toThrow();
      const updated = await UserModel.findById(user._id).select("+passwordHash");
      expect(await hasher.verify(updated?.passwordHash, oldPassword)).toBe(false);
      expect(await hasher.verify(updated?.passwordHash, "new-password")).toBe(true);
      expect(await new SessionRepository().hasLiveFamily(`family-${portal}`, user._id)).toBe(false);
    });
  }
  it("creates the documented challenge indexes in the isolated fixture", async () => {
    const indexes = await PasswordRecoveryModel.collection.indexes();
    const challenge = indexes.find((index) => index.name === "challengeHash_1");
    const reset = indexes.find((index) => index.name === "resetHash_1");
    const ttl = indexes.find((index) => index.name === "expiresAt_1");
    expect(challenge).toMatchObject({ key: { challengeHash: 1 }, unique: true });
    expect(reset).toMatchObject({
      key: { resetHash: 1 },
      unique: true,
      partialFilterExpression: { resetHash: { $type: "string" } },
    });
    expect(ttl).toMatchObject({ key: { expiresAt: 1 }, expireAfterSeconds: 3600 });
  });
  it("gives a generic initiation shape for absent, wrong portal, and OAuth-only accounts", async () => {
    await createUser("person@example.test", "CUSTOMER");
    await users.create({
      normalizedEmail: "oauth@example.test",
      role: "CUSTOMER",
      status: "ACTIVE",
      authProviders: ["GOOGLE"],
    });
    for (const [portal, email] of [
      ["CUSTOMER", "missing@example.test"],
      ["PROFESSIONAL", "person@example.test"],
      ["CUSTOMER", "oauth@example.test"],
    ] as const) {
      const result = await service.request(portal, email);
      expect(Object.keys(result)).toEqual(["challenge"]);
      await expect(service.verify(portal, result.challenge, "1234")).rejects.toThrow();
    }
    expect(sendOtp).not.toHaveBeenCalled();
  });
  it("rejects wrong and expired codes and enforces attempts and cooldown", async () => {
    await createUser("limited@example.test", "CUSTOMER");
    const { challenge } = await service.request("CUSTOMER", "limited@example.test");
    const actual = code(),
      wrong = actual === "9999" ? "0000" : "9999";
    for (let i = 0; i < env.OTP_MAX_VERIFICATION_ATTEMPTS; i++)
      await expect(service.verify("CUSTOMER", challenge, wrong)).rejects.toThrow();
    await expect(service.verify("CUSTOMER", challenge, actual)).rejects.toThrow();
    await service.resend("CUSTOMER", challenge);
    expect(sendOtp).toHaveBeenCalledTimes(1);
    await PasswordRecoveryModel.updateOne(
      {},
      { $set: { sends: [new Date(Date.now() - (env.OTP_RESEND_COOLDOWN_SECONDS + 2) * 1000)] } },
    );
    await service.resend("CUSTOMER", challenge);
    expect(sendOtp).toHaveBeenCalledTimes(2);
    await PasswordRecoveryModel.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(service.verify("CUSTOMER", challenge, code())).rejects.toThrow();
  });
  it("rejects a stale password login session after recovery", async () => {
    const user = await createUser("race@example.test", "CUSTOMER");
    const oldStamp = user.security.passwordUpdatedAt;
    const { challenge } = await service.request("CUSTOMER", user.normalizedEmail);
    const { resetToken } = await service.verify("CUSTOMER", challenge, code());
    await service.complete("CUSTOMER", resetToken, "new-password");
    await expect(
      new SessionRepository().create({
        userId: user._id,
        credentialStamp: oldStamp,
        refreshTokenHash: "stale-hash",
        tokenFamilyId: "stale-family",
        expiresAt: new Date(Date.now() + 3600000),
      }),
    ).rejects.toThrow();
    expect(await new SessionRepository().hasLiveFamily("stale-family", user._id)).toBe(false);
  });
  it("preserves only the current valid challenge during a repeated request", async () => {
    const user = await createUser("repeat@example.test", "CUSTOMER");
    const first = await service.request("CUSTOMER", user.normalizedEmail);
    const actual = code();
    const repeated = await service.request("CUSTOMER", user.normalizedEmail, first.challenge);
    expect(repeated.challenge).toBe(first.challenge);
    expect(sendOtp).toHaveBeenCalledTimes(1);
    expect((await service.request("CUSTOMER", user.normalizedEmail)).challenge).toBe("");
    expect(
      (await service.request("CUSTOMER", user.normalizedEmail, "x".repeat(64))).challenge,
    ).toBe("");
    const verified = await service.verify("CUSTOMER", repeated.challenge, actual);
    expect(
      (await service.request("CUSTOMER", user.normalizedEmail, first.challenge)).challenge,
    ).toBe("");
    await service.complete("CUSTOMER", verified.resetToken, "new-password");
  });
  it("limits resends per account in the rolling hour", async () => {
    await createUser("resend@example.test", "CUSTOMER");
    const { challenge } = await service.request("CUSTOMER", "resend@example.test");
    const times = Array.from(
      { length: env.OTP_MAX_RESENDS_PER_HOUR },
      (_, index) => new Date(Date.now() - (env.OTP_RESEND_COOLDOWN_SECONDS + 5 + index) * 1000),
    );
    await PasswordRecoveryModel.updateOne({}, { $set: { sends: times } });
    await service.resend("CUSTOMER", challenge);
    expect(sendOtp).toHaveBeenCalledTimes(1);
  });
  it("rejects cross-portal and expired authorization without changing either account", async () => {
    const alice = await createUser("alice@example.test", "CUSTOMER");
    const bob = await createUser("bob@example.test", "CUSTOMER");
    const { challenge } = await service.request("CUSTOMER", alice.normalizedEmail);
    await expect(service.verify("PROFESSIONAL", challenge, code())).rejects.toThrow();
    const { resetToken } = await service.verify("CUSTOMER", challenge, code());
    await expect(service.complete("PROFESSIONAL", resetToken, "new-password")).rejects.toThrow();
    await PasswordRecoveryModel.updateOne(
      {},
      { $set: { resetExpiresAt: new Date(Date.now() - 1) } },
    );
    await expect(service.complete("CUSTOMER", resetToken, "new-password")).rejects.toThrow();
    const other = await UserModel.findById(bob._id).select("+passwordHash");
    expect(await hasher.verify(other?.passwordHash, oldPassword)).toBe(true);
  });
});
