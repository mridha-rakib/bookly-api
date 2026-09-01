import { AppError, type ErrorDetail } from "../../common/errors/app-error.js";

/**
 * Marketing Email Stage M2. Deliberately ONE generic, non-committal failure code for the public
 * unsubscribe endpoint: a bad, tampered, wrong-purpose, or otherwise unusable token all surface
 * identically, and the message never reveals whether an account, profile, or preference exists
 * (no enumeration — mirrors the generic `GOOGLE_CALENDAR_INVALID_STATE` treatment for a public
 * signed-token callback).
 */
const defaultMessages = {
  MARKETING_UNSUBSCRIBE_LINK_INVALID: "This unsubscribe link is invalid or no longer available.",
} as const;

export class MarketingError extends AppError {
  public constructor(
    code: keyof typeof defaultMessages,
    statusCode = 400,
    details?: ErrorDetail[],
  ) {
    const message = defaultMessages[code];
    super(message, statusCode, {
      details: details ?? [{ message, code }],
      expose: true,
    });
  }
}

/**
 * Marketing Email Stage M3A — SUPER_ADMIN campaign-domain errors. These are authenticated
 * admin-facing (unlike the deliberately opaque public unsubscribe error), so the messages are
 * specific and actionable.
 */
const campaignMessages = {
  MARKETING_CAMPAIGN_NOT_FOUND: "Campaign not found.",
  MARKETING_CAMPAIGN_SOURCE_NOT_FOUND: "The selected source could not be found.",
  MARKETING_CAMPAIGN_SOURCE_NOT_ELIGIBLE:
    "The selected source is not eligible for a campaign (an article must be published; a promo must be active and not expired).",
  MARKETING_CAMPAIGN_INVALID_STATE: "This action is not allowed for the campaign's current status.",
  MARKETING_ONE_CLICK_NOT_CONFIGURED:
    "Marketing email cannot be sent: one-click unsubscribe (PUBLIC_API_BASE_URL) is not configured.",
} as const;

export type MarketingCampaignErrorCode = keyof typeof campaignMessages;

export class MarketingCampaignError extends AppError {
  public constructor(code: MarketingCampaignErrorCode, statusCode = 400, details?: ErrorDetail[]) {
    const message = campaignMessages[code];
    super(message, statusCode, {
      details: details ?? [{ message, code }],
      expose: true,
    });
  }
}
