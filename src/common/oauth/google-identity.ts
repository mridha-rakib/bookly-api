import type { TokenPayload } from "google-auth-library";

import type { GoogleOAuthClient } from "./google-oauth-client.js";

/**
 * OIDC scopes — enough for a verifiable `id_token` carrying the account's stable `sub`, email +
 * verification status, and name. No Calendar / Drive / offline scopes: identity verification
 * never acts on the user's behalf, so no refresh token is requested and nothing is persisted.
 * Shared by every OIDC-only Google flow (account linking, Customer Google auth).
 */
export const GOOGLE_OIDC_SCOPES = ["openid", "email", "profile"];

/**
 * A Google identity proven via a verified `id_token`. `providerAccountId` is the OIDC `sub` — the
 * ONLY stable identity key (never the email). `firstName` / `lastName` come from `given_name` /
 * `family_name` when Google supplies them; callers fall back to splitting `displayName`.
 */
export type GoogleVerifiedIdentity = {
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
  firstName?: string;
  lastName?: string;
};

/**
 * Raised for any failure of {@link resolveGoogleIdentity} — a failed code exchange, a missing or
 * unverifiable `id_token`, or a payload without `sub`/`email`. Deliberately coarse: each feature
 * maps it to its own domain error, and OAuth callbacks only ever tell the browser "error".
 */
export class GoogleIdentityError extends Error {
  public constructor() {
    super("Failed to resolve a verified Google identity");
    this.name = "GoogleIdentityError";
  }
}

/**
 * Exchanges an authorization `code` for an `id_token` and verifies it against Google's keys
 * (signature / `aud` === our client id / `iss` / `exp`, all handled by `verifyIdToken`), then
 * returns only the identity fields. The token set itself is never returned or stored. Any failure
 * collapses to {@link GoogleIdentityError}.
 *
 * The shared core of `linked-account`'s `verifyGoogleAccountLinkCallback` and the Customer Google
 * auth callback — neither re-implements the exchange/verify dance.
 */
export async function resolveGoogleIdentity(
  client: GoogleOAuthClient,
  code: string,
): Promise<GoogleVerifiedIdentity> {
  let idToken: string | null | undefined;
  try {
    const tokens = await client.exchangeCode(code);
    idToken = tokens.id_token;
  } catch {
    throw new GoogleIdentityError();
  }

  if (!idToken) {
    throw new GoogleIdentityError();
  }

  let payload: TokenPayload | undefined;
  try {
    payload = await client.verifyIdToken(idToken);
  } catch {
    throw new GoogleIdentityError();
  }

  if (!payload?.sub || !payload.email) {
    throw new GoogleIdentityError();
  }

  return {
    providerAccountId: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    ...(payload.name ? { displayName: payload.name } : {}),
    ...(payload.given_name ? { firstName: payload.given_name } : {}),
    ...(payload.family_name ? { lastName: payload.family_name } : {}),
  };
}
