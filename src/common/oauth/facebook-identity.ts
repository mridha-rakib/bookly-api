import { createHmac } from "node:crypto";

/**
 * Provider-level Facebook (Meta) identity verification, shared by every Facebook OAuth flow:
 * account linking (Settings) and login/signup (Customer + Business Owner portals). There is no
 * first-party Meta SDK in this project, so the three Graph calls are plain `fetch` against a
 * pinned Graph API version.
 *
 * Security guarantees (identical for every caller — never weaken one without the others):
 *  - authorization-code exchange for a short-lived USER access token;
 *  - `debug_token` introspection: `data.is_valid === true`, `data.app_id === clientId`
 *    (the token was minted for THIS Meta app), `data.user_id` present;
 *  - `/me` read with `appsecret_proof` (HMAC-SHA256 of the token keyed by the app secret);
 *  - `/me.id === debug_token.data.user_id` (the profile is the same subject that was introspected);
 *  - `providerAccountId` is the Facebook app-scoped user id — stable per (user, app), never the email.
 *
 * The USER access token is used only in-process for those two reads and is then discarded — it is
 * never returned to a caller, never persisted, never logged. `email` is returned OPTIONALLY: the
 * resolver does not decide whether a missing email is fatal — the linking caller rejects it, the
 * signup caller rejects it, and the existing-link login caller does not care (the account is
 * resolved by `providerAccountId`).
 */

/** Pinned Graph API version — bump deliberately, never float. */
const GRAPH_VERSION = "v23.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const OAUTH_DIALOG = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;

/**
 * Minimum identity scopes only. `public_profile` yields the stable app-scoped id + name;
 * `email` yields the account email when the user has a confirmed one and grants the permission.
 * NO pages_*, publish_*, business_management, user_friends, ads_* — identity verification needs
 * none of them.
 */
export const FACEBOOK_OAUTH_SCOPES = ["email", "public_profile"] as const;

export type FacebookOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

/**
 * A Facebook identity proven via token introspection + a minimal profile read. `providerAccountId`
 * is the app-scoped user id — the ONLY stable identity key. `email` is present only when Facebook
 * returned a confirmed one for the granted `email` scope; `emailVerified` is `true` whenever an
 * `email` is present (Facebook only surfaces an email after it has confirmed ownership).
 */
export type FacebookVerifiedIdentity = {
  providerAccountId: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
  firstName?: string;
  lastName?: string;
};

/**
 * Raised for any failure of {@link resolveFacebookIdentity} — a failed code exchange, an invalid
 * token, a token for a different Meta app, or a profile whose id disagrees with the introspected
 * subject. Deliberately coarse: each feature maps it to its own domain error, and OAuth callbacks
 * only ever tell the browser "error". A missing email is NOT one of these — see the type above.
 */
export class FacebookIdentityError extends Error {
  public constructor() {
    super("Failed to resolve a verified Facebook identity");
    this.name = "FacebookIdentityError";
  }
}

/** Splits a Facebook `name` into non-empty first/last names (UserProfile requires both). Facebook
 * `public_profile` always returns `name`, so the empty fallback is defensive only — and it never
 * borrows Google's "Google User". */
export const splitFacebookName = (identity: {
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
    return { firstName: "Facebook", lastName: "User" };
  }

  return { firstName: displayFirst, lastName: displayLast || displayFirst };
};

export function buildFacebookAuthUrl(
  config: Pick<FacebookOAuthConfig, "clientId" | "redirectUri">,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state,
    response_type: "code",
    scope: FACEBOOK_OAUTH_SCOPES.join(","),
  });

  return `${OAUTH_DIALOG}?${params.toString()}`;
}

/**
 * SHA-256 HMAC of the user access token keyed by the app secret. Facebook recommends this on
 * server-side Graph calls so a leaked user token alone can't be replayed from another app context.
 */
function appSecretProof(accessToken: string, clientSecret: string): string {
  return createHmac("sha256", clientSecret).update(accessToken).digest("hex");
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: "GET" });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;

  if (!response.ok || !body) {
    throw new FacebookIdentityError();
  }

  return body;
}

/**
 * Exchanges the authorization `code` for a verified Facebook identity:
 *  1. code → user access token (token endpoint)
 *  2. `debug_token` introspection — valid AND minted for THIS app (`app_id` match) AND has a user id
 *  3. `/me?fields=id,name,email,first_name,last_name` (with appsecret_proof) — the minimal profile
 *
 * The token is never returned or stored. Any failure collapses to {@link FacebookIdentityError};
 * a missing email is returned as `email: undefined`, not an error.
 */
export async function resolveFacebookIdentity(
  config: FacebookOAuthConfig,
  code: string,
): Promise<FacebookVerifiedIdentity> {
  const { clientId, clientSecret, redirectUri } = config;

  // 1. code -> user access token
  const tokenParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  });
  const tokenBody = await getJson(`${GRAPH_BASE}/oauth/access_token?${tokenParams.toString()}`);
  const accessToken = tokenBody["access_token"];

  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new FacebookIdentityError();
  }

  // 2. introspect the token — must be valid AND belong to this configured app
  const appAccessToken = `${clientId}|${clientSecret}`;
  const debugParams = new URLSearchParams({
    input_token: accessToken,
    access_token: appAccessToken,
  });
  const debugBody = await getJson(`${GRAPH_BASE}/debug_token?${debugParams.toString()}`);
  const debugData = debugBody["data"];

  if (typeof debugData !== "object" || debugData === null) {
    throw new FacebookIdentityError();
  }

  const {
    is_valid: isValid,
    app_id: appId,
    user_id: debugUserId,
  } = debugData as { is_valid?: unknown; app_id?: unknown; user_id?: unknown };

  if (
    isValid !== true ||
    String(appId) !== String(clientId) ||
    typeof debugUserId !== "string" ||
    debugUserId.length === 0
  ) {
    throw new FacebookIdentityError();
  }

  // 3. minimal profile
  const meParams = new URLSearchParams({
    fields: "id,name,email,first_name,last_name",
    access_token: accessToken,
    appsecret_proof: appSecretProof(accessToken, clientSecret),
  });
  const me = await getJson(`${GRAPH_BASE}/me?${meParams.toString()}`);

  const id = me["id"];
  const email = me["email"];
  const name = me["name"];
  const firstName = me["first_name"];
  const lastName = me["last_name"];

  if (typeof id !== "string" || id.length === 0 || id !== debugUserId) {
    throw new FacebookIdentityError();
  }

  const hasEmail = typeof email === "string" && email.length > 0;

  return {
    providerAccountId: id,
    ...(hasEmail ? { email: email as string } : {}),
    // Facebook only returns `email` once it has confirmed ownership, so a present email is verified.
    emailVerified: hasEmail,
    ...(typeof name === "string" && name.length > 0 ? { displayName: name } : {}),
    ...(typeof firstName === "string" && firstName.length > 0 ? { firstName } : {}),
    ...(typeof lastName === "string" && lastName.length > 0 ? { lastName } : {}),
  };
}
