import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";

import {
  clearRefreshCookie,
  getRefreshCookieOptions,
  getRefreshTokenFromRequest,
  setRefreshCookie,
} from "../../src/modules/auth/auth.cookies.js";

type CookieCall = {
  name: string;
  value?: string;
  options: Record<string, unknown>;
};

const createResponse = () => {
  const calls: CookieCall[] = [];
  return {
    calls,
    response: {
      cookie(name: string, value: string, options: Record<string, unknown>) {
        calls.push({ name, value, options });
      },
      clearCookie(name: string, options: Record<string, unknown>) {
        calls.push({ name, options });
      },
    },
  };
};

describe("auth cookies", () => {
  it("sets and clears the same refresh cookie identity without undefined maxAge", () => {
    const set = createResponse();
    const cleared = createResponse();

    setRefreshCookie(set.response as unknown as Response, "raw-refresh-token");
    clearRefreshCookie(cleared.response as unknown as Response);

    expect(set.calls[0]?.name).toBe(cleared.calls[0]?.name);
    expect(cleared.calls[0]?.options).not.toHaveProperty("maxAge");
    expect(cleared.calls[0]?.options["path"]).toBe(getRefreshCookieOptions().path);
    expect(cleared.calls[0]?.options["httpOnly"]).toBe(true);
  });

  it("reads refresh token only from the configured cookie", () => {
    const token = getRefreshTokenFromRequest({
      headers: { cookie: "other=value; bookly_refresh_token=abc%20123" },
    } as unknown as Request);

    expect(token).toBe("abc 123");
  });
});
