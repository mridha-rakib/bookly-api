import {
  GOOGLE_OIDC_SCOPES,
  GoogleIdentityError,
  type GoogleVerifiedIdentity,
  resolveGoogleIdentity,
} from "../../common/oauth/google-identity.js";
import { GoogleOAuthClient } from "../../common/oauth/google-oauth-client.js";
import { env } from "../../config/env.js";
import { CustomerGoogleAuthError } from "./customer-google-auth.errors.js";

/**
 * Shares the GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET OAuth client with the Calendar integration
 * and account linking; only the redirect URI differs (GOOGLE_CUSTOMER_OAUTH_REDIRECT_URI,
 * registered as its own "Authorized redirect URI" on the same Google Cloud client). Unset in
 * dev/test — the start endpoint redirects the browser back with `status=error` rather than
 * crashing app boot.
 */
export function isCustomerGoogleAuthConfigured(): boolean {
  return Boolean(
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CUSTOMER_OAUTH_REDIRECT_URI,
  );
}

function createClient(): GoogleOAuthClient {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CUSTOMER_OAUTH_REDIRECT_URI } = env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_CUSTOMER_OAUTH_REDIRECT_URI) {
    throw new CustomerGoogleAuthError("CUSTOMER_GOOGLE_AUTH_NOT_CONFIGURED", 503);
  }

  return new GoogleOAuthClient({
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    redirectUri: GOOGLE_CUSTOMER_OAUTH_REDIRECT_URI,
  });
}

export function buildCustomerGoogleAuthUrl(state: string): string {
  return createClient().generateAuthUrl({
    // "online" — Customer Google auth verifies identity once and never calls a Google API again.
    accessType: "online",
    // Always show the account chooser so a multi-account user picks the intended identity.
    prompt: "select_account",
    scope: GOOGLE_OIDC_SCOPES,
    state,
  });
}

/**
 * Exchanges the authorization `code` for a verified Google identity. The token set is never
 * returned or stored. Any provider failure collapses to CUSTOMER_GOOGLE_OAUTH_FAILED (502).
 */
export async function resolveCustomerGoogleIdentity(code: string): Promise<GoogleVerifiedIdentity> {
  const client = createClient();

  try {
    return await resolveGoogleIdentity(client, code);
  } catch (error) {
    if (error instanceof GoogleIdentityError) {
      throw new CustomerGoogleAuthError("CUSTOMER_GOOGLE_OAUTH_FAILED", 502);
    }
    throw error;
  }
}
