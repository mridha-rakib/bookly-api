import { OAuthStateService } from "../../common/oauth/oauth-state.service.js";
import { env } from "../../config/env.js";
import { CustomerFacebookAuthError } from "./customer-facebook-auth.errors.js";

/**
 * Signs the OAuth `state` for the Customer Facebook flow. Like the Customer Google flow there is
 * no authenticated user to bind, so the payload carries only a random `nonce`; the `start`
 * endpoint also drops that same nonce into a short-lived httpOnly cookie, and the callback
 * requires the two to match (CSRF / login-fixation protection). Dedicated key context — never
 * shares a key with the Facebook link state, the Customer Google state, or the Professional
 * Facebook state. 10-minute TTL (OAuthStateService default).
 */
const stateService = new OAuthStateService(
  "customer-facebook-auth-state",
  String(env.FACEBOOK_CLIENT_SECRET),
);

export type CustomerFacebookStatePayload = {
  nonce: string;
};

export async function signCustomerFacebookState(
  payload: CustomerFacebookStatePayload,
): Promise<string> {
  return stateService.sign(payload);
}

export async function verifyCustomerFacebookState(
  token: string,
): Promise<CustomerFacebookStatePayload> {
  let claims: Record<string, unknown>;
  try {
    claims = await stateService.verify(token);
  } catch {
    throw new CustomerFacebookAuthError("CUSTOMER_FACEBOOK_INVALID_STATE", 400);
  }

  const nonce = claims["nonce"];

  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new CustomerFacebookAuthError("CUSTOMER_FACEBOOK_INVALID_STATE", 400);
  }

  return { nonce };
}
