import type { ClientSession, Types } from "mongoose";

import type { UserRole } from "../user/user.types.js";
import type { TokenService } from "./token.service.js";

/** User-agent / IP captured from the request, threaded into the persisted refresh session. */
export type RequestContext = {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
};

/**
 * The authenticated-session payload every login/registration path returns. The controller strips
 * `refreshToken` (it goes into the httpOnly cookie, never the JSON body) — see
 * AuthController.withoutRefreshToken / setRefreshCookie.
 */
export type AuthResult = {
  accessToken: string;
  accessTokenExpiresAt: string;
  user: {
    id: string;
    email: string;
    role: UserRole;
    status: string;
  };
  refreshToken: string;
};

/**
 * Issues an access token + a persisted, rotating refresh session for an already-identified user.
 * The one place session issuance is assembled, so every entry point (password login, OTP
 * registration completion, Customer Google auth) produces an identical {@link AuthResult} and
 * shares the exact same TokenService-backed session/refresh/rotation machinery. `session` runs
 * the refresh-session insert inside a Mongo transaction when the caller has one open.
 */
export async function issueAuthSession(
  tokenService: TokenService,
  user: { userId: Types.ObjectId; email: string; role: UserRole; status: string },
  context: RequestContext,
  session?: ClientSession,
): Promise<AuthResult> {
  const accessToken = await tokenService.createAccessToken({
    userId: user.userId,
    role: user.role,
  });

  const refreshSession = await tokenService.createRefreshSession(
    {
      userId: user.userId,
      ...(context.userAgent ? { userAgent: context.userAgent } : {}),
      ...(context.ipAddress ? { ipAddress: context.ipAddress } : {}),
    },
    session,
  );

  return {
    accessToken,
    accessTokenExpiresAt: tokenService.getAccessTokenExpiresAt().toISOString(),
    refreshToken: refreshSession.refreshToken,
    user: {
      id: String(user.userId),
      email: user.email,
      role: user.role,
      status: user.status,
    },
  };
}
