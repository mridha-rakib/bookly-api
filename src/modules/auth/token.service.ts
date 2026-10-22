import { randomUUID } from "node:crypto";

import { jwtVerify, SignJWT } from "jose";
import { type ClientSession, Types } from "mongoose";

import { env } from "../../config/env.js";
import type { SessionRepository } from "../session/session.repository.js";
import { type UserRole, userRoles } from "../user/user.types.js";
import { AuthError } from "./auth.errors.js";
import { addDays, addMinutes, createOpaqueToken, sha256 } from "./auth.utils.js";

export type AccessTokenClaims = {
  sub: string;
  role: UserRole;
  /** Refresh-token family that issued this access token. Absent only on legacy tokens. */
  sid?: string | undefined;
  /** Issued-at, seconds since epoch. */
  iat?: number | undefined;
};

export type RefreshTokenResult = {
  refreshToken: string;
  expiresAt: Date;
  tokenFamilyId: string;
};

export type TokenServiceOptions = {
  /** Accept access tokens without `sid` when issued before `legacyCutoff` (migration only). */
  legacyAccessTokenGrace?: boolean;
  legacyCutoff?: Date;
};

// Tokens without `sid` can only have been signed by pre-Phase-1A code, i.e. before this process
// started. The grace therefore expires on its own one access-token TTL after startup.
const processStartedAt = new Date();

export class TokenService {
  private readonly signingSecret = new TextEncoder().encode(env.JWT_ACCESS_TOKEN_SECRET);
  private readonly legacyAccessTokenGrace: boolean;
  private readonly legacyCutoffSeconds: number;

  public constructor(
    private readonly sessionRepository: SessionRepository,
    options: TokenServiceOptions = {},
  ) {
    this.legacyAccessTokenGrace =
      options.legacyAccessTokenGrace ?? env.AUTH_ACCESS_TOKEN_LEGACY_GRACE;
    this.legacyCutoffSeconds = Math.floor(
      (options.legacyCutoff ?? processStartedAt).getTime() / 1000,
    );
  }

  /** Every access token is bound to the refresh-token family that issued it (`sid`), so
   * revoking the family also ends the access token — see isAccessTokenSessionLive. */
  public async createAccessToken(input: {
    userId: Types.ObjectId | string;
    role: UserRole;
    sessionFamilyId: string;
  }): Promise<string> {
    if (typeof input.sessionFamilyId !== "string" || input.sessionFamilyId.length === 0) {
      throw new Error("Access tokens must be bound to a session family");
    }

    return new SignJWT({ role: input.role, sid: input.sessionFamilyId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(input.userId))
      .setIssuedAt()
      .setExpirationTime(`${env.JWT_ACCESS_TOKEN_TTL_MINUTES}m`)
      .sign(this.signingSecret);
  }

  public async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const result = await jwtVerify(token, this.signingSecret, { algorithms: ["HS256"] });
    const subject = result.payload.sub;
    const role = result.payload["role"];
    const sid = result.payload["sid"];

    if (
      !subject ||
      !Types.ObjectId.isValid(subject) ||
      typeof role !== "string" ||
      !userRoles.includes(role as UserRole) ||
      (sid !== undefined && (typeof sid !== "string" || sid.length === 0))
    ) {
      throw new Error("Invalid token claims");
    }

    return { sub: subject, role: role as UserRole, sid, iat: result.payload.iat };
  }

  /**
   * Whether the session behind a verified access token can still authenticate. A bound token is
   * live only while its family has an unrevoked, unexpired refresh row for the same user — the
   * same state logout/rotation/reuse detection write. Database errors propagate to the caller so
   * they are never mistaken for a revoked session.
   */
  public async isAccessTokenSessionLive(claims: AccessTokenClaims): Promise<boolean> {
    if (claims.sid !== undefined) {
      return this.sessionRepository.hasLiveFamily(claims.sid, claims.sub);
    }

    return (
      this.legacyAccessTokenGrace &&
      claims.iat !== undefined &&
      claims.iat <= this.legacyCutoffSeconds
    );
  }

  public async createRefreshSession(
    input: {
      userId: Types.ObjectId;
      userAgent?: string;
      ipAddress?: string;
    },
    session?: ClientSession,
  ): Promise<RefreshTokenResult> {
    const refreshToken = createOpaqueToken();
    const expiresAt = addDays(new Date(), env.REFRESH_TOKEN_TTL_DAYS);
    const tokenFamilyId = randomUUID();

    const createInput = {
      userId: input.userId,
      refreshTokenHash: sha256(refreshToken),
      tokenFamilyId,
      expiresAt,
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
    };

    await this.sessionRepository.create(createInput, session);

    return { refreshToken, expiresAt, tokenFamilyId };
  }

  public async rotateRefreshToken(refreshToken: string): Promise<{
    userId: Types.ObjectId;
    refreshToken: string;
    expiresAt: Date;
    tokenFamilyId: string;
  }> {
    const existing = await this.sessionRepository.findByRefreshTokenHash(sha256(refreshToken));

    if (!existing || existing.expiresAt <= new Date()) {
      throw new Error("SESSION_EXPIRED");
    }

    if (existing.revokedAt) {
      await this.sessionRepository.revokeFamily(existing.tokenFamilyId);
      throw new Error("REFRESH_TOKEN_REUSED");
    }

    const nextRefreshToken = createOpaqueToken();
    const expiresAt = addDays(new Date(), env.REFRESH_TOKEN_TTL_DAYS);
    try {
      await this.sessionRepository.rotate(existing, sha256(nextRefreshToken), expiresAt);
    } catch (error) {
      // A concurrent loser is also reuse: revoke its winner's family after rollback.
      if (error instanceof Error && error.message === "REFRESH_TOKEN_REUSED") {
        await this.sessionRepository.revokeFamily(existing.tokenFamilyId);
      }
      throw error;
    }

    return {
      userId: existing.userId,
      refreshToken: nextRefreshToken,
      expiresAt,
      tokenFamilyId: existing.tokenFamilyId,
    };
  }

  public getAccessTokenExpiresAt(): Date {
    return addMinutes(new Date(), env.JWT_ACCESS_TOKEN_TTL_MINUTES);
  }

  public async revokeRefreshToken(refreshToken: string): Promise<void> {
    const existing = await this.sessionRepository.findByRefreshTokenHash(sha256(refreshToken));

    if (existing) {
      // Logout is local to the cookie's device session, including all rotated successors.
      await this.sessionRepository.revokeFamily(existing.tokenFamilyId);
    }
  }

  /** The expected ID is correlation only; possession of a known cookie proves the target.
   * Consumed/revoked/expired rows can still prove ownership while retained in the database.
   * Repeating the transaction after a lost response is safe, including rotated descendants. */
  public async revokeIntendedFamily(
    refreshToken: string | undefined,
    expectedFamilyId: string,
  ): Promise<void> {
    const existing = refreshToken
      ? await this.sessionRepository.findByRefreshTokenHash(sha256(refreshToken))
      : null;
    if (!existing) throw new AuthError("LOGOUT_UNVERIFIABLE", 409);
    if (existing.tokenFamilyId !== expectedFamilyId) {
      throw new AuthError("LOGOUT_FAMILY_MISMATCH", 409);
    }
    await this.sessionRepository.revokeFamily(existing.tokenFamilyId);
  }

  public async revokeAllSessionsForUser(userId: Types.ObjectId): Promise<void> {
    await this.sessionRepository.revokeAllForUser(userId);
  }

  /**
   * Phase 1 (session hardening) — after a password change: revoke every OTHER active refresh
   * session for this user, preserving the caller's own. `currentRefreshToken` is the raw value
   * read from the httpOnly refresh cookie on THIS request (never a client-supplied id) — its hash
   * is looked up the same way `/auth/refresh` resolves a session, so "current" is proven by
   * possession of the cookie, not asserted by the client. Falls back to revoking every session
   * (including the caller's) when the cookie is absent or doesn't resolve to a live session for
   * this user — the safe default rather than leaving anything un-revoked.
   */
  public async revokeOtherSessionsForUser(
    userId: Types.ObjectId,
    currentRefreshToken?: string,
  ): Promise<void> {
    const current = currentRefreshToken
      ? await this.sessionRepository.findByRefreshTokenHash(sha256(currentRefreshToken))
      : null;

    if (!current || !current.userId.equals(userId) || current.revokedAt) {
      await this.sessionRepository.revokeAllForUser(userId);
      return;
    }

    await this.sessionRepository.revokeAllForUserExcept(userId, current._id);
  }
}
