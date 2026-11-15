import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const delivery = vi.hoisted(() => ({
  sendOtp: vi.fn(async (_input: { to: string; code: string; purpose?: string }) => {}),
  sendNotice: vi.fn(),
}));
vi.mock("../../../src/modules/verification/email-otp.provider.js", () => ({
  createEmailOtpProvider: () => delivery,
}));

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { createAuthRoute } from "../../../src/modules/auth/auth.route.js";
import { Argon2PasswordHasher } from "../../../src/modules/auth/password-hasher.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { connectIsolatedDatabase, stopIsolatedReplicaSet } from "./mongo-replset-helper.js";

beforeAll(async () => {
  await connectIsolatedDatabase();
}, 120000);
afterAll(async () => {
  await stopIsolatedReplicaSet();
}, 30000);
describe("password recovery HTTP", () => {
  it("runs the request, verification and completion contract using mocked delivery", async () => {
    const hasher = new Argon2PasswordHasher();
    await new UserRepository().create({
      normalizedEmail: "http@example.test",
      role: "CUSTOMER",
      status: "ACTIVE",
      passwordHash: await hasher.hash("old-password"),
    });
    const app = express();
    app.use(express.json());
    app.use("/auth", createAuthRoute());
    app.use(createErrorHandler({ isProduction: true }));
    const start = await request(app)
      .post("/auth/customer/password-recovery/request")
      .send({ email: "http@example.test" });
    expect(start.status).toBe(200);
    expect(delivery.sendOtp).toHaveBeenCalledOnce();
    const challenge = start.body.data.challenge;
    const code = delivery.sendOtp.mock.calls[0]?.[0].code;
    const repeated = await request(app)
      .post("/auth/customer/password-recovery/request")
      .send({ email: "http@example.test", previousChallenge: challenge });
    expect(repeated.status).toBe(200);
    expect(repeated.body.data.challenge).toBe(challenge);
    expect(delivery.sendOtp).toHaveBeenCalledOnce();
    const fresh = await request(app)
      .post("/auth/customer/password-recovery/request")
      .send({ email: "http@example.test" });
    expect(fresh.status).toBe(200);
    expect(fresh.body.data.challenge).toBe("");
    const bad = await request(app)
      .post("/auth/customer/password-recovery/verify")
      .send({ challenge, code: code === "9999" ? "0000" : "9999" });
    expect(bad.status).toBe(400);
    const verified = await request(app)
      .post("/auth/customer/password-recovery/verify")
      .send({ challenge, code });
    expect(verified.status).toBe(200);
    const done = await request(app)
      .post("/auth/customer/password-recovery/complete")
      .send({ resetToken: verified.body.data.resetToken, newPassword: "new-password" });
    expect(done.status).toBe(200);
    const oldLogin = await request(app)
      .post("/auth/customer/login")
      .send({ email: "http@example.test", password: "old-password" });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app)
      .post("/auth/customer/login")
      .send({ email: "http@example.test", password: "new-password" });
    expect(newLogin.status).toBe(200);
    const replay = await request(app)
      .post("/auth/customer/password-recovery/complete")
      .send({ resetToken: verified.body.data.resetToken, newPassword: "new-password" });
    expect(replay.status).toBe(400);
    const absent = await request(app)
      .post("/auth/customer/password-recovery/request")
      .send({ email: "absent@example.test" });
    expect(absent.status).toBe(start.status);
    expect(absent.body.message).toBe(start.body.message);
    expect(Object.keys(absent.body.data)).toEqual(Object.keys(start.body.data));
  });
});
