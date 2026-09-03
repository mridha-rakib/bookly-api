import { OAuthStateService } from "../../common/oauth/oauth-state.service.js";
import { env } from "../../config/env.js";
import { StaffInvitationError } from "./staff-invitation.errors.js";

/**
 * Signs the OAuth `state` for the Staff/Supervisor invitation-acceptance-via-Google flow. Carries
 * a random `nonce` (matched against a cookie on callback — CSRF / login-fixation) AND the
 * `invitationId` the invitee is accepting. `invitationId` MUST travel inside the signed state,
 * never as a callback query param: the role + business the new User/StaffMembership get are read
 * ONLY from that server-side invitation row, so a tampered id must never be honoured. Dedicated
 * key context; 10-minute TTL.
 */
const stateService = new OAuthStateService(
  "staff-invitation-google-state",
  String(env.GOOGLE_CLIENT_SECRET),
);

export type StaffInvitationGoogleStatePayload = {
  nonce: string;
  invitationId: string;
};

const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

export async function signStaffInvitationGoogleState(
  payload: StaffInvitationGoogleStatePayload,
): Promise<string> {
  return stateService.sign(payload);
}

export async function verifyStaffInvitationGoogleState(
  token: string,
): Promise<StaffInvitationGoogleStatePayload> {
  let claims: Record<string, unknown>;
  try {
    claims = await stateService.verify(token);
  } catch {
    throw new StaffInvitationError("STAFF_INVITATION_INVALID_STATE", 400);
  }

  const nonce = claims["nonce"];
  const invitationId = claims["invitationId"];

  if (
    typeof nonce !== "string" ||
    nonce.length === 0 ||
    typeof invitationId !== "string" ||
    !OBJECT_ID_RE.test(invitationId)
  ) {
    throw new StaffInvitationError("STAFF_INVITATION_INVALID_STATE", 400);
  }

  return { nonce, invitationId };
}
