import type { Types } from "mongoose";

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
  public async create(input: CreateSessionInput): Promise<SessionDocument> {
    return new SessionModel(input).save();
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

  public async rotate(
    oldSession: SessionDocument,
    refreshTokenHash: string,
    expiresAt: Date,
  ): Promise<SessionDocument> {
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
          revokedAt: new Date(),
          replacedBySessionId: newSession._id,
          lastUsedAt: new Date(),
        },
      },
    );

    return newSession as SessionDocument;
  }
}
