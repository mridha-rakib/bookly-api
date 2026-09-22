import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
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
