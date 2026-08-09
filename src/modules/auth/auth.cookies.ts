import type { CookieOptions, Request, Response } from "express";

import { env } from "../../config/env.js";

export const getRefreshCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: env.AUTH_COOKIE_SECURE,
  sameSite: env.AUTH_COOKIE_SAME_SITE,
  path: env.AUTH_COOKIE_PATH,
  ...(env.AUTH_COOKIE_DOMAIN ? { domain: env.AUTH_COOKIE_DOMAIN } : {}),
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
});

export const setRefreshCookie = (response: Response, refreshToken: string): void => {
  response.cookie(env.AUTH_COOKIE_NAME, refreshToken, getRefreshCookieOptions());
};

export const clearRefreshCookie = (response: Response): void => {
  const { maxAge: _maxAge, ...options } = getRefreshCookieOptions();
  response.clearCookie(env.AUTH_COOKIE_NAME, options);
};

export const getRefreshTokenFromRequest = (request: Request): string | undefined => {
  const cookieHeader = request.headers.cookie;

  if (!cookieHeader) {
    return undefined;
  }

  const cookies = cookieHeader.split(";").map((cookie) => cookie.trim());
  const prefix = `${env.AUTH_COOKIE_NAME}=`;
  const cookie = cookies.find((candidate) => candidate.startsWith(prefix));

  if (!cookie) {
    return undefined;
  }

  return decodeURIComponent(cookie.slice(prefix.length));
};
