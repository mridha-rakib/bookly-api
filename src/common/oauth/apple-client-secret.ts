import { importPKCS8, SignJWT } from "jose";

import { env } from "../../config/env.js";

/**
 * Sign in with Apple has no static client secret. The value passed as `client_secret` to Apple's
 * token endpoint is a short-lived ES256 JWT signed with the developer's `.p8` key:
 *
 *   header: { alg: "ES256", kid: APPLE_KEY_ID }
 *   claims: { iss: APPLE_TEAM_ID, sub: APPLE_CLIENT_ID, aud: "https://appleid.apple.com",
 *             iat, exp }   (exp within Apple's 6-month / 15777000s maximum)
 *
 * `APPLE_PRIVATE_KEY` is stored base64-encoded (single-line) and decoded here to the PKCS#8 PEM.
 * The generated secret is cached in memory with its expiry and regenerated shortly before it
 * lapses — never persisted, never logged.
 */

const APPLE_AUDIENCE = "https://appleid.apple.com";
/** ~5 months — comfortably under Apple's 6-month cap, long enough that regeneration is rare. */
const SECRET_TTL_SECONDS = 150 * 24 * 60 * 60;
/** Regenerate this long before expiry so an in-flight request never uses a just-expired secret. */
const RENEW_SKEW_SECONDS = 24 * 60 * 60;

export class AppleClientSecretError extends Error {
  public constructor() {
    super("Failed to generate the Apple client secret");
    this.name = "AppleClientSecretError";
  }
}

/** True only when every credential needed to sign the client secret is present. */
export function isAppleClientSecretConfigured(): boolean {
  return Boolean(
    env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY,
  );
}

function decodePrivateKeyPem(): string {
  const raw = env.APPLE_PRIVATE_KEY;
  if (!raw) {
    throw new AppleClientSecretError();
  }
  const pem = Buffer.from(raw, "base64").toString("utf8").replace(/\\n/g, "\n").trim();
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) {
    throw new AppleClientSecretError();
  }
  return pem;
}

let cached: { secret: string; expEpochSeconds: number } | null = null;

/** Test-only: drops the in-memory cache so a fresh secret is signed on the next call. */
export function __resetAppleClientSecretCache(): void {
  cached = null;
}

/**
 * Returns a valid Apple client-secret JWT, minting a new one only when the cache is empty or
 * within {@link RENEW_SKEW_SECONDS} of expiring. Any missing/invalid credential throws
 * {@link AppleClientSecretError} — the private key material is never included in the error.
 */
export async function getAppleClientSecret(): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (cached && cached.expEpochSeconds - nowSeconds > RENEW_SKEW_SECONDS) {
    return cached.secret;
  }

  const { APPLE_CLIENT_ID: clientId, APPLE_TEAM_ID: teamId, APPLE_KEY_ID: keyId } = env;
  if (!clientId || !teamId || !keyId) {
    throw new AppleClientSecretError();
  }

  let secret: string;
  const expEpochSeconds = nowSeconds + SECRET_TTL_SECONDS;
  try {
    const privateKey = await importPKCS8(decodePrivateKeyPem(), "ES256");
    secret = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: keyId })
      .setIssuer(teamId)
      .setSubject(clientId)
      .setAudience(APPLE_AUDIENCE)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(expEpochSeconds)
      .sign(privateKey);
  } catch (error) {
    if (error instanceof AppleClientSecretError) {
      throw error;
    }
    // Swallow the underlying jose/crypto error so no key material can leak through a message.
    throw new AppleClientSecretError();
  }

  cached = { secret, expEpochSeconds };
  return secret;
}
