import {
  buildFacebookAuthUrl,
  FacebookIdentityError,
  resolveFacebookIdentity,
} from "../../common/oauth/facebook-identity.js";
import { env } from "../../config/env.js";
import { LinkedAccountError } from "./linked-account.errors.js";

/**
 * Facebook (Meta) account-link OAuth adapter. Narrowly scoped to identity verification for
 * Settings → Link Facebook — it never calls a Graph API on the user's behalf afterwards, never
 * requests a Page / posting / business permission, and never returns or persists the access
 * token.
 *
 * The security-sensitive token exchange + `debug_token` introspection + `app_id` pin +
 * `appsecret_proof` `/me` read live in the shared {@link resolveFacebookIdentity} (common/oauth),
 * reused by the Customer / Business-Owner Facebook LOGIN modules. This adapter keeps only the
 * link-specific policy: the link redirect URI, and the rule that a Facebook account with NO
 * usable email cannot be linked (LinkedAccount.email is required). Any provider failure collapses
 * to one coarse LINKED_ACCOUNT_OAUTH_FAILED — the callback only ever tells the browser "error".
 */

export type FacebookLinkedIdentity = {
  /** Facebook app-scoped user id — stable per (user, app). Stored as providerAccountId. */
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
};

/**
 * Unset in dev/test — the linking endpoints return a clear LINKED_ACCOUNT_NOT_CONFIGURED (503)
 * rather than crashing app boot (identical gate convention to isGoogleAccountLinkConfigured).
 */
export function isFacebookAccountLinkConfigured(): boolean {
  return Boolean(
    env.FACEBOOK_CLIENT_ID && env.FACEBOOK_CLIENT_SECRET && env.FACEBOOK_ACCOUNT_LINK_REDIRECT_URI,
  );
}

function requireConfig(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const {
    FACEBOOK_CLIENT_ID: clientId,
    FACEBOOK_CLIENT_SECRET: clientSecret,
    FACEBOOK_ACCOUNT_LINK_REDIRECT_URI: redirectUri,
  } = env;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new LinkedAccountError("LINKED_ACCOUNT_NOT_CONFIGURED", 503, undefined, "Facebook");
  }

  return { clientId, clientSecret, redirectUri };
}

export function buildFacebookAccountLinkAuthUrl(state: string): string {
  const { clientId, redirectUri } = requireConfig();
  return buildFacebookAuthUrl({ clientId, redirectUri }, state);
}

/**
 * Exchanges the authorization `code` for a verified Facebook identity via the shared resolver.
 * The token itself is never returned or stored. A Facebook account with no shared email cannot be
 * linked (the LinkedAccount schema requires `email`, and Google's flow has the same requirement)
 * — that surfaces as the same coarse LINKED_ACCOUNT_OAUTH_FAILED as any other failure.
 */
export async function verifyFacebookAccountLinkCallback(
  code: string,
): Promise<FacebookLinkedIdentity> {
  const config = requireConfig();

  let identity: Awaited<ReturnType<typeof resolveFacebookIdentity>>;
  try {
    identity = await resolveFacebookIdentity(config, code);
  } catch (error) {
    if (error instanceof FacebookIdentityError) {
      throw new LinkedAccountError("LINKED_ACCOUNT_OAUTH_FAILED", 502, undefined, "Facebook");
    }
    throw error;
  }

  if (!identity.email) {
    // No usable email from Facebook — linking requires one (same as Google's "no email" case).
    throw new LinkedAccountError("LINKED_ACCOUNT_OAUTH_FAILED", 502, undefined, "Facebook");
  }

  return {
    providerAccountId: identity.providerAccountId,
    email: identity.email,
    emailVerified: identity.emailVerified,
    ...(identity.displayName ? { displayName: identity.displayName } : {}),
  };
}
