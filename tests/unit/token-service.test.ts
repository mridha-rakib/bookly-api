import { SignJWT } from "jose";
import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import { env } from "../../src/config/env.js";
import { TokenService } from "../../src/modules/auth/token.service.js";
import type { SessionDocument } from "../../src/modules/session/session.model.js";

class InMemorySessionRepository {
  public sessions: SessionDocument[] = [];

  public async create(input: Omit<SessionDocument, "_id" | "createdAt">): Promise<SessionDocument> {
    const session = {
      ...input,
      _id: new Types.ObjectId(),
      createdAt: new Date(),
    } as SessionDocument;
    this.sessions.push(session);
    return session;
  }

  public async findByRefreshTokenHash(refreshTokenHash: string): Promise<SessionDocument | null> {
    return this.sessions.find((session) => session.refreshTokenHash === refreshTokenHash) ?? null;
  }

  public async rotate(
    oldSession: SessionDocument,
    refreshTokenHash: string,
    expiresAt: Date,
  ): Promise<SessionDocument> {
    const stored = this.sessions.find((session) => session._id.equals(oldSession._id));

    if (!stored || stored.revokedAt) {
      throw new Error("REFRESH_TOKEN_REUSED");
    }

    stored.revokedAt = new Date();
    const next = await this.create({
      userId: oldSession.userId,
      refreshTokenHash,
      tokenFamilyId: oldSession.tokenFamilyId,
      expiresAt,
    });
    stored.replacedBySessionId = next._id;
    return next;
  }

  public async hasLiveFamily(
    tokenFamilyId: string,
    userId: Types.ObjectId | string,
  ): Promise<boolean> {
    return this.sessions.some(
      (session) =>
        session.tokenFamilyId === tokenFamilyId &&
        session.userId.equals(String(userId)) &&
        !session.revokedAt &&
        session.expiresAt > new Date(),
    );
  }

  public async revoke(sessionId: Types.ObjectId): Promise<void> {
    const stored = this.sessions.find((session) => session._id.equals(sessionId));
    if (stored) {
      stored.revokedAt = new Date();
    }
  }

  public async revokeFamily(tokenFamilyId: string): Promise<void> {
    for (const session of this.sessions) {
      if (session.tokenFamilyId === tokenFamilyId) {
        session.revokedAt = new Date();
      }
    }
  }

  public async revokeAllForUser(userId: Types.ObjectId): Promise<void> {
    for (const session of this.sessions) {
      if (session.userId.equals(userId)) {
        session.revokedAt = new Date();
      }
    }
  }

  public async revokeAllForUserExcept(
    userId: Types.ObjectId,
    exceptSessionId: Types.ObjectId,
  ): Promise<void> {
    for (const session of this.sessions) {
      if (session.userId.equals(userId) && !session._id.equals(exceptSessionId)) {
        session.revokedAt = new Date();
      }
    }
  }
}

describe("TokenService", () => {
  it("rotates refresh tokens and rejects old token reuse", async () => {
    const repository = new InMemorySessionRepository();
    const service = new TokenService(repository);
    const initial = await service.createRefreshSession({ userId: new Types.ObjectId() });

    const rotated = await service.rotateRefreshToken(initial.refreshToken);

    await expect(service.rotateRefreshToken(initial.refreshToken)).rejects.toThrow(
      "REFRESH_TOKEN_REUSED",
    );
    expect(rotated.refreshToken).not.toBe(initial.refreshToken);
  });

  it("revokeAllSessionsForUser revokes every session for that user but leaves other users' sessions valid", async () => {
    const repository = new InMemorySessionRepository();
    const service = new TokenService(repository);
    const userId = new Types.ObjectId();
    const otherUserId = new Types.ObjectId();
    const mine = await service.createRefreshSession({ userId });
    const theirs = await service.createRefreshSession({ userId: otherUserId });

    await service.revokeAllSessionsForUser(userId);

    await expect(service.rotateRefreshToken(mine.refreshToken)).rejects.toThrow(
      "REFRESH_TOKEN_REUSED",
    );
    await expect(service.rotateRefreshToken(theirs.refreshToken)).resolves.toMatchObject({
      userId: otherUserId,
    });
  });

  // Phase 1 (session hardening) — password change revokes every OTHER session for the user
  // while preserving the one identified by the caller's own refresh token.
  describe("revokeOtherSessionsForUser", () => {
    it("preserves the session matching the given current refresh token and revokes the rest", async () => {
      const repository = new InMemorySessionRepository();
      const service = new TokenService(repository);
      const userId = new Types.ObjectId();
      const current = await service.createRefreshSession({ userId });
      const other1 = await service.createRefreshSession({ userId });
      const other2 = await service.createRefreshSession({ userId });

      await service.revokeOtherSessionsForUser(userId, current.refreshToken);

      // Current session still rotates fine.
      await expect(service.rotateRefreshToken(current.refreshToken)).resolves.toMatchObject({
        userId,
      });
      // The others are revoked (reuse-detection on rotate).
      await expect(service.rotateRefreshToken(other1.refreshToken)).rejects.toThrow(
        "REFRESH_TOKEN_REUSED",
      );
      await expect(service.rotateRefreshToken(other2.refreshToken)).rejects.toThrow(
        "REFRESH_TOKEN_REUSED",
      );
    });

    it("does not touch another user's sessions", async () => {
      const repository = new InMemorySessionRepository();
      const service = new TokenService(repository);
      const userId = new Types.ObjectId();
      const otherUserId = new Types.ObjectId();
      const current = await service.createRefreshSession({ userId });
      const theirs = await service.createRefreshSession({ userId: otherUserId });

      await service.revokeOtherSessionsForUser(userId, current.refreshToken);

      await expect(service.rotateRefreshToken(theirs.refreshToken)).resolves.toMatchObject({
        userId: otherUserId,
      });
    });

    it("falls back to revoking every session (including the caller's) when no refresh token is given", async () => {
      const repository = new InMemorySessionRepository();
      const service = new TokenService(repository);
      const userId = new Types.ObjectId();
      const current = await service.createRefreshSession({ userId });
      const other = await service.createRefreshSession({ userId });

      await service.revokeOtherSessionsForUser(userId, undefined);

      await expect(service.rotateRefreshToken(current.refreshToken)).rejects.toThrow(
        "REFRESH_TOKEN_REUSED",
      );
      await expect(service.rotateRefreshToken(other.refreshToken)).rejects.toThrow(
        "REFRESH_TOKEN_REUSED",
      );
    });

    it("falls back to revoking every session when the given refresh token does not resolve to a live session", async () => {
      const repository = new InMemorySessionRepository();
      const service = new TokenService(repository);
      const userId = new Types.ObjectId();
      const other = await service.createRefreshSession({ userId });

      await service.revokeOtherSessionsForUser(userId, "a-stale-or-unknown-refresh-token");

      await expect(service.rotateRefreshToken(other.refreshToken)).rejects.toThrow(
        "REFRESH_TOKEN_REUSED",
      );
    });
  });

  it("allows only one concurrent refresh rotation to succeed", async () => {
    const repository = new InMemorySessionRepository();
    const service = new TokenService(repository);
    const initial = await service.createRefreshSession({ userId: new Types.ObjectId() });

    const results = await Promise.allSettled([
      service.rotateRefreshToken(initial.refreshToken),
      service.rotateRefreshToken(initial.refreshToken),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});

describe("TokenService — Phase 1A session-bound access tokens", () => {
  const secret = new TextEncoder().encode(env.JWT_ACCESS_TOKEN_SECRET);
  const signRaw = (payload: Record<string, unknown>, sub: string, key: Uint8Array = secret) =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(key);

  it("binds every access token to its issuing family and round-trips sid", async () => {
    const service = new TokenService(new InMemorySessionRepository());
    const userId = new Types.ObjectId();
    const refresh = await service.createRefreshSession({ userId });
    const token = await service.createAccessToken({
      userId,
      role: "CUSTOMER",
      sessionFamilyId: refresh.tokenFamilyId,
    });

    await expect(service.verifyAccessToken(token)).resolves.toMatchObject({
      sub: String(userId),
      role: "CUSTOMER",
      sid: refresh.tokenFamilyId,
    });
  });

  it("refuses to sign an access token without a session family", async () => {
    const service = new TokenService(new InMemorySessionRepository());
    await expect(
      service.createAccessToken({
        userId: new Types.ObjectId(),
        role: "CUSTOMER",
        sessionFamilyId: undefined as unknown as string,
      }),
    ).rejects.toThrow("bound to a session family");
    await expect(
      service.createAccessToken({
        userId: new Types.ObjectId(),
        role: "CUSTOMER",
        sessionFamilyId: "",
      }),
    ).rejects.toThrow("bound to a session family");
  });

  it("keeps the family stable across rotation and gives each login its own family", async () => {
    const service = new TokenService(new InMemorySessionRepository());
    const userId = new Types.ObjectId();
    const first = await service.createRefreshSession({ userId });
    const second = await service.createRefreshSession({ userId });
    const rotated = await service.rotateRefreshToken(first.refreshToken);
    const rotatedAgain = await service.rotateRefreshToken(rotated.refreshToken);

    expect(second.tokenFamilyId).not.toBe(first.tokenFamilyId);
    expect(rotated.tokenFamilyId).toBe(first.tokenFamilyId);
    expect(rotatedAgain.tokenFamilyId).toBe(first.tokenFamilyId);
  });

  it("a bound token is live through rotation and dead once its family is revoked; other families stay live", async () => {
    const repository = new InMemorySessionRepository();
    const service = new TokenService(repository);
    const userId = new Types.ObjectId();
    const deviceA = await service.createRefreshSession({ userId });
    const deviceB = await service.createRefreshSession({ userId });
    const claimsA = { sub: String(userId), role: "CUSTOMER" as const, sid: deviceA.tokenFamilyId };
    const claimsB = { sub: String(userId), role: "CUSTOMER" as const, sid: deviceB.tokenFamilyId };

    await service.rotateRefreshToken(deviceA.refreshToken);
    await expect(service.isAccessTokenSessionLive(claimsA)).resolves.toBe(true);

    await service.revokeRefreshToken(deviceA.refreshToken);
    await expect(service.isAccessTokenSessionLive(claimsA)).resolves.toBe(false);
    await expect(service.isAccessTokenSessionLive(claimsB)).resolves.toBe(true);
  });

  it("rejects a live family presented with another user's subject", async () => {
    const service = new TokenService(new InMemorySessionRepository());
    const owner = new Types.ObjectId();
    const family = await service.createRefreshSession({ userId: owner });

    await expect(
      service.isAccessTokenSessionLive({
        sub: String(new Types.ObjectId()),
        role: "CUSTOMER",
        sid: family.tokenFamilyId,
      }),
    ).resolves.toBe(false);
  });

  it("rejects forged, tampered and malformed tokens at verification", async () => {
    const service = new TokenService(new InMemorySessionRepository());
    const sub = String(new Types.ObjectId());
    const forged = await signRaw(
      { role: "CUSTOMER", sid: "f" },
      sub,
      new TextEncoder().encode("a-different-secret-that-is-at-least-32-chars"),
    );
    const genuine = await signRaw({ role: "CUSTOMER", sid: "family-a" }, sub);
    const [header, , signature] = genuine.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ role: "CUSTOMER", sid: "family-b", sub, iat: 1, exp: 9_999_999_999 }),
    ).toString("base64url");

    await expect(service.verifyAccessToken(forged)).rejects.toThrow();
    await expect(
      service.verifyAccessToken(`${header}.${tamperedPayload}.${signature}`),
    ).rejects.toThrow();
    await expect(
      service.verifyAccessToken(await signRaw({ role: "CUSTOMER", sid: 42 }, sub)),
    ).rejects.toThrow("Invalid token claims");
    await expect(
      service.verifyAccessToken(await signRaw({ role: "CUSTOMER", sid: "" }, sub)),
    ).rejects.toThrow("Invalid token claims");
    await expect(
      service.verifyAccessToken(await signRaw({ role: "CUSTOMER", sid: "x" }, "not-an-object-id")),
    ).rejects.toThrow("Invalid token claims");
  });

  it("legacy tokens without sid: rejected by default, accepted only under grace and only if issued before the cutoff", async () => {
    const repository = new InMemorySessionRepository();
    const sub = String(new Types.ObjectId());
    const legacy = await signRaw({ role: "CUSTOMER" }, sub);
    const now = new Date();
    const strict = new TokenService(repository);
    const graceAfterIssue = new TokenService(repository, {
      legacyAccessTokenGrace: true,
      legacyCutoff: new Date(now.getTime() + 60_000),
    });
    const graceBeforeIssue = new TokenService(repository, {
      legacyAccessTokenGrace: true,
      legacyCutoff: new Date(now.getTime() - 60_000),
    });

    const claims = await strict.verifyAccessToken(legacy);
    expect(claims.sid).toBeUndefined();
    await expect(strict.isAccessTokenSessionLive(claims)).resolves.toBe(false);
    await expect(graceAfterIssue.isAccessTokenSessionLive(claims)).resolves.toBe(true);
    await expect(graceBeforeIssue.isAccessTokenSessionLive(claims)).resolves.toBe(false);
  });

  it("propagates repository failures instead of reporting a dead session", async () => {
    const repository = new InMemorySessionRepository();
    repository.hasLiveFamily = async () => {
      throw new Error("database unavailable");
    };
    const service = new TokenService(repository);

    await expect(
      service.isAccessTokenSessionLive({
        sub: String(new Types.ObjectId()),
        role: "CUSTOMER",
        sid: "f",
      }),
    ).rejects.toThrow("database unavailable");
  });
});
