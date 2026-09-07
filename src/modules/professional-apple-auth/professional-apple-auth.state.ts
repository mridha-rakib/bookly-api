import { OAuthStateService } from "../../common/oauth/oauth-state.service.js";
import { env } from "../../config/env.js";
import { type BusinessVisitType, businessVisitTypes } from "../business/business.types.js";
import { ProfessionalAppleAuthError } from "./professional-apple-auth.errors.js";

/**
 * Signs the OAuth `state` for the Business Owner Apple flow. Carries the OIDC `nonce` (matched
 * against the Apple id_token `nonce` claim — there is no nonce cookie for Apple) AND the
 * `visitType` the owner picked. `visitType` MUST travel inside the signed state, never the
 * callback body, because the existing professional registration depends on it. Dedicated key
 * context derived from APPLE_PRIVATE_KEY; 10-minute TTL.
 */
const stateService = new OAuthStateService(
  "professional-apple-auth-state",
  String(env.APPLE_PRIVATE_KEY),
);

export type ProfessionalAppleStatePayload = {
  nonce: string;
  visitType: BusinessVisitType;
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
  const visitType = claims["visitType"];

  if (
    typeof nonce !== "string" ||
    nonce.length === 0 ||
    typeof visitType !== "string" ||
    !businessVisitTypes.includes(visitType as BusinessVisitType)
  ) {
    throw new ProfessionalAppleAuthError("PROFESSIONAL_APPLE_INVALID_STATE", 400);
  }

  return { nonce, visitType: visitType as BusinessVisitType };
}
