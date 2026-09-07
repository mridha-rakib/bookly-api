import { isAppleClientSecretConfigured } from "../../common/oauth/apple-client-secret.js";
import {
  AppleIdentityError,
  type AppleOAuthConfig,
  type AppleVerifiedIdentity,
  buildAppleAuthUrl,
  resolveAppleIdentity,
} from "../../common/oauth/apple-identity.js";
import { env } from "../../config/env.js";
import { CustomerAppleAuthError } from "./customer-apple-auth.errors.js";

/**
 * Shares the APPLE_CLIENT_ID / key material with account linking and the Business-Owner Apple
 * flow; only the redirect URI differs (APPLE_CUSTOMER_OAUTH_REDIRECT_URI). Unset in dev/test —
 * the start endpoint redirects the browser back with `status=error` rather than crashing boot.
 */
export function isCustomerAppleAuthConfigured(): boolean {
  return Boolean(isAppleClientSecretConfigured() && env.APPLE_CUSTOMER_OAUTH_REDIRECT_URI);
}

function requireConfig(): AppleOAuthConfig {
  const { APPLE_CLIENT_ID: clientId, APPLE_CUSTOMER_OAUTH_REDIRECT_URI: redirectUri } = env;

  if (!isAppleClientSecretConfigured() || !clientId || !redirectUri) {
    throw new CustomerAppleAuthError("CUSTOMER_APPLE_AUTH_NOT_CONFIGURED", 503);
  }

  return { clientId, redirectUri };
}

export function buildCustomerAppleAuthUrl(state: string, nonce: string): string {
  return buildAppleAuthUrl(requireConfig(), state, nonce);
}

/**
 * Verifies the Apple form_post callback: exchanges `code`, verifies the id_token(s) against
 * Apple's JWKS, and checks the id_token `nonce` claim equals `nonce` (the value signed into the
 * OAuth state). `email` may be absent — the service decides. Any provider failure collapses to
 * CUSTOMER_APPLE_OAUTH_FAILED (502).
 */
export async function resolveCustomerAppleIdentity(params: {
  code: string;
  idToken?: string | undefined;
  nonce: string;
}): Promise<AppleVerifiedIdentity> {
  const config = requireConfig();

  try {
    return await resolveAppleIdentity(config, params);
  } catch (error) {
    if (error instanceof AppleIdentityError) {
      throw new CustomerAppleAuthError("CUSTOMER_APPLE_OAUTH_FAILED", 502);
    }
    throw error;
  }
}
