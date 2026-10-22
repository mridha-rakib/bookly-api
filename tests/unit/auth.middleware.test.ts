import type { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

import {
  createAuthenticateAccessTokenMiddleware,
  createOptionalAuthenticateAccessTokenMiddleware,
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
        verifyAccessToken: vi
          .fn()
          .mockResolvedValue({ sub: "user-id", role: "CUSTOMER", sid: "f" }),
        isAccessTokenSessionLive: vi.fn().mockResolvedValue(true),
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
        verifyAccessToken: vi
          .fn()
          .mockResolvedValue({ sub: "user-id", role: "CUSTOMER", sid: "f" }),
        isAccessTokenSessionLive: vi.fn().mockResolvedValue(true),
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

  describe("Phase 1A — session-family validation", () => {
    const claims = { sub: "user-id", role: "CUSTOMER", sid: "family" };
    const build = (overrides: {
      verify?: ReturnType<typeof vi.fn>;
      live?: ReturnType<typeof vi.fn>;
      findById?: ReturnType<typeof vi.fn>;
    }) => {
      const tokenService = {
        verifyAccessToken: overrides.verify ?? vi.fn().mockResolvedValue(claims),
        isAccessTokenSessionLive: overrides.live ?? vi.fn().mockResolvedValue(true),
      } as unknown as TokenService;
      const userRepository = {
        findById: overrides.findById ?? vi.fn().mockResolvedValue(createUser()),
      } as unknown as UserRepository;
      return {
        required: createAuthenticateAccessTokenMiddleware(tokenService, userRepository),
        optional: createOptionalAuthenticateAccessTokenMiddleware(tokenService, userRepository),
      };
    };

    it("rejects a valid, unexpired JWT whose session family is no longer live (401)", async () => {
      const { required } = build({ live: vi.fn().mockResolvedValue(false) });
      const request = createRequest("Bearer valid");
      const next = vi.fn();

      await required(request, {} as Response, next as NextFunction);

      expect(request.auth).toBeUndefined();
      expect(next.mock.calls[0]?.[0]).toMatchObject({
        statusCode: 401,
        details: [{ code: "SESSION_EXPIRED" }],
      });
    });

    it("reports a session-store failure as 503, never as authenticated or as a revoked session", async () => {
      const { required } = build({ live: vi.fn().mockRejectedValue(new Error("db down")) });
      const request = createRequest("Bearer valid");
      const next = vi.fn();

      await required(request, {} as Response, next as NextFunction);

      expect(request.auth).toBeUndefined();
      expect(next.mock.calls[0]?.[0]).toMatchObject({
        statusCode: 503,
        details: [{ code: "AUTHENTICATION_UNAVAILABLE" }],
      });
    });

    it("reports a user-store failure as 503 too", async () => {
      const { required } = build({ findById: vi.fn().mockRejectedValue(new Error("db down")) });
      const next = vi.fn();

      await required(createRequest("Bearer valid"), {} as Response, next as NextFunction);

      expect(next.mock.calls[0]?.[0]).toMatchObject({ statusCode: 503 });
    });

    it("never consults storage for a token that fails verification", async () => {
      const live = vi.fn();
      const findById = vi.fn();
      const { required } = build({
        verify: vi.fn().mockRejectedValue(new Error("bad")),
        live,
        findById,
      });
      const next = vi.fn();

      await required(createRequest("Bearer forged"), {} as Response, next as NextFunction);

      expect(next.mock.calls[0]?.[0]).toMatchObject({ statusCode: 401 });
      expect(live).not.toHaveBeenCalled();
      expect(findById).not.toHaveBeenCalled();
    });

    it("runs the user and session lookups concurrently", async () => {
      let releaseUser: (value: unknown) => void = () => undefined;
      const findById = vi.fn(
        () =>
          new Promise((resolve) => {
            releaseUser = resolve;
          }),
      );
      const live = vi.fn().mockResolvedValue(true);
      const { required } = build({ findById, live });
      const next = vi.fn();

      const pending = required(createRequest("Bearer valid"), {} as Response, next as NextFunction);
      await Promise.resolve();
      await Promise.resolve();
      expect(live).toHaveBeenCalledWith(claims);
      releaseUser(createUser());
      await pending;

      expect(next).toHaveBeenCalledWith();
    });

    it("optional auth: a revoked family proceeds anonymously, never authenticated", async () => {
      const { optional } = build({ live: vi.fn().mockResolvedValue(false) });
      const request = createRequest("Bearer valid");
      const next = vi.fn();

      await optional(request, {} as Response, next as NextFunction);

      expect(request.auth).toBeUndefined();
      expect(next).toHaveBeenCalledWith();
    });

    it("optional auth: a storage failure also proceeds anonymously", async () => {
      const { optional } = build({ live: vi.fn().mockRejectedValue(new Error("db down")) });
      const request = createRequest("Bearer valid");
      const next = vi.fn();

      await optional(request, {} as Response, next as NextFunction);

      expect(request.auth).toBeUndefined();
      expect(next).toHaveBeenCalledWith();
    });

    it("optional auth: a live family authenticates", async () => {
      const { optional } = build({});
      const request = createRequest("Bearer valid");
      const next = vi.fn();

      await optional(request, {} as Response, next as NextFunction);

      expect(request.auth).toMatchObject({ role: "CUSTOMER", status: "ACTIVE" });
    });
  });
});
