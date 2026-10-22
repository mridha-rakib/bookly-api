import type { ClientSession, Types } from "mongoose";

import { type SessionDocument, SessionModel } from "./session.model.js";

type CreateSessionInput = {
  userId: Types.ObjectId;
  refreshTokenHash: string;
  tokenFamilyId: string;
  expiresAt: Date;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
};

export class SessionRepository {
  public async create(
    input: CreateSessionInput,
    session?: ClientSession,
  ): Promise<SessionDocument> {
    return new SessionModel(input).save(session ? { session } : undefined);
  }

  public async findByRefreshTokenHash(refreshTokenHash: string): Promise<SessionDocument | null> {
    return SessionModel.findOne({ refreshTokenHash }).select("+refreshTokenHash").exec();
  }

  /** Access-token authentication check. Rotation marks consumed rows revoked, so a family is live
   * exactly while its current row is unrevoked and unexpired. Served by {tokenFamilyId, revokedAt};
   * read from the primary so an acknowledged (majority) revocation is never missed. */
  public async hasLiveFamily(
    tokenFamilyId: string,
    userId: Types.ObjectId | string,
  ): Promise<boolean> {
    const live = await SessionModel.exists({
      tokenFamilyId,
      userId,
      revokedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    })
      .read("primary")
      .exec();
    return live !== null;
  }

  public async revoke(sessionId: Types.ObjectId): Promise<void> {
    await SessionModel.updateOne(
      { _id: sessionId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
    );
  }

  public async revokeFamily(tokenFamilyId: string): Promise<void> {
    await SessionModel.db.transaction(
      async (session) => {
        // Include consumed ancestors: writing the row rotation consumes forces a conflict
        // and retry, so a successor cannot be inserted after revocation's snapshot.
        await SessionModel.updateMany(
          { tokenFamilyId },
          { $set: { revokedAt: new Date() }, $inc: { revocationVersion: 1 } },
          { session },
        );
      },
      { writeConcern: { w: "majority" } },
    );
  }

  /** Batch 18 — used after a verified email change to force re-login everywhere. Access tokens
   * are stateless JWTs and remain valid until their own short TTL naturally expires; this only
   * blocks future refreshes. */
  public async revokeAllForUser(userId: Types.ObjectId): Promise<void> {
    await SessionModel.updateMany(
      { userId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
    );
  }

  /** Phase 1 (session hardening) — used after a password change to revoke every OTHER active
   * refresh session while preserving the caller's own, already-identified one. Same
   * `revokedAt`-marking convention as revokeAllForUser (idempotent against already-revoked/
   * expired rows via the same guard); never touches another user's sessions. */
  public async revokeAllForUserExcept(
    userId: Types.ObjectId,
    exceptSessionId: Types.ObjectId,
  ): Promise<void> {
    await SessionModel.updateMany(
      { userId, _id: { $ne: exceptSessionId }, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
    );
  }

  public async rotate(
    oldSession: SessionDocument,
    refreshTokenHash: string,
    expiresAt: Date,
  ): Promise<SessionDocument> {
    return SessionModel.db.transaction(
      async (session) => {
        const consumed = await SessionModel.findOneAndUpdate(
          {
            _id: oldSession._id,
            revokedAt: { $exists: false },
            expiresAt: { $gt: new Date() },
          },
          {
            $set: {
              revokedAt: new Date(),
              lastUsedAt: new Date(),
            },
          },
          { returnDocument: "after", session },
        ).exec();

        if (!consumed) {
          throw new Error("REFRESH_TOKEN_REUSED");
        }

        const newSession = await this.create(
          {
            userId: oldSession.userId,
            refreshTokenHash,
            tokenFamilyId: oldSession.tokenFamilyId,
            expiresAt,
            userAgent: oldSession.userAgent,
            ipAddress: oldSession.ipAddress,
          },
          session,
        );

        await SessionModel.updateOne(
          { _id: oldSession._id },
          {
            $set: {
              replacedBySessionId: newSession._id,
            },
          },
          { session },
        );

        return newSession as SessionDocument;
      },
      { writeConcern: { w: "majority" } },
    );
  }
}
