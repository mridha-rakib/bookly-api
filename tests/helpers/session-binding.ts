import type { Express } from "express";
import { decodeJwt } from "jose";
import request, { type Response } from "supertest";
import { expect } from "vitest";

import { env } from "../../src/config/env.js";
import type { UserRole } from "../../src/modules/user/user.types.js";

/** The `name=value` pair of the refresh cookie a response set, for replaying it explicitly. */
export const refreshCookieFrom = (response: Response): string => {
  const header = response.headers["set-cookie"] as unknown;
  const cookies = Array.isArray(header) ? (header as string[]) : header ? [String(header)] : [];
  const cookie = cookies.find((value) => value.startsWith(`${env.AUTH_COOKIE_NAME}=`));
  if (!cookie) {
    throw new Error("Response did not set the refresh cookie");
  }
  return cookie.split(";")[0] ?? "";
};

/**
 * Phase 1A end-to-end contract for any session-issuing flow (password, registration, OAuth,
 * invitation): the session's refresh cookie yields an access token bound to its family (`sid`)
 * that authenticates, and an acknowledged logout makes that unexpired token fail authentication.
 */
export const expectSessionRevokedByLogout = async (
  app: Express,
  sessionResponse: Response,
  role: UserRole,
): Promise<void> => {
  const refreshed = await request(app)
    .post("/api/v1/auth/refresh")
    .set("Cookie", refreshCookieFrom(sessionResponse));
  expect(refreshed.status).toBe(200);
  const accessToken = refreshed.body.data.accessToken as string;
  expect(decodeJwt(accessToken)).toMatchObject({ role, sid: expect.any(String) });
  const cookie = refreshCookieFrom(refreshed);
  const bearer = `Bearer ${accessToken}`;

  const before = await request(app).get("/api/v1/auth/me").set("Authorization", bearer);
  expect(before.status).toBe(200);
  expect(before.body.data.user.role).toBe(role);

  const intent = {
    intentId: "session-binding-regression",
    familyId: decodeJwt(accessToken)["sid"],
  };
  const logout = await request(app).post("/api/v1/auth/logout").set("Cookie", cookie).send(intent);
  expect(logout.status).toBe(200);
  expect(logout.body.data).toEqual({ ...intent, outcome: "revoked" });
  expect(logout.headers["set-cookie"]).toBeUndefined();

  const after = await request(app).get("/api/v1/auth/me").set("Authorization", bearer);
  expect(after.status).toBe(401);
  expect(after.body.errors?.[0]?.code).toBe("SESSION_EXPIRED");
  const refreshAfter = await request(app).post("/api/v1/auth/refresh").set("Cookie", cookie);
  expect(refreshAfter.status).toBe(401);
};
