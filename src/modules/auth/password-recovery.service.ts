import { createHmac } from "node:crypto";
import { env } from "../../config/env.js";
import type { SessionRepository } from "../session/session.repository.js";
import { UserModel } from "../user/user.model.js";
import { professionalRoles, type UserRole } from "../user/user.types.js";
import type { EmailOtpProvider } from "../verification/email-otp.provider.js";
import { AuthError } from "./auth.errors.js";
import {
  createOpaqueToken,
  generateNumericOtp,
  normalizeEmail,
  safeCompare,
  sha256,
} from "./auth.utils.js";
import type { PasswordHasher } from "./password-hasher.js";
import { PasswordRecoveryModel } from "./password-recovery.model.js";

type Portal = "CUSTOMER" | "PROFESSIONAL";
const digest = (value: string) => sha256(value);
const identity = (portal: Portal, email: string) =>
  createHmac("sha256", env.OTP_HASH_SECRET).update(`${portal}:${email}`).digest("hex");
const otpDigest = (key: string, code: string) =>
  createHmac("sha256", env.OTP_HASH_SECRET).update(`PASSWORD_RESET:${key}:${code}`).digest("hex");
const roles = (portal: Portal): UserRole[] =>
  portal === "CUSTOMER" ? ["CUSTOMER"] : professionalRoles;

export class PasswordRecoveryService {
  constructor(
    private email: EmailOtpProvider,
    private hasher: PasswordHasher,
    private sessions: SessionRepository,
  ) {}

  async request(
    portal: Portal,
    emailAddress: string,
    previousChallenge?: string,
  ): Promise<{ challenge: string }> {
    const email = normalizeEmail(emailAddress),
      key = identity(portal, email);
    const challenge = createOpaqueToken(),
      code = generateNumericOtp(env.OTP_LENGTH),
      now = new Date();
    const user = await UserModel.findOne({
      normalizedEmail: email,
      role: { $in: roles(portal) },
      status: { $nin: ["SUSPENDED", "DELETED"] },
    })
      .select("+passwordHash")
      .lean()
      .exec();
    // A row is maintained for both existing and nonexistent addresses. Atomic compare-and-set
    // enforces a shared per-address cooldown and hourly send limit even across application nodes.
    try {
      await PasswordRecoveryModel.updateOne(
        { _id: key },
        {
          $setOnInsert: {
            _id: key,
            portal,
            challengeHash: digest(createOpaqueToken()),
            otpHash: otpDigest(key, code),
            expiresAt: now,
            attempts: 0,
            sends: [],
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === 11000))
        throw error;
    }
    const hourAgo = new Date(now.getTime() - 3600000);
    const cooldown = new Date(now.getTime() - env.OTP_RESEND_COOLDOWN_SECONDS * 1000);
    const row = await PasswordRecoveryModel.findOneAndUpdate(
      {
        _id: key,
        $expr: {
          $and: [
            {
              $lt: [
                {
                  $size: {
                    $filter: { input: "$sends", as: "sent", cond: { $gt: ["$$sent", hourAgo] } },
                  },
                },
                env.OTP_MAX_RESENDS_PER_HOUR,
              ],
            },
            {
              $eq: [
                {
                  $size: {
                    $filter: { input: "$sends", as: "sent", cond: { $gt: ["$$sent", cooldown] } },
                  },
                },
                0,
              ],
            },
          ],
        },
      },
      {
        $set: {
          portal,
          challengeHash: digest(challenge),
          otpHash: otpDigest(key, code),
          expiresAt: new Date(now.getTime() + env.OTP_EXPIRY_MINUTES * 60000),
          attempts: 0,
          ...(user?.passwordHash
            ? { userId: user._id, passwordStamp: user.security?.passwordUpdatedAt }
            : {}),
        },
        $unset: {
          resetHash: 1,
          resetExpiresAt: 1,
          ...(!user?.passwordHash ? { userId: 1, passwordStamp: 1 } : {}),
        },
        $push: { sends: { $each: [now], $slice: -env.OTP_MAX_RESENDS_PER_HOUR } },
      },
      { returnDocument: "after" },
    ).exec();
    if (row && user?.passwordHash) {
      // Delivery failures are deliberately indistinguishable from nonexistent accounts.
      void this.email
        .sendOtp({ to: email, code, purpose: "PASSWORD_RESET" })
        .catch(() => undefined);
    }
    if (row) return { challenge };
    const previousIsActive =
      previousChallenge &&
      (await PasswordRecoveryModel.exists({
        _id: key,
        portal,
        challengeHash: digest(previousChallenge),
        expiresAt: { $gt: new Date() },
        attempts: { $lt: env.OTP_MAX_VERIFICATION_ATTEMPTS },
        resetHash: { $exists: false },
      }));
    return { challenge: previousIsActive ? previousChallenge : "" };
  }

  async resend(portal: Portal, challenge: string): Promise<void> {
    const now = new Date(),
      hourAgo = new Date(now.getTime() - 3600000);
    const cooldown = new Date(now.getTime() - env.OTP_RESEND_COOLDOWN_SECONDS * 1000);
    const existing = await PasswordRecoveryModel.findOne({
      portal,
      challengeHash: digest(challenge),
      resetHash: { $exists: false },
    }).exec();
    if (!existing) return;
    const code = generateNumericOtp(env.OTP_LENGTH);
    const row = await PasswordRecoveryModel.findOneAndUpdate(
      {
        _id: existing._id,
        portal,
        challengeHash: digest(challenge),
        resetHash: { $exists: false },
        $expr: {
          $and: [
            {
              $lt: [
                {
                  $size: {
                    $filter: { input: "$sends", as: "sent", cond: { $gt: ["$$sent", hourAgo] } },
                  },
                },
                env.OTP_MAX_RESENDS_PER_HOUR,
              ],
            },
            {
              $eq: [
                {
                  $size: {
                    $filter: { input: "$sends", as: "sent", cond: { $gt: ["$$sent", cooldown] } },
                  },
                },
                0,
              ],
            },
          ],
        },
      },
      {
        $set: {
          otpHash: otpDigest(existing._id, code),
          expiresAt: new Date(now.getTime() + env.OTP_EXPIRY_MINUTES * 60000),
          attempts: 0,
        },
        $push: { sends: { $each: [now], $slice: -env.OTP_MAX_RESENDS_PER_HOUR } },
      },
      { returnDocument: "after" },
    ).exec();
    if (row?.userId && row.passwordStamp) {
      const user = await UserModel.findOne({
        _id: row.userId,
        status: { $nin: ["SUSPENDED", "DELETED"] },
        role: { $in: roles(portal) },
        "security.passwordUpdatedAt": row.passwordStamp,
      })
        .lean()
        .exec();
      if (user)
        void this.email
          .sendOtp({ to: user.normalizedEmail, code, purpose: "PASSWORD_RESET" })
          .catch(() => undefined);
    }
  }

  async verify(portal: Portal, challenge: string, code: string): Promise<{ resetToken: string }> {
    const now = new Date();
    const row = await PasswordRecoveryModel.findOneAndUpdate(
      {
        portal,
        challengeHash: digest(challenge),
        expiresAt: { $gt: now },
        attempts: { $lt: env.OTP_MAX_VERIFICATION_ATTEMPTS },
        resetHash: { $exists: false },
      },
      { $inc: { attempts: 1 } },
      { returnDocument: "after" },
    ).exec();
    if (!row?.userId || !safeCompare(row.otpHash, otpDigest(row._id, code)))
      throw new AuthError("OTP_INVALID", 400);
    const resetToken = createOpaqueToken();
    const claimed = await PasswordRecoveryModel.updateOne(
      {
        _id: row._id,
        portal,
        challengeHash: digest(challenge),
        otpHash: row.otpHash,
        expiresAt: { $gt: new Date() },
        resetHash: { $exists: false },
      },
      {
        $set: { resetHash: digest(resetToken), resetExpiresAt: new Date(Date.now() + 10 * 60000) },
        $unset: { otpHash: 1 },
      },
    );
    if (claimed.modifiedCount !== 1) throw new AuthError("OTP_INVALID", 400);
    return { resetToken };
  }

  async complete(portal: Portal, resetToken: string, newPassword: string): Promise<void> {
    const passwordHash = await this.hasher.hash(newPassword);
    await PasswordRecoveryModel.db.transaction(
      async (session) => {
        const row = await PasswordRecoveryModel.findOneAndUpdate(
          {
            portal,
            resetHash: digest(resetToken),
            resetExpiresAt: { $gt: new Date() },
            userId: { $exists: true },
          },
          { $unset: { resetHash: 1, resetExpiresAt: 1 } },
          { session, returnDocument: "before" },
        ).exec();
        if (!row?.userId || !row.passwordStamp) throw new AuthError("OTP_INVALID", 400);
        const result = await UserModel.updateOne(
          {
            _id: row.userId,
            role: { $in: roles(portal) },
            status: { $nin: ["SUSPENDED", "DELETED"] },
            passwordHash: { $exists: true, $ne: null },
            "security.passwordUpdatedAt": row.passwordStamp,
          },
          {
            $set: {
              passwordHash,
              "security.passwordUpdatedAt": new Date(
                Math.max(Date.now(), row.passwordStamp.getTime() + 1),
              ),
            },
            $inc: { authSessionVersion: 1, twoFactorVersion: 1 },
          },
          { session },
        );
        if (result.modifiedCount !== 1) throw new AuthError("OTP_INVALID", 400);
        await this.sessions.revokeAllForUser(row.userId, session);
      },
      { writeConcern: { w: "majority" } },
    );
  }
}
