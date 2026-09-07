import {
  buildFacebookAuthUrl,
  FacebookIdentityError,
  type FacebookOAuthConfig,
  type FacebookVerifiedIdentity,
  resolveFacebookIdentity,
} from "../../common/oauth/facebook-identity.js";
import { env } from "../../config/env.js";
import { CustomerFacebookAuthError } from "./customer-facebook-auth.errors.js";

/**
 * Shares the FACEBOOK_CLIENT_ID / FACEBOOK_CLIENT_SECRET Meta app with account linking and the
 * Business-Owner Facebook flow; only the redirect URI differs
 * (FACEBOOK_CUSTOMER_OAUTH_REDIRECT_URI, its own "Valid OAuth Redirect URI" on the same Meta
 * app). Unset in dev/test — the start endpoint redirects the browser back with `status=error`
 * rather than crashing app boot.
 */
export function isCustomerFacebookAuthConfigured(): boolean {
  return Boolean(
    env.FACEBOOK_CLIENT_ID &&
      env.FACEBOOK_CLIENT_SECRET &&
      env.FACEBOOK_CUSTOMER_OAUTH_REDIRECT_URI,
  );
}

function requireConfig(): FacebookOAuthConfig {
  const {
    FACEBOOK_CLIENT_ID: clientId,
    FACEBOOK_CLIENT_SECRET: clientSecret,
    FACEBOOK_CUSTOMER_OAUTH_REDIRECT_URI: redirectUri,
  } = env;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new CustomerFacebookAuthError("CUSTOMER_FACEBOOK_AUTH_NOT_CONFIGURED", 503);
  }

  return { clientId, clientSecret, redirectUri };
}

export function buildCustomerFacebookAuthUrl(state: string): string {
  const { clientId, redirectUri } = requireConfig();
  return buildFacebookAuthUrl({ clientId, redirectUri }, state);
}

/**
 * Exchanges the authorization `code` for a verified Facebook identity via the shared resolver.
 * `email` may be absent — the service decides (existing-link login tolerates it; signup does
 * not). Any provider failure collapses to CUSTOMER_FACEBOOK_OAUTH_FAILED (502).
 */
export async function resolveCustomerFacebookIdentity(
  code: string,
): Promise<FacebookVerifiedIdentity> {
  const config = requireConfig();

  try {
    return await resolveFacebookIdentity(config, code);
  } catch (error) {
    if (error instanceof FacebookIdentityError) {
      throw new CustomerFacebookAuthError("CUSTOMER_FACEBOOK_OAUTH_FAILED", 502);
    }
    throw error;
  }
}
