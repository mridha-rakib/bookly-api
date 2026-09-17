import { OAuthStateService } from "../../common/oauth/oauth-state.service.js";
import { env } from "../../config/env.js";
import { ProfessionalAppleAuthError } from "./professional-apple-auth.errors.js";

/**
 * Signs the OAuth `state` for the Business Owner Apple flow. Carries only the OIDC `nonce`
 * (matched against the Apple id_token `nonce` claim — there is no nonce cookie for Apple). Visit
 * type used to travel here too, but it is now a post-phone-verification onboarding step collected
 * well after this OAuth round trip, so it no longer needs to survive it. Dedicated key context
 * derived from APPLE_PRIVATE_KEY; 10-minute TTL.
 */
const stateService = new OAuthStateService(
  "professional-apple-auth-state",
  String(env.APPLE_PRIVATE_KEY),
);

export type ProfessionalAppleStatePayload = {
  nonce: string;
};

export async function signProfessionalAppleState(
  payload: ProfessionalAppleStatePayload,
): Promise<string> {
  return stateService.sign(payload);
}

export async function verifyProfessionalAppleState(
  token: string,
): Promise<ProfessionalAppleStatePayload> {
  let claims: Record<string, unknown>;
  try {
    claims = await stateService.verify(token);
  } catch {
    throw new ProfessionalAppleAuthError("PROFESSIONAL_APPLE_INVALID_STATE", 400);
  }

  const nonce = claims["nonce"];

  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new ProfessionalAppleAuthError("PROFESSIONAL_APPLE_INVALID_STATE", 400);
  }

  return { nonce };
}
