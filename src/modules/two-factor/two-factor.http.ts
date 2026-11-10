import type { Request, Response } from "express";

import { env } from "../../config/env.js";
import { clearRefreshCookie, getRefreshCookieOptions } from "../auth/auth.cookies.js";
import { AuthError } from "../auth/auth.errors.js";

const tokens = new WeakMap<TwoFactorRequired, string>();
export class TwoFactorRequired extends AuthError {
  public constructor(token: string) {
    super("TWO_FACTOR_REQUIRED", 428);
    tokens.set(this, token);
  }
}
const cookieName = "bookly_2fa_challenge";
const options = () => ({ ...getRefreshCookieOptions(), maxAge: 5 * 60_000 });
export const setChallengeCookie = (res: Response, error: TwoFactorRequired) => {
  clearRefreshCookie(res);
  res.cookie(cookieName, tokens.get(error), options());
  res.setHeader("Cache-Control", "no-store");
};
export const clearChallengeCookie = (res: Response) => {
  const { maxAge: _, ...rest } = options();
  res.clearCookie(cookieName, rest);
};
export const readChallengeCookie = (req: Request): string => {
  const origin = req.headers.origin;
  if (origin && origin !== new URL(env.FRONTEND_BASE_URL).origin)
    throw new AuthError("TWO_FACTOR_INVALID", 403);
  const raw = req.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  if (!raw || !/^[a-f0-9]{64}$/.test(raw)) throw new AuthError("TWO_FACTOR_INVALID", 400);
  return raw;
};
