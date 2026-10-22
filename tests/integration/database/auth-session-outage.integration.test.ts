import express from "express";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import {
  createAuthenticateAccessTokenMiddleware,
  createOptionalAuthenticateAccessTokenMiddleware,
} from "../../../src/modules/auth/auth.middleware.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";

/**
 * Phase 1A — a real MongoDB outage during authentication. Uses its own replica set (not the shared
 * helper) because the test stops it. The session check must fail closed without being reported as
 * a revoked credential: required auth → 503 AUTHENTICATION_UNAVAILABLE (never 200, never 401);
 * optional auth → anonymous.
 */
describe("authentication during a database outage", () => {
  let replSet: MongoMemoryReplSet;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
    await mongoose.connect(replSet.getUri(), {
      dbName: "auth_outage",
      bufferCommands: false,
      serverSelectionTimeoutMS: 1_000,
    });
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await replSet.stop();
  });

  it("required auth returns 503 and optional auth degrades to anonymous when the session store is unreachable", async () => {
    const userRepository = new UserRepository();
    const tokenService = new TokenService(new SessionRepository());
    const user = await userRepository.create({
      normalizedEmail: "outage@example.com",
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    const token = await issueTestAccessToken(tokenService, { userId: user._id, role: "CUSTOMER" });

    const app = express();
    app.get(
      "/required",
      createAuthenticateAccessTokenMiddleware(tokenService, userRepository),
      (req, res) => {
        res.json({ userId: req.auth?.userId });
      },
    );
    app.get(
      "/optional",
      createOptionalAuthenticateAccessTokenMiddleware(tokenService, userRepository),
      (req, res) => {
        res.json({ userId: req.auth?.userId ?? null });
      },
    );
    app.use(createErrorHandler({ isProduction: true }));

    expect(
      (await request(app).get("/required").set("Authorization", `Bearer ${token}`)).status,
    ).toBe(200);

    await replSet.stop({ doCleanup: false });

    const required = await request(app).get("/required").set("Authorization", `Bearer ${token}`);
    expect(required.status).toBe(503);
    expect(required.body.errors?.[0]?.code).toBe("AUTHENTICATION_UNAVAILABLE");

    const optional = await request(app).get("/optional").set("Authorization", `Bearer ${token}`);
    expect(optional.status).toBe(200);
    expect(optional.body).toEqual({ userId: null });

    // A token that fails verification is still a plain 401 — no storage is consulted.
    const forged = await request(app).get("/required").set("Authorization", "Bearer not-a-jwt");
    expect(forged.status).toBe(401);
  }, 60_000);
});
