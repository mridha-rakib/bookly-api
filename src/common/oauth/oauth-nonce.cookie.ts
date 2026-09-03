import type { CookieOptions, Request, Response } from "express";

import { env } from "../../config/env.js";

const NONCE_TTL_MS = 10 * 60 * 1000;

const nonceCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.AUTH_COOKIE_SECURE,
  // Pinned to "lax" (NOT AUTH_COOKIE_SAME_SITE): the cookie must ride along on the top-level GET
  // navigation Google makes back to our callback, which "strict" would drop.
  sameSite: "lax",
  path: env.AUTH_COOKIE_PATH,
  ...(env.AUTH_COOKIE_DOMAIN ? { domain: env.AUTH_COOKIE_DOMAIN } : {}),
});

export type OAuthNonceCookie = {
  set: (response: Response, nonce: string) => void;
  clear: (response: Response) => void;
  read: (request: Request) => string | undefined;
};

/**
 * A short-lived, httpOnly cookie that carries the OAuth `state` nonce for one Google sign-in
 * flow: set by `start`, read-and-cleared by `callback`, compared against the nonce inside the
 * signed state (CSRF / login-fixation protection). Each flow passes its own `cookieName` so a
 * customer flow and a professional flow started in the same browser never clobber each other.
 * Same path / domain / secure settings as the refresh cookie.
 */
export const createOAuthNonceCookie = (cookieName: string): OAuthNonceCookie => ({
  set: (response, nonce) => {
    response.cookie(cookieName, nonce, { ...nonceCookieOptions(), maxAge: NONCE_TTL_MS });
  },

  clear: (response) => {
    response.clearCookie(cookieName, nonceCookieOptions());
  },

  read: (request) => {
    const cookieHeader = request.headers.cookie;

    if (!cookieHeader) {
      return undefined;
    }

    const prefix = `${cookieName}=`;
    const match = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix));

    return match ? decodeURIComponent(match.slice(prefix.length)) : undefined;
  },
});
