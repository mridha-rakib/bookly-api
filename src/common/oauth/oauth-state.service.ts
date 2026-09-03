import { createHash } from "node:crypto";

import { jwtVerify, SignJWT } from "jose";

/** Raw, decoded `state` claims. Callers validate the individual fields they expect. */
export type OAuthStateClaims = Record<string, unknown>;

/**
 * Thrown by {@link OAuthStateService.verify} on any signature / expiry / structural failure.
 * Feature modules catch this and re-throw their own existing domain error so HTTP status codes
 * and error codes stay exactly as they were before this service existed.
 */
export class OAuthStateError extends Error {
  public constructor() {
    super("Invalid OAuth state");
    this.name = "OAuthStateError";
  }
}

/**
 * Signs and verifies the short-lived, HMAC-signed `state` parameter that binds an OAuth redirect
 * back to the server-side context that started it (CSRF / cross-account-linking protection).
 *
 * Feature-agnostic on purpose — it owns ONLY the JWT mechanics shared by every Google OAuth flow
 * in this codebase (Calendar integration, account linking, and future Google login):
 *  - deriving a dedicated HS256 key from `keyContext` + `keyMaterial` (so each feature namespaces
 *    its own key and never reuses an unrelated secret),
 *  - signing a payload with an `iat` and a bounded expiry,
 *  - verifying signature + expiry and returning the raw claims (or throwing {@link OAuthStateError}).
 *
 * It does NOT know which env var supplies the secret, what the payload shape is, or how a failure
 * maps to a domain error — every feature keeps that. Replaces the byte-identical copies that lived
 * in `integration.state.ts` and `linked-account.state.ts`.
 */
export class OAuthStateService {
  private readonly key: Uint8Array;
  private readonly ttl: string;

  /**
   * @param keyContext stable, feature-specific label prefixed onto the key derivation (e.g.
   *   `"google-calendar-oauth-state"`). Changing it invalidates every previously-issued state.
   * @param keyMaterial the raw secret the key is derived from (in practice the Google client
   *   secret). Passed straight through the same `sha256(`${keyContext}:${keyMaterial}`)`
   *   derivation the two former copies used, so existing signed states keep verifying.
   * @param ttl jose duration string for the token lifetime. Defaults to the 10 minutes both
   *   former copies used.
   */
  public constructor(keyContext: string, keyMaterial: string, ttl = "10m") {
    this.key = createHash("sha256").update(`${keyContext}:${keyMaterial}`).digest();
    this.ttl = ttl;
  }

  public async sign(payload: OAuthStateClaims): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(this.ttl)
      .sign(this.key);
  }

  public async verify(token: string): Promise<OAuthStateClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key);
      return payload;
    } catch {
      throw new OAuthStateError();
    }
  }
}
