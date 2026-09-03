import {
  GOOGLE_OIDC_SCOPES,
  type GoogleVerifiedIdentity,
  resolveGoogleIdentity,
} from "../../common/oauth/google-identity.js";
import { GoogleOAuthClient } from "../../common/oauth/google-oauth-client.js";
import { env } from "../../config/env.js";
import { LinkedAccountError } from "./linked-account.errors.js";

export type GoogleLinkedIdentity = {
  /** Google OIDC `sub` — the stable per-account identifier stored as providerAccountId. */
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
};

/**
 * Shares the GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET OAuth client with the Calendar integration
 * (one Google Cloud client can carry multiple redirect URIs); only the redirect URI is its own,
 * registered separately in the Cloud Console. Unset in dev/test — the linking endpoints return a
 * clear LINKED_ACCOUNT_NOT_CONFIGURED (503) rather than crashing app boot.
 */
export function isGoogleAccountLinkConfigured(): boolean {
  return Boolean(
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_ACCOUNT_LINK_REDIRECT_URI,
  );
}

function createClient(): GoogleOAuthClient {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_ACCOUNT_LINK_REDIRECT_URI } = env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_ACCOUNT_LINK_REDIRECT_URI) {
    throw new LinkedAccountError("LINKED_ACCOUNT_NOT_CONFIGURED", 503);
  }

  return new GoogleOAuthClient({
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    redirectUri: GOOGLE_ACCOUNT_LINK_REDIRECT_URI,
  });
}

export function buildGoogleAccountLinkAuthUrl(state: string): string {
  return createClient().generateAuthUrl({
    // "online" — no refresh token; account linking never calls Google APIs afterwards.
    accessType: "online",
    // Always show the account chooser so a user with several Google accounts links the intended
    // one rather than being silently re-consented with the last-used session.
    prompt: "select_account",
    scope: GOOGLE_OIDC_SCOPES,
    state,
  });
}

/**
 * Exchanges the authorization `code` for a verified Google identity (see resolveGoogleIdentity).
 * Returns only the identity fields; the token set itself is never returned or stored. Any failure
 * collapses to one coarse LINKED_ACCOUNT_OAUTH_FAILED — the callback only ever tells the browser
 * "error".
 */
export async function verifyGoogleAccountLinkCallback(code: string): Promise<GoogleLinkedIdentity> {
  const client = createClient();

  let identity: GoogleVerifiedIdentity;
  try {
    identity = await resolveGoogleIdentity(client, code);
  } catch {
    throw new LinkedAccountError("LINKED_ACCOUNT_OAUTH_FAILED", 502);
  }

  return {
    providerAccountId: identity.providerAccountId,
    email: identity.email,
    emailVerified: identity.emailVerified,
    ...(identity.displayName ? { displayName: identity.displayName } : {}),
  };
}
