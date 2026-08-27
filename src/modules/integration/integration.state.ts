import { createHash } from "node:crypto";

import { jwtVerify, SignJWT } from "jose";

import { env } from "../../config/env.js";
import { IntegrationError } from "./integration.errors.js";

const STATE_TTL = "10m";

/**
 * Derives a dedicated signing key from GOOGLE_CLIENT_SECRET rather than reusing an unrelated
 * secret (JWT_ACCESS_TOKEN_SECRET/OTP_HASH_SECRET) for a different purpose. Only ever called
 * once GOOGLE_CLIENT_SECRET is confirmed present (see requireGoogleOAuthConfig in
 * integration.google-client.ts).
 */
function signingKey(): Uint8Array {
  return createHash("sha256")
    .update(`google-calendar-oauth-state:${env.GOOGLE_CLIENT_SECRET}`)
    .digest();
}

export type OAuthStatePayload = {
  businessId: string;
  userId: string;
};

/**
 * Binds the OAuth `state` param to the authenticated Business Owner + business that initiated
 * Connect (CSRF / cross-business-account-linking protection — see auth.middleware.ts's own
 * ownership pattern). Verified on callback before any token exchange happens.
 */
export async function signOAuthState(payload: OAuthStatePayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(STATE_TTL)
    .sign(signingKey());
}

export async function verifyOAuthState(token: string): Promise<OAuthStatePayload> {
  try {
    const result = await jwtVerify(token, signingKey());
    const businessId = result.payload["businessId"];
    const userId = result.payload["userId"];

    if (typeof businessId !== "string" || typeof userId !== "string") {
      throw new Error("Invalid state payload");
    }

    return { businessId, userId };
  } catch {
    throw new IntegrationError("GOOGLE_CALENDAR_INVALID_STATE", 400);
  }
}
