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

  public async revoke(sessionId: Types.ObjectId): Promise<void> {
    await SessionModel.updateOne(
      { _id: sessionId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
    );
  }

  public async revokeFamily(tokenFamilyId: string): Promise<void> {
    await SessionModel.updateMany(
      { tokenFamilyId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
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

  public async rotate(
    oldSession: SessionDocument,
    refreshTokenHash: string,
    expiresAt: Date,
  ): Promise<SessionDocument> {
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
      { returnDocument: "after" },
    ).exec();

    if (!consumed) {
      throw new Error("REFRESH_TOKEN_REUSED");
    }

    const newSession = await SessionModel.create({
      userId: oldSession.userId,
      refreshTokenHash,
      tokenFamilyId: oldSession.tokenFamilyId,
      expiresAt,
      userAgent: oldSession.userAgent,
      ipAddress: oldSession.ipAddress,
    });

    await SessionModel.updateOne(
      { _id: oldSession._id },
      {
        $set: {
          replacedBySessionId: newSession._id,
        },
      },
    );

    return newSession as SessionDocument;
  }
}
