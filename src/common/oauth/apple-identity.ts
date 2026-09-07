import { createRemoteJWKSet, jwtVerify } from "jose";

import { getAppleClientSecret } from "./apple-client-secret.js";

/**
 * Provider-level Sign in with Apple identity verification, shared by every Apple OAuth flow:
 * account linking (Settings) and login/signup (Customer + Business Owner portals).
 *
 * Apple is OIDC: the callback POSTs (`response_mode=form_post`) a `code` + an Apple-signed
 * `id_token` JWT + the `state` we issued + (first authorization only) a `user` JSON blob. This
 * resolver:
 *   1. verifies the POSTed `id_token` against Apple's JWKS (signature / iss / aud / exp) and that
 *      its `nonce` claim equals the nonce we signed into `state`;
 *   2. exchanges the `code` at Apple's token endpoint using an ES256 client-secret JWT
 *      (apple-client-secret.ts) — proves the code is real and issued to this Services ID;
 *   3. verifies the token-endpoint `id_token` the same way and asserts its `sub` matches (1);
 *   4. returns ONLY identity fields. `code`, `access_token`, `refresh_token` and both `id_token`s
 *      are discarded — never returned, never persisted, never logged.
 *
 * `email` is OPTIONAL: Apple only returns it on the first authorization for a Services ID and may
 * return a private-relay address. The resolver does not decide whether a missing email is fatal —
 * the linking / signup callers reject it; the existing-link login caller resolves by `sub`.
 */

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_AUTHORIZE_URL = "https://appleid.apple.com/auth/authorize";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";

/** Only the identity scopes. Requesting any scope forces `response_mode=form_post` (Apple rule). */
export const APPLE_OAUTH_SCOPES = ["name", "email"] as const;

export type AppleOAuthConfig = {
  clientId: string;
  redirectUri: string;
};

export type AppleVerifiedIdentity = {
  /** Apple's stable OIDC `sub` — the ONLY identity key. Never the email. */
  providerAccountId: string;
  email?: string;
  emailVerified: boolean;
  isPrivateEmail?: boolean;
  displayName?: string;
  firstName?: string;
  lastName?: string;
};

/**
 * Raised for any failure of {@link resolveAppleIdentity} — bad signature / issuer / audience /
 * expiry, a nonce that doesn't match the signed state, a missing `sub`, a failed code exchange,
 * or a `sub` mismatch between the callback and token-endpoint id_tokens. Deliberately coarse. A
 * missing email is NOT one of these.
 */
export class AppleIdentityError extends Error {
  public constructor() {
    super("Failed to resolve a verified Apple identity");
    this.name = "AppleIdentityError";
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL));
  }
  return jwks;
}

/** Test-only: forces a fresh JWKS on the next verify (paired with a `jose` mock). */
export function __resetAppleJwksCache(): void {
  jwks = null;
}

/** Apple sends `email_verified` / `is_private_email` as the string "true"/"false" OR a boolean. */
function truthyClaim(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * Splits an Apple first/last name (from the first-authorization `user` blob) into two non-empty
 * strings. Apple sends the name only once and never in the id_token, so the empty fallback
 * ("Apple" / "User") is expected on every login and every link — the user edits it in Profile.
 */
export const splitAppleName = (identity: {
  firstName?: string;
  lastName?: string;
  displayName?: string;
}): { firstName: string; lastName: string } => {
  const given = identity.firstName?.trim();
  const family = identity.lastName?.trim();

  if (given && family) {
    return { firstName: given, lastName: family };
  }

  const display = (identity.displayName ?? "").trim().replace(/\s+/g, " ");
  const firstSpace = display.indexOf(" ");
  const displayFirst = firstSpace === -1 ? display : display.slice(0, firstSpace);
  const displayLast = firstSpace === -1 ? display : display.slice(firstSpace + 1);

  if (given || family) {
    return {
      firstName: given || displayFirst || (family as string),
      lastName: family || displayLast || (given as string),
    };
  }

  if (!display) {
    return { firstName: "Apple", lastName: "User" };
  }

  return { firstName: displayFirst, lastName: displayLast || displayFirst };
};

export function buildAppleAuthUrl(config: AppleOAuthConfig, state: string, nonce: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    // `code id_token` gives us a verifiable id_token straight on the callback in addition to the
    // code we exchange; `form_post` is mandatory whenever a scope is requested.
    response_type: "code id_token",
    response_mode: "form_post",
    scope: APPLE_OAUTH_SCOPES.join(" "),
    state,
    nonce,
  });
  return `${APPLE_AUTHORIZE_URL}?${params.toString()}`;
}

type VerifiedClaims = {
  sub: string;
  email?: string;
  emailVerified: boolean;
  isPrivateEmail?: boolean;
};

async function verifyAppleIdToken(
  idToken: string,
  config: AppleOAuthConfig,
  expectedNonce: string,
): Promise<VerifiedClaims> {
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload } = await jwtVerify(idToken, getJwks(), {
      issuer: APPLE_ISSUER,
      audience: config.clientId,
    }));
  } catch {
    // Bad signature / issuer / audience / expiry / JWKS fetch — all collapse to one coarse error.
    throw new AppleIdentityError();
  }

  const sub = payload["sub"];
  const nonce = payload["nonce"];

  if (typeof sub !== "string" || sub.length === 0) {
    throw new AppleIdentityError();
  }
  if (typeof nonce !== "string" || nonce !== expectedNonce) {
    throw new AppleIdentityError();
  }

  const email = payload["email"];
  const hasEmail = typeof email === "string" && email.length > 0;

  return {
    sub,
    ...(hasEmail ? { email: email as string } : {}),
    emailVerified: hasEmail && truthyClaim(payload["email_verified"]),
    ...(hasEmail ? { isPrivateEmail: truthyClaim(payload["is_private_email"]) } : {}),
  };
}

async function exchangeCode(config: AppleOAuthConfig, code: string): Promise<string | null> {
  const clientSecret = await getAppleClientSecret();
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: config.redirectUri,
  });

  const response = await fetch(APPLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;

  if (!response.ok || !json) {
    throw new AppleIdentityError();
  }
  const idToken = json["id_token"];
  return typeof idToken === "string" && idToken.length > 0 ? idToken : null;
}

/**
 * @param params.code    the authorization code from the form_post body (exchanged with Apple).
 * @param params.idToken the id_token from the form_post body (optional cross-check).
 * @param params.nonce   the nonce that was signed into the Bookly OAuth state; must equal the
 *                       `nonce` claim of every Apple id_token in this exchange.
 */
export async function resolveAppleIdentity(
  config: AppleOAuthConfig,
  params: { code: string; idToken?: string | undefined; nonce: string },
): Promise<AppleVerifiedIdentity> {
  // Defense in depth: if Apple posted an id_token on the callback, verify it first.
  let callbackClaims: VerifiedClaims | undefined;
  if (params.idToken) {
    callbackClaims = await verifyAppleIdToken(params.idToken, config, params.nonce);
  }

  // Authoritative identity comes from the code exchange (proves possession of a real code).
  const exchangedIdToken = await exchangeCode(config, params.code);
  if (!exchangedIdToken) {
    throw new AppleIdentityError();
  }
  const claims = await verifyAppleIdToken(exchangedIdToken, config, params.nonce);

  if (callbackClaims && callbackClaims.sub !== claims.sub) {
    throw new AppleIdentityError();
  }

  // Prefer whichever verified token carried an email (Apple usually puts it on the exchanged one)
  // and take its verification / private-relay flags together.
  const emailSource = claims.email ? claims : callbackClaims?.email ? callbackClaims : undefined;
  const email = emailSource?.email;

  return {
    providerAccountId: claims.sub,
    ...(email ? { email } : {}),
    emailVerified: email ? (emailSource?.emailVerified ?? false) : false,
    ...(email ? { isPrivateEmail: emailSource?.isPrivateEmail ?? false } : {}),
  };
}

/**
 * Parses the first-authorization `user` form field (a JSON string) for name only. Never trusted
 * as identity. Malformed / absent → `{}`.
 */
export function parseAppleUserJson(userField: string | undefined): {
  firstName?: string;
  lastName?: string;
} {
  if (!userField) {
    return {};
  }
  try {
    const parsed = JSON.parse(userField) as { name?: { firstName?: unknown; lastName?: unknown } };
    const firstName = parsed?.name?.firstName;
    const lastName = parsed?.name?.lastName;
    return {
      ...(typeof firstName === "string" && firstName.trim() ? { firstName: firstName.trim() } : {}),
      ...(typeof lastName === "string" && lastName.trim() ? { lastName: lastName.trim() } : {}),
    };
  } catch {
    return {};
  }
}
