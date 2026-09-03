import { OAuthStateService } from "../../common/oauth/oauth-state.service.js";
import { env } from "../../config/env.js";
import { type BusinessVisitType, businessVisitTypes } from "../business/business.types.js";
import { ProfessionalGoogleAuthError } from "./professional-google-auth.errors.js";

/**
 * Signs the OAuth `state` for the Business Owner Google flow. Carries a random `nonce` (matched
 * against a cookie on callback — CSRF / login-fixation) AND the `visitType` the owner picked on
 * `/professional/auth?type=…`. `visitType` MUST travel inside the signed state, never as a
 * callback query param, because the existing professional registration depends on it and a
 * tampered value would seed the wrong booking flow. Dedicated key context; 10-minute TTL.
 */
const stateService = new OAuthStateService(
  "professional-google-auth-state",
  String(env.GOOGLE_CLIENT_SECRET),
);

export type ProfessionalGoogleStatePayload = {
  nonce: string;
  visitType: BusinessVisitType;
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
  const visitType = claims["visitType"];

  if (
    typeof nonce !== "string" ||
    nonce.length === 0 ||
    typeof visitType !== "string" ||
    !businessVisitTypes.includes(visitType as BusinessVisitType)
  ) {
    throw new ProfessionalGoogleAuthError("PROFESSIONAL_GOOGLE_INVALID_STATE", 400);
  }

  return { nonce, visitType: visitType as BusinessVisitType };
}
