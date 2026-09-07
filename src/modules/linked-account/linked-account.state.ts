import { OAuthStateService } from "../../common/oauth/oauth-state.service.js";
import { env } from "../../config/env.js";
import { LinkedAccountError } from "./linked-account.errors.js";

/**
 * Per-provider signing keys, each derived from that provider's own client secret (never reuses
 * JWT_ACCESS_TOKEN_SECRET / OTP_HASH_SECRET for an unrelated purpose) — mirrors
 * integration.state.ts. Each service only reaches its state helpers once linking for that
 * provider is confirmed configured (see is*AccountLinkConfigured), so the secret is present. Key
 * derivation + 10-minute TTL live in the shared OAuthStateService.
 *
 * The `google-account-link-oauth-state` context string is unchanged so states signed before this
 * refactor still verify. Facebook uses its own distinct context so a Google state can never be
 * replayed against the Facebook callback (or vice-versa).
 */
const googleStateService = new OAuthStateService(
  "google-account-link-oauth-state",
  String(env.GOOGLE_CLIENT_SECRET),
);

const facebookStateService = new OAuthStateService(
  "facebook-account-link-oauth-state",
  String(env.FACEBOOK_CLIENT_SECRET),
);

// Apple has no static client secret — derive the state key from the (secret) private key
// material, same "per-feature secret" convention as Facebook.
const appleStateService = new OAuthStateService(
  "apple-account-link-oauth-state",
  String(env.APPLE_PRIVATE_KEY),
);

/** Google / Facebook link states carry only "which user started this". */
export type LinkStatePayload = {
  userId: string;
};

/** Apple link state also carries the OIDC `nonce` (Apple's form_post callback can't use the
 * SameSite=Lax nonce cookie, so the id_token `nonce` claim + this signed value replace it). */
export type AppleLinkStatePayload = {
  userId: string;
  nonce: string;
};

/** @deprecated name kept for back-compat; use {@link LinkStatePayload}. */
export type GoogleLinkStatePayload = LinkStatePayload;

/**
 * Binds the OAuth `state` param to the authenticated user who started the link flow (CSRF /
 * cross-account-linking protection). Payload carries ONLY the userId — nothing the callback can
 * be tricked into trusting beyond "which user initiated this".
 */
export async function signGoogleLinkState(payload: LinkStatePayload): Promise<string> {
  return googleStateService.sign(payload);
}

export async function verifyGoogleLinkState(token: string): Promise<LinkStatePayload> {
  return verifyLinkState(googleStateService, token, "Google");
}

export async function signFacebookLinkState(payload: LinkStatePayload): Promise<string> {
  return facebookStateService.sign(payload);
}

export async function verifyFacebookLinkState(token: string): Promise<LinkStatePayload> {
  return verifyLinkState(facebookStateService, token, "Facebook");
}

export async function signAppleLinkState(payload: AppleLinkStatePayload): Promise<string> {
  return appleStateService.sign(payload);
}

export async function verifyAppleLinkState(token: string): Promise<AppleLinkStatePayload> {
  let claims: Record<string, unknown>;
  try {
    claims = await appleStateService.verify(token);
  } catch {
    throw new LinkedAccountError("LINKED_ACCOUNT_INVALID_STATE", 400, undefined, "Apple");
  }

  const userId = claims["userId"];
  const nonce = claims["nonce"];

  if (typeof userId !== "string" || typeof nonce !== "string" || nonce.length === 0) {
    throw new LinkedAccountError("LINKED_ACCOUNT_INVALID_STATE", 400, undefined, "Apple");
  }

  return { userId, nonce };
}

async function verifyLinkState(
  service: OAuthStateService,
  token: string,
  providerLabel: string,
): Promise<LinkStatePayload> {
  let claims: Record<string, unknown>;
  try {
    claims = await service.verify(token);
  } catch {
    throw new LinkedAccountError("LINKED_ACCOUNT_INVALID_STATE", 400, undefined, providerLabel);
  }

  const userId = claims["userId"];

  if (typeof userId !== "string") {
    throw new LinkedAccountError("LINKED_ACCOUNT_INVALID_STATE", 400, undefined, providerLabel);
  }

  return { userId };
}
