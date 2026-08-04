import { randomUUID } from "node:crypto";

import { jwtVerify, SignJWT } from "jose";
import type { Types } from "mongoose";

import { env } from "../../config/env.js";
import type { SessionRepository } from "../session/session.repository.js";
import type { UserRole } from "../user/user.types.js";
import { addDays, addMinutes, createOpaqueToken, sha256 } from "./auth.utils.js";

export type AccessTokenClaims = {
  sub: string;
  role: UserRole;
};

export type RefreshTokenResult = {
  refreshToken: string;
  expiresAt: Date;
};

export class TokenService {
  private readonly signingSecret = new TextEncoder().encode(env.JWT_ACCESS_TOKEN_SECRET);

  public constructor(private readonly sessionRepository: SessionRepository) {}

  public async createAccessToken(input: {
    userId: Types.ObjectId | string;
    role: UserRole;
  }): Promise<string> {
    return new SignJWT({ role: input.role })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(input.userId))
      .setIssuedAt()
      .setExpirationTime(`${env.JWT_ACCESS_TOKEN_TTL_MINUTES}m`)
      .sign(this.signingSecret);
  }

  public async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const result = await jwtVerify(token, this.signingSecret);
    const subject = result.payload.sub;
    const role = result.payload["role"];

    if (!subject || typeof role !== "string") {
      throw new Error("Invalid token claims");
    }

    return { sub: subject, role: role as UserRole };
  }

  public async createRefreshSession(input: {
    userId: Types.ObjectId;
    userAgent?: string;
    ipAddress?: string;
  }): Promise<RefreshTokenResult> {
    const refreshToken = createOpaqueToken();
    const expiresAt = addDays(new Date(), env.REFRESH_TOKEN_TTL_DAYS);

    const createInput = {
      userId: input.userId,
      refreshTokenHash: sha256(refreshToken),
      tokenFamilyId: randomUUID(),
      expiresAt,
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
    };

    await this.sessionRepository.create(createInput);

    return { refreshToken, expiresAt };
  }

  public async rotateRefreshToken(refreshToken: string): Promise<{
    userId: Types.ObjectId;
    refreshToken: string;
    expiresAt: Date;
  }> {
    const existing = await this.sessionRepository.findByRefreshTokenHash(sha256(refreshToken));

    if (!existing || existing.expiresAt <= new Date()) {
      throw new Error("SESSION_EXPIRED");
    }

    if (existing.revokedAt) {
      throw new Error("REFRESH_TOKEN_REUSED");
    }

    const nextRefreshToken = createOpaqueToken();
    const expiresAt = addDays(new Date(), env.REFRESH_TOKEN_TTL_DAYS);
    await this.sessionRepository.rotate(existing, sha256(nextRefreshToken), expiresAt);

    return {
      userId: existing.userId,
      refreshToken: nextRefreshToken,
      expiresAt,
    };
  }

  public getAccessTokenExpiresAt(): Date {
    return addMinutes(new Date(), env.JWT_ACCESS_TOKEN_TTL_MINUTES);
  }

  public async revokeRefreshToken(refreshToken: string): Promise<void> {
    const existing = await this.sessionRepository.findByRefreshTokenHash(sha256(refreshToken));

    if (existing) {
      await this.sessionRepository.revoke(existing._id);
    }
  }
}
