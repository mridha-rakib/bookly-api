import type { CookieOptions, Request, Response } from "express";

import { env } from "../../config/env.js";

/**
 * Short-lived, httpOnly cookie holding the OAuth `state` nonce for the Customer Google flow. Set
 * by `start`, required-and-cleared by `callback`. `sameSite` is pinned to `"lax"` (NOT read from
 * AUTH_COOKIE_SAME_SITE): the cookie must ride along on the top-level GET navigation Google makes
 * back to our callback, which `"strict"` would drop. Same name family / path / domain as the
 * refresh cookie so it reaches exactly the `/auth` subtree and nothing else.
 */
const NONCE_COOKIE_NAME = `${env.AUTH_COOKIE_NAME}_oauth_nonce`;
const NONCE_TTL_MS = 10 * 60 * 1000;

const nonceCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.AUTH_COOKIE_SECURE,
  sameSite: "lax",
  path: env.AUTH_COOKIE_PATH,
  ...(env.AUTH_COOKIE_DOMAIN ? { domain: env.AUTH_COOKIE_DOMAIN } : {}),
});

export const setOAuthNonceCookie = (response: Response, nonce: string): void => {
  response.cookie(NONCE_COOKIE_NAME, nonce, { ...nonceCookieOptions(), maxAge: NONCE_TTL_MS });
};

export const clearOAuthNonceCookie = (response: Response): void => {
  response.clearCookie(NONCE_COOKIE_NAME, nonceCookieOptions());
};

export const readOAuthNonceCookie = (request: Request): string | undefined => {
  const cookieHeader = request.headers.cookie;

  if (!cookieHeader) {
    return undefined;
  }

  const prefix = `${NONCE_COOKIE_NAME}=`;
  const match = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));

  return match ? decodeURIComponent(match.slice(prefix.length)) : undefined;
};
