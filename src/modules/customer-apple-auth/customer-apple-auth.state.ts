import { OAuthStateService } from "../../common/oauth/oauth-state.service.js";
import { env } from "../../config/env.js";
import { CustomerAppleAuthError } from "./customer-apple-auth.errors.js";

/**
 * Signs the OAuth `state` for the Customer Apple flow. Unlike Google/Facebook there is NO nonce
 * cookie — Apple's callback is a cross-site POST (`response_mode=form_post`) and a `SameSite=Lax`
 * cookie would not be sent. CSRF / replay protection instead comes from: this HMAC-signed state
 * (10-min TTL) + the Apple id_token `nonce` claim, which the resolver checks equals the `nonce`
 * carried here. Dedicated key context; the key is derived from APPLE_PRIVATE_KEY (Apple has no
 * static secret) — same per-feature-secret convention as the Facebook flows.
 */
const stateService = new OAuthStateService(
  "customer-apple-auth-state",
  String(env.APPLE_PRIVATE_KEY),
);

export type CustomerAppleStatePayload = {
  nonce: string;
};

export async function signCustomerAppleState(payload: CustomerAppleStatePayload): Promise<string> {
  return stateService.sign(payload);
}

export async function verifyCustomerAppleState(token: string): Promise<CustomerAppleStatePayload> {
  let claims: Record<string, unknown>;
  try {
    claims = await stateService.verify(token);
  } catch {
    throw new CustomerAppleAuthError("CUSTOMER_APPLE_INVALID_STATE", 400);
  }

  const nonce = claims["nonce"];

  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new CustomerAppleAuthError("CUSTOMER_APPLE_INVALID_STATE", 400);
  }

  return { nonce };
}
