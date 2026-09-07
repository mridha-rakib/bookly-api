import { isAppleClientSecretConfigured } from "../../common/oauth/apple-client-secret.js";
import {
  AppleIdentityError,
  type AppleOAuthConfig,
  buildAppleAuthUrl,
  resolveAppleIdentity,
} from "../../common/oauth/apple-identity.js";
import { env } from "../../config/env.js";
import { LinkedAccountError } from "./linked-account.errors.js";

/**
 * Sign in with Apple account-link adapter. The security-sensitive JWKS id_token verification +
 * ES256 client-secret + code exchange live in the shared {@link resolveAppleIdentity}
 * (common/oauth), reused by the Customer / Business-Owner Apple LOGIN modules. This adapter keeps
 * only the link-specific policy: the link redirect URI, and the rule that an Apple account with
 * NO usable email cannot be linked (LinkedAccount.email is required — same as Google/Facebook).
 */

export type AppleLinkedIdentity = {
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
};

export function isAppleAccountLinkConfigured(): boolean {
  return Boolean(isAppleClientSecretConfigured() && env.APPLE_ACCOUNT_LINK_REDIRECT_URI);
}

function requireConfig(): AppleOAuthConfig {
  const { APPLE_CLIENT_ID: clientId, APPLE_ACCOUNT_LINK_REDIRECT_URI: redirectUri } = env;

  if (!isAppleClientSecretConfigured() || !clientId || !redirectUri) {
    throw new LinkedAccountError("LINKED_ACCOUNT_NOT_CONFIGURED", 503, undefined, "Apple");
  }

  return { clientId, redirectUri };
}

export function buildAppleAccountLinkAuthUrl(state: string, nonce: string): string {
  return buildAppleAuthUrl(requireConfig(), state, nonce);
}

/**
 * Verifies the Apple form_post callback for a link attempt. `nonce` is the value signed into the
 * link state; it must equal the `nonce` claim of the Apple id_token. A missing email fails the
 * link (LinkedAccount.email is required) exactly as Google/Facebook.
 */
export async function verifyAppleAccountLinkCallback(params: {
  code: string;
  idToken?: string | undefined;
  nonce: string;
}): Promise<AppleLinkedIdentity> {
  const config = requireConfig();

  let identity: Awaited<ReturnType<typeof resolveAppleIdentity>>;
  try {
    identity = await resolveAppleIdentity(config, params);
  } catch (error) {
    if (error instanceof AppleIdentityError) {
      throw new LinkedAccountError("LINKED_ACCOUNT_OAUTH_FAILED", 502, undefined, "Apple");
    }
    throw error;
  }

  if (!identity.email) {
    throw new LinkedAccountError("LINKED_ACCOUNT_OAUTH_FAILED", 502, undefined, "Apple");
  }

  return {
    providerAccountId: identity.providerAccountId,
    email: identity.email,
    emailVerified: identity.emailVerified,
    ...(identity.displayName ? { displayName: identity.displayName } : {}),
  };
}
