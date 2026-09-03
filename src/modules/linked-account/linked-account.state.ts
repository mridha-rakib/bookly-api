import { OAuthStateService } from "../../common/oauth/oauth-state.service.js";
import { env } from "../../config/env.js";
import { LinkedAccountError } from "./linked-account.errors.js";

/**
 * Dedicated signing key derived from GOOGLE_CLIENT_SECRET (never reuses JWT_ACCESS_TOKEN_SECRET /
 * OTP_HASH_SECRET for an unrelated purpose) — mirrors integration.state.ts. Only ever reached
 * once linking is confirmed configured (see isGoogleAccountLinkConfigured), so the secret is
 * present. Key derivation + 10-minute TTL now live in the shared OAuthStateService; the context
 * string is unchanged so states signed before this refactor still verify.
 */
const stateService = new OAuthStateService(
  "google-account-link-oauth-state",
  String(env.GOOGLE_CLIENT_SECRET),
);

export type GoogleLinkStatePayload = {
  userId: string;
};

/**
 * Binds the OAuth `state` param to the authenticated Customer who started the link flow (CSRF /
 * cross-account-linking protection). Payload carries ONLY the userId — nothing the callback can
 * be tricked into trusting beyond "which user initiated this".
 */
export async function signGoogleLinkState(payload: GoogleLinkStatePayload): Promise<string> {
  return stateService.sign(payload);
}

export async function verifyGoogleLinkState(token: string): Promise<GoogleLinkStatePayload> {
  let claims: Record<string, unknown>;
  try {
    claims = await stateService.verify(token);
  } catch {
    throw new LinkedAccountError("LINKED_ACCOUNT_INVALID_STATE", 400);
  }

  const userId = claims["userId"];

  if (typeof userId !== "string") {
    throw new LinkedAccountError("LINKED_ACCOUNT_INVALID_STATE", 400);
  }

  return { userId };
}
