import type { ClientSession } from "mongoose";
import QRCode from "qrcode";

import { logger } from "../../config/logger.js";
import { AuthError } from "../auth/auth.errors.js";
import { type AuthResult, issueAuthSession, type RequestContext } from "../auth/auth-session.js";
import type { TokenService } from "../auth/token.service.js";
import { SessionModel } from "../session/session.model.js";
import { SessionRepository } from "../session/session.repository.js";
import { type UserDocument, UserModel } from "../user/user.model.js";
import { professionalRoles } from "../user/user.types.js";
import {
  hashCredential,
  makeRecoveryCodes,
  newTotp,
  opaqueToken,
  openTotp,
  sealTotp,
  verifyTotpStep,
} from "./two-factor.crypto.js";
import { TwoFactorRequired } from "./two-factor.http.js";
import { TwoFactorChallengeModel } from "./two-factor.model.js";
import { assertTwoFactorEnrollmentReady } from "./two-factor.readiness.js";

const ttl = 5 * 60_000;
const invalid = () => new AuthError("TWO_FACTOR_INVALID", 400);
const identityStamp = (user: UserDocument) =>
  hashCredential(
    JSON.stringify([
      user.normalizedEmail,
      user.role,
      user.security?.passwordUpdatedAt?.toISOString(),
      [...(user.authProviders ?? [])].sort(),
    ]),
  );
type Proof = { step: number } | { recoveryHash: string };

export class TwoFactorService {
  private audit(event: string, userId: string): void {
    logger.info({ event: `auth.two_factor.${event}`, userId }, "Account security event");
  }

  private async transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    try {
      return await UserModel.db.transaction(work, { writeConcern: { w: "majority" } });
    } catch (error) {
      if (error instanceof AuthError) throw error;
      logger.error(
        { event: "auth.two_factor.transaction_unconfirmed" },
        "Account security transaction unavailable",
      );
      throw new AuthError("TWO_FACTOR_UNAVAILABLE", 503);
    }
  }

  private async user(userId: string, session?: ClientSession): Promise<UserDocument> {
    const query = UserModel.findById(userId).select("+twoFactor");
    if (session) query.session(session);
    const user = await query.exec();
    if (!user || !professionalRoles.includes(user.role))
      throw new AuthError("PORTAL_MISMATCH", 403);
    if (user.status === "SUSPENDED") throw new AuthError("USER_SUSPENDED", 403);
    if (user.status === "DELETED") throw new AuthError("SESSION_EXPIRED", 401);
    return user;
  }

  /** Persisted, account-wide budget. Reserved outside verification transactions so invalid
   * codes and transaction rollback cannot reset the budget. Windows expire automatically. */
  private async reserve(userId: string): Promise<void> {
    const now = new Date();
    await UserModel.updateOne(
      {
        _id: userId,
        $or: [
          { "twoFactor.rateResetAt": { $exists: false } },
          { "twoFactor.rateResetAt": { $lte: now } },
        ],
      },
      {
        $set: {
          "twoFactor.rateAttempts": 0,
          "twoFactor.rateResetAt": new Date(now.getTime() + ttl),
        },
      },
    );
    const reserved = await UserModel.findOneAndUpdate(
      { _id: userId, "twoFactor.rateAttempts": { $lt: 10 }, "twoFactor.rateResetAt": { $gt: now } },
      { $inc: { "twoFactor.rateAttempts": 1 } },
    ).exec();
    if (!reserved) throw new AuthError("TWO_FACTOR_RATE_LIMITED", 429);
  }

  private async fresh(
    userId: string,
    family: string | undefined,
    session?: ClientSession,
  ): Promise<void> {
    if (!family) throw new AuthError("TWO_FACTOR_REAUTH_REQUIRED", 403);
    const query = SessionModel.exists({
      userId,
      tokenFamilyId: family,
      revokedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
      authenticatedAt: { $gt: new Date(Date.now() - ttl) },
    });
    if (session) query.session(session);
    if (!(await query.exec())) throw new AuthError("TWO_FACTOR_REAUTH_REQUIRED", 403);
  }

  public async status(userId: string) {
    const user = await this.user(userId);
    const enabled = user.twoFactorEnabled === true;
    return {
      enabled,
      recoveryCodesRemaining: user.twoFactor?.recoveryHashes?.length ?? 0,
      // P2.2.7.2 — only meaningful while 2FA is off: whether `start`/`activate` would pass the
      // same read-only enrollment gate right now (flag, key, secure cookies, topology, indexes).
      // An enabled account's verification and management never depend on it.
      ...(enabled ? {} : { enrollmentAvailable: await this.enrollmentAvailable() }),
    };
  }

  private async enrollmentAvailable(): Promise<boolean> {
    try {
      await assertTwoFactorEnrollmentReady();
      return true;
    } catch {
      return false;
    }
  }

  public async requireSecondFactor(
    user: Pick<UserDocument, "_id" | "role" | "twoFactorEnabled">,
  ): Promise<void> {
    if (!professionalRoles.includes(user.role) || !user.twoFactorEnabled) return;
    const current = await this.user(String(user._id));
    if (!current.twoFactorEnabled) throw new AuthError("TWO_FACTOR_CONFLICT", 409);
    await this.reserve(String(user._id));
    const token = opaqueToken();
    await TwoFactorChallengeModel.create({
      tokenHash: hashCredential(token),
      userId: current._id,
      version: current.twoFactorVersion ?? 0,
      identityStamp: identityStamp(current),
      expiresAt: new Date(Date.now() + ttl),
      attempts: 0,
    });
    this.audit("challenge_created", String(user._id));
    throw new TwoFactorRequired(token);
  }

  public async challengeStatus(token: string) {
    const challenge = await TwoFactorChallengeModel.findOne({
      tokenHash: hashCredential(token),
      usedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
      attempts: { $lt: 5 },
    }).exec();
    if (!challenge) throw invalid();
    const user = await this.user(String(challenge.userId));
    if (
      !user.twoFactorEnabled ||
      (user.twoFactorVersion ?? 0) !== challenge.version ||
      identityStamp(user) !== challenge.identityStamp
    )
      throw invalid();
    return { expiresAt: challenge.expiresAt.toISOString() };
  }

  public async cancel(token: string): Promise<void> {
    await TwoFactorChallengeModel.deleteOne({ tokenHash: hashCredential(token) });
  }

  public async start(userId: string, family?: string) {
    await this.user(userId);
    await assertTwoFactorEnrollmentReady();
    await this.fresh(userId, family);
    await this.reserve(userId);
    const user = await this.user(userId);
    const totp = newTotp(user.normalizedEmail);
    const secret = totp.secret.base32;
    const pending = {
      id: opaqueToken(),
      identityStamp: identityStamp(user),
      secret: sealTotp(secret, userId),
      expiresAt: new Date(Date.now() + ttl),
    };
    const updated = await UserModel.findOneAndUpdate(
      {
        _id: userId,
        role: { $in: professionalRoles },
        status: { $nin: ["SUSPENDED", "DELETED"] },
        twoFactorEnabled: { $ne: true },
      },
      { $set: { "twoFactor.pending": pending } },
    ).exec();
    if (!updated) throw new AuthError("TWO_FACTOR_CONFLICT", 409);
    this.audit("enrollment_started", userId);
    return {
      setupId: pending.id,
      manualKey: secret,
      qrDataUrl: await QRCode.toDataURL(totp.toString(), { width: 240, margin: 2 }),
      expiresAt: pending.expiresAt.toISOString(),
    };
  }

  private proof(user: UserDocument, code: string): Proof | null {
    const state = user.twoFactor;
    if (!user.twoFactorEnabled || !state?.secret) return null;
    if (/^[a-f0-9]{32}$/.test(code)) {
      const recoveryHash = hashCredential(`${String(user._id)}:${code}`);
      return state.recoveryHashes?.includes(recoveryHash) ? { recoveryHash } : null;
    }
    const step = verifyTotpStep(openTotp(state.secret, String(user._id)), code);
    return step !== null && step > (state.lastStep ?? -1) ? { step } : null;
  }

  private async consume(
    user: UserDocument,
    proof: Proof,
    session: ClientSession,
  ): Promise<boolean> {
    const filter = {
      _id: user._id,
      twoFactorVersion: user.twoFactorVersion ?? 0,
      twoFactorEnabled: true,
    };
    const result =
      "step" in proof
        ? await UserModel.updateOne(
            {
              ...filter,
              $or: [
                { "twoFactor.lastStep": { $exists: false } },
                { "twoFactor.lastStep": { $lt: proof.step } },
              ],
            },
            { $set: { "twoFactor.lastStep": proof.step } },
            { session },
          )
        : await UserModel.updateOne(
            { ...filter, "twoFactor.recoveryHashes": proof.recoveryHash },
            { $pull: { "twoFactor.recoveryHashes": proof.recoveryHash } },
            { session },
          );
    return result.modifiedCount === 1;
  }

  public async verifyLogin(
    token: string,
    code: string,
    tokens: TokenService,
    context: RequestContext,
    replaceRecoveryCodes = false,
  ): Promise<AuthResult & { recoveryCodes?: string[] }> {
    const known = await TwoFactorChallengeModel.findOne({
      tokenHash: hashCredential(token),
    }).exec();
    if (!known) throw invalid();
    await this.reserve(String(known.userId));
    const replacementCodes = replaceRecoveryCodes ? makeRecoveryCodes() : null;
    const result = await this.transaction(async (session) => {
      const challenge = await TwoFactorChallengeModel.findOneAndUpdate(
        {
          tokenHash: hashCredential(token),
          usedAt: { $exists: false },
          expiresAt: { $gt: new Date() },
          attempts: { $lt: 5 },
        },
        { $inc: { attempts: 1 } },
        { session, new: true },
      ).exec();
      if (!challenge || challenge.expiresAt <= new Date()) return null;
      const user = await this.user(String(challenge.userId), session);
      if (
        (user.twoFactorVersion ?? 0) !== challenge.version ||
        identityStamp(user) !== challenge.identityStamp
      )
        return null;
      const proof = this.proof(user, code);
      if (
        !proof ||
        (replaceRecoveryCodes && !("recoveryHash" in proof)) ||
        !(await this.consume(user, proof, session))
      )
        return null;
      let sessionVersion = challenge.version;
      if (replacementCodes) {
        await UserModel.updateOne(
          { _id: user._id },
          {
            $set: {
              "twoFactor.recoveryHashes": replacementCodes.map((value) =>
                hashCredential(`${String(user._id)}:${value}`),
              ),
            },
            $unset: { "twoFactor.pending": "" },
            $inc: { twoFactorVersion: 1, authSessionVersion: 1 },
          },
          { session },
        );
        await new SessionRepository().revokeAllForUser(user._id, session);
        sessionVersion += 1;
      }
      await TwoFactorChallengeModel.updateOne(
        { _id: challenge._id },
        { $set: { usedAt: new Date() } },
        { session },
      );
      await UserModel.updateOne(
        { _id: user._id },
        { $set: { "security.lastLoginAt": new Date() } },
        { session },
      );
      const auth = await issueAuthSession(
        tokens,
        { userId: user._id, email: user.normalizedEmail, role: user.role, status: user.status },
        context,
        session,
        sessionVersion,
      );
      return { auth, recovery: "recoveryHash" in proof };
    });
    if (!result) {
      this.audit("verification_failed", String(known.userId));
      throw invalid();
    }
    this.audit(result.recovery ? "recovery_used" : "login_verified", String(known.userId));
    if (replacementCodes) this.audit("recovery_regenerated", String(known.userId));
    return { ...result.auth, ...(replacementCodes ? { recoveryCodes: replacementCodes } : {}) };
  }

  public async activate(userId: string, family: string | undefined, setupId: string, code: string) {
    await this.user(userId);
    await assertTwoFactorEnrollmentReady();
    await this.reserve(userId);
    const codes = makeRecoveryCodes();
    const activated = await this.transaction(async (session) => {
      await this.fresh(userId, family, session);
      const user = await this.user(userId, session);
      const pending = user.twoFactor?.pending;
      if (
        user.twoFactorEnabled ||
        !pending ||
        pending.id !== setupId ||
        pending.expiresAt <= new Date() ||
        pending.identityStamp !== identityStamp(user)
      )
        return false;
      const step = verifyTotpStep(openTotp(pending.secret, userId), code);
      if (step === null) return false;
      const updated = await UserModel.updateOne(
        { _id: userId, twoFactorEnabled: { $ne: true }, "twoFactor.pending.id": setupId },
        {
          $set: {
            twoFactorEnabled: true,
            "twoFactor.secret": pending.secret,
            "twoFactor.lastStep": step,
            "twoFactor.recoveryHashes": codes.map((code) => hashCredential(`${userId}:${code}`)),
          },
          $inc: { twoFactorVersion: 1, authSessionVersion: 1 },
          $unset: { "twoFactor.pending": "" },
        },
        { session },
      );
      if (updated.modifiedCount !== 1) return false;
      await new SessionRepository().revokeAllForUser(userId, session);
      return true;
    });
    if (!activated) {
      this.audit("verification_failed", userId);
      throw invalid();
    }
    this.audit("enabled", userId);
    return { recoveryCodes: codes, signInRequired: true };
  }

  public async manage(
    userId: string,
    family: string | undefined,
    code: string,
    action: "disable" | "regenerate",
  ) {
    await this.user(userId);
    await this.reserve(userId);
    const codes = action === "regenerate" ? makeRecoveryCodes() : [];
    const result = await this.transaction(async (session) => {
      await this.fresh(userId, family, session);
      const user = await this.user(userId, session);
      const proof = this.proof(user, code);
      if (!proof || !(await this.consume(user, proof, session))) return null;
      const update =
        action === "disable"
          ? {
              $set: { twoFactorEnabled: false },
              $unset: {
                "twoFactor.secret": "",
                "twoFactor.pending": "",
                "twoFactor.recoveryHashes": "",
                "twoFactor.lastStep": "",
              },
              $inc: { twoFactorVersion: 1, authSessionVersion: 1 },
            }
          : {
              $set: {
                "twoFactor.recoveryHashes": codes.map((code) =>
                  hashCredential(`${userId}:${code}`),
                ),
              },
              $unset: { "twoFactor.pending": "" },
              $inc: { twoFactorVersion: 1, authSessionVersion: 1 },
            };
      await UserModel.updateOne({ _id: user._id }, update, { session });
      await new SessionRepository().revokeAllForUser(userId, session);
      return { recovery: "recoveryHash" in proof };
    });
    if (!result) {
      this.audit("verification_failed", userId);
      throw invalid();
    }
    if (result.recovery) this.audit("recovery_used", userId);
    this.audit(action === "disable" ? "disabled" : "recovery_regenerated", userId);
    return { recoveryCodes: codes, signInRequired: true };
  }
}
