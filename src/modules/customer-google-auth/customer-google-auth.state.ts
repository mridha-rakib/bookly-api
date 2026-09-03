import { OAuthStateService } from "../../common/oauth/oauth-state.service.js";
import { env } from "../../config/env.js";
import { CustomerGoogleAuthError } from "./customer-google-auth.errors.js";

/**
 * Signs the OAuth `state` for the Customer Google flow. Unlike account linking there is no
 * authenticated user to bind, so the payload carries only a random `nonce`; the `start` endpoint
 * also drops that same nonce into a short-lived httpOnly cookie, and the callback requires the
 * two to match (CSRF / login-fixation protection). Dedicated key context — never shares a key
 * with the Calendar or linking state. 10-minute TTL (OAuthStateService default).
 */
const stateService = new OAuthStateService(
  "customer-google-auth-state",
  String(env.GOOGLE_CLIENT_SECRET),
);

export type CustomerGoogleStatePayload = {
  nonce: string;
};

export async function signCustomerGoogleState(
  payload: CustomerGoogleStatePayload,
): Promise<string> {
  return stateService.sign(payload);
}

export async function verifyCustomerGoogleState(
  token: string,
): Promise<CustomerGoogleStatePayload> {
  let claims: Record<string, unknown>;
  try {
    claims = await stateService.verify(token);
  } catch {
    throw new CustomerGoogleAuthError("CUSTOMER_GOOGLE_INVALID_STATE", 400);
  }

  const nonce = claims["nonce"];

  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new CustomerGoogleAuthError("CUSTOMER_GOOGLE_INVALID_STATE", 400);
  }

  return { nonce };
}
