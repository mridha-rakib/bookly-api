import type { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../../src/modules/auth/auth.middleware.js";
import type { TokenService } from "../../src/modules/auth/token.service.js";
import type { UserDocument } from "../../src/modules/user/user.model.js";
import type { UserRepository } from "../../src/modules/user/user.repository.js";

const createRequest = (authorization?: string): Request =>
  ({
    headers: authorization ? { authorization } : {},
  }) as Request;

const createUser = (status: "ACTIVE" | "SUSPENDED" | "DELETED" = "ACTIVE"): UserDocument =>
  ({
    _id: new Types.ObjectId(),
    role: "CUSTOMER",
    status,
  }) as UserDocument;

describe("auth middleware", () => {
  it("returns 401 for missing bearer token", async () => {
    const middleware = createAuthenticateAccessTokenMiddleware(
      { verifyAccessToken: vi.fn() } as unknown as TokenService,
      { findById: vi.fn() } as unknown as UserRepository,
    );
    const next = vi.fn();

    await middleware(createRequest(), {} as Response, next as NextFunction);

    expect(next.mock.calls[0]?.[0]).toMatchObject({ statusCode: 401 });
  });

  it("normalizes invalid JWT verification errors to 401", async () => {
    const middleware = createAuthenticateAccessTokenMiddleware(
      {
        verifyAccessToken: vi.fn().mockRejectedValue(new Error("raw jose error")),
      } as unknown as TokenService,
      { findById: vi.fn() } as unknown as UserRepository,
    );
    const next = vi.fn();

    await middleware(createRequest("Bearer bad.token"), {} as Response, next as NextFunction);

    expect(next.mock.calls[0]?.[0]).toMatchObject({ statusCode: 401 });
  });

  it("returns 401 for valid token that references a missing user", async () => {
    const middleware = createAuthenticateAccessTokenMiddleware(
      {
        verifyAccessToken: vi.fn().mockResolvedValue({ sub: "user-id", role: "CUSTOMER" }),
      } as unknown as TokenService,
      { findById: vi.fn().mockResolvedValue(null) } as unknown as UserRepository,
    );
    const next = vi.fn();

    await middleware(createRequest("Bearer valid"), {} as Response, next as NextFunction);

    expect(next.mock.calls[0]?.[0]).toMatchObject({ statusCode: 401 });
  });

  it("attaches authenticated request state and enforces role/status centrally", async () => {
    const request = createRequest("Bearer valid");
    const middleware = createAuthenticateAccessTokenMiddleware(
      {
        verifyAccessToken: vi.fn().mockResolvedValue({ sub: "user-id", role: "CUSTOMER" }),
      } as unknown as TokenService,
      { findById: vi.fn().mockResolvedValue(createUser()) } as unknown as UserRepository,
    );
    const next = vi.fn();

    await middleware(request, {} as Response, next as NextFunction);
    requireRoles(["BUSINESS_OWNER"])(request, {} as Response, next as NextFunction);

    expect(request.auth?.role).toBe("CUSTOMER");
    expect(next.mock.calls[1]?.[0]).toMatchObject({ statusCode: 403 });
  });

  it("rejects suspended users in active-user middleware", () => {
    const request = {
      auth: { userId: "u1", role: "CUSTOMER", status: "SUSPENDED" },
    } as Request;
    const next = vi.fn();

    requireActiveUser()(request, {} as Response, next as NextFunction);

    expect(next.mock.calls[0]?.[0]).toMatchObject({
      statusCode: 403,
      details: [{ code: "USER_SUSPENDED" }],
    });
  });

  it("rejects closed (DELETED) accounts in active-user middleware with a 401", () => {
    const request = {
      auth: { userId: "u1", role: "CUSTOMER", status: "DELETED" },
    } as Request;
    const next = vi.fn();

    requireActiveUser()(request, {} as Response, next as NextFunction);

    expect(next.mock.calls[0]?.[0]).toMatchObject({
      statusCode: 401,
      details: [{ code: "ACCOUNT_DELETED" }],
    });
  });
});
