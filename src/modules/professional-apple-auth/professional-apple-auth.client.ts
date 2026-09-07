import { isAppleClientSecretConfigured } from "../../common/oauth/apple-client-secret.js";
import {
  AppleIdentityError,
  type AppleOAuthConfig,
  type AppleVerifiedIdentity,
  buildAppleAuthUrl,
  resolveAppleIdentity,
} from "../../common/oauth/apple-identity.js";
import { env } from "../../config/env.js";
import { ProfessionalAppleAuthError } from "./professional-apple-auth.errors.js";

/**
 * Shares the APPLE_CLIENT_ID / key material with account linking and the Customer Apple flow;
 * only the redirect URI differs (APPLE_PROFESSIONAL_OAUTH_REDIRECT_URI).
 */
export function isProfessionalAppleAuthConfigured(): boolean {
  return Boolean(isAppleClientSecretConfigured() && env.APPLE_PROFESSIONAL_OAUTH_REDIRECT_URI);
}

function requireConfig(): AppleOAuthConfig {
  const { APPLE_CLIENT_ID: clientId, APPLE_PROFESSIONAL_OAUTH_REDIRECT_URI: redirectUri } = env;

  if (!isAppleClientSecretConfigured() || !clientId || !redirectUri) {
    throw new ProfessionalAppleAuthError("PROFESSIONAL_APPLE_AUTH_NOT_CONFIGURED", 503);
  }

  return { clientId, redirectUri };
}

export function buildProfessionalAppleAuthUrl(state: string, nonce: string): string {
  return buildAppleAuthUrl(requireConfig(), state, nonce);
}

export async function resolveProfessionalAppleIdentity(params: {
  code: string;
  idToken?: string | undefined;
  nonce: string;
}): Promise<AppleVerifiedIdentity> {
  const config = requireConfig();

  try {
    return await resolveAppleIdentity(config, params);
  } catch (error) {
    if (error instanceof AppleIdentityError) {
      throw new ProfessionalAppleAuthError("PROFESSIONAL_APPLE_OAUTH_FAILED", 502);
    }
    throw error;
  }
}
