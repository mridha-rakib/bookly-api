import { OAuthStateService } from "../../common/oauth/oauth-state.service.js";
import { env } from "../../config/env.js";
import { ProfessionalGoogleAuthError } from "./professional-google-auth.errors.js";

/**
 * Signs the OAuth `state` for the Business Owner Google flow. Carries only a random `nonce`
 * (matched against a cookie on callback — CSRF / login-fixation). Visit type used to travel here
 * too, but it is now a post-phone-verification onboarding step collected well after this OAuth
 * round trip, so it no longer needs to survive the redirect. Dedicated key context; 10-minute TTL.
 */
const stateService = new OAuthStateService(
  "professional-google-auth-state",
  String(env.GOOGLE_CLIENT_SECRET),
);

export type ProfessionalGoogleStatePayload = {
  nonce: string;
};

export async function signProfessionalGoogleState(
  payload: ProfessionalGoogleStatePayload,
): Promise<string> {
  return stateService.sign(payload);
}

export async function verifyProfessionalGoogleState(
  token: string,
): Promise<ProfessionalGoogleStatePayload> {
  let claims: Record<string, unknown>;
  try {
    claims = await stateService.verify(token);
  } catch {
    throw new ProfessionalGoogleAuthError("PROFESSIONAL_GOOGLE_INVALID_STATE", 400);
  }

  const nonce = claims["nonce"];

  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new ProfessionalGoogleAuthError("PROFESSIONAL_GOOGLE_INVALID_STATE", 400);
  }

  return { nonce };
}
