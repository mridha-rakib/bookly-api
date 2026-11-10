import type { ClientSession, Types } from "mongoose";

import { AuthError } from "../auth/auth.errors.js";
import { UserModel } from "../user/user.model.js";

import { type SessionDocument, SessionModel } from "./session.model.js";

type CreateSessionInput = {
  userId: Types.ObjectId;
  refreshTokenHash: string;
  tokenFamilyId: string;
  authenticatedAt?: Date | undefined;
  twoFactorVersion?: number | undefined;
  expiresAt: Date;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
};

export class SessionRepository {
  public async create(
    input: CreateSessionInput,
    session?: ClientSession,
  ): Promise<SessionDocument> {
    const insert = async (transaction: ClientSession) => {
      await this.lockActiveUser(input.userId, transaction, input.twoFactorVersion);
      return new SessionModel(input).save({ session: transaction });
    };
    return session
      ? insert(session)
      : SessionModel.db.transaction(insert, {
          writeConcern: { w: "majority" },
        });
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

  public async revokeFamily(
    tokenFamilyId: string,
    reason: SessionDocument["revocationReason"] = "TOKEN_REUSE",
  ): Promise<void> {
    await SessionModel.db.transaction(
      async (session) => {
        // Include consumed ancestors: writing the row rotation consumes forces a conflict
        // and retry, so a successor cannot be inserted after revocation's snapshot.
        await SessionModel.updateMany(
          { tokenFamilyId, revocationReason: { $ne: "ADMIN_SUSPENSION" } },
          {
            $set: { revokedAt: new Date(), revocationReason: reason },
            $inc: { revocationVersion: 1 },
          },
          { session },
        );
      },
      { writeConcern: { w: "majority" } },
    );
  }

  /** Includes consumed ancestors to serialize with rotation and classify old credentials. */
  public async revokeAllForUser(
    userId: Types.ObjectId | string,
    session?: ClientSession,
    reason: SessionDocument["revocationReason"] = "REVOKE_ALL",
  ): Promise<void> {
    await SessionModel.updateMany(
      { userId },
      { $set: { revokedAt: new Date(), revocationReason: reason }, $inc: { revocationVersion: 1 } },
      session ? { session } : { writeConcern: { w: "majority" } },
    );
  }

  /** A real User write is required: a read alone would permit transaction write skew. */
  private async lockActiveUser(
    userId: Types.ObjectId,
    session: ClientSession,
    factorVersion?: number,
  ): Promise<void> {
    const user = await UserModel.findOneAndUpdate(
      {
        _id: userId,
        status: { $nin: ["SUSPENDED", "DELETED"] },
        $or: [
          { twoFactorEnabled: { $ne: true } },
          ...(factorVersion === undefined
            ? []
            : [{ twoFactorEnabled: true, twoFactorVersion: factorVersion }]),
        ],
      },
      { $inc: { authSessionVersion: 1 } },
      { session, new: true },
    ).exec();
    if (!user) {
      const current = await UserModel.findById(userId).session(session).exec();
      if (
        current?.twoFactorEnabled &&
        current.status !== "SUSPENDED" &&
        current.status !== "DELETED"
      )
        throw new AuthError("TWO_FACTOR_CONFLICT", 409);
      throw new AuthError(
        current?.status === "SUSPENDED" ? "USER_SUSPENDED" : "SESSION_EXPIRED",
        current?.status === "SUSPENDED" ? 403 : 401,
      );
    }
  }

  public async administrativeRevocationError(userId: Types.ObjectId): Promise<AuthError> {
    const user = await UserModel.findById(userId).read("primary").exec();
    return new AuthError(
      user?.status === "SUSPENDED" ? "USER_SUSPENDED" : "SESSION_EXPIRED",
      user?.status === "SUSPENDED" ? 403 : 401,
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
      { $set: { revokedAt: new Date(), revocationReason: "REVOKE_ALL" } },
    );
  }

  public async rotate(
    oldSession: SessionDocument,
    refreshTokenHash: string,
    expiresAt: Date,
  ): Promise<SessionDocument> {
    return SessionModel.db.transaction(
      async (session) => {
        await this.lockActiveUser(oldSession.userId, session, oldSession.twoFactorVersion);
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
              revocationReason: "ROTATED",
            },
          },
          { returnDocument: "after", session },
        ).exec();

        if (!consumed) {
          const current = await SessionModel.findById(oldSession._id).session(session).exec();
          if (
            current?.revocationReason &&
            current.revocationReason !== "ROTATED" &&
            current.revocationReason !== "TOKEN_REUSE"
          ) {
            throw new Error("SESSION_EXPIRED");
          }
          throw new Error(
            !current || current.expiresAt <= new Date()
              ? "SESSION_EXPIRED"
              : "REFRESH_TOKEN_REUSED",
          );
        }

        const newSession = await this.create(
          {
            userId: oldSession.userId,
            authenticatedAt: oldSession.authenticatedAt,
            twoFactorVersion: oldSession.twoFactorVersion,
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
