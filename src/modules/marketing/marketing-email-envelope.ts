import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { MarketingCampaignError } from "./marketing.errors.js";
import {
  buildMarketingUnsubscribePageUrl,
  resolveMarketingUnsubscribeOneClickUrl,
} from "./marketing.links.js";
import { signMarketingUnsubscribeToken } from "./marketing-unsubscribe.token.js";

/**
 * Marketing Email Stage M2 — the reusable "marketing envelope" for a single recipient.
 *
 * Given the linked account's user id it mints ONE unsubscribe token and returns everything a
 * future (M3) marketing send needs to be compliant:
 *
 *  - `unsubscribePageUrl` — the visible, human-facing link to drop in the marketing footer;
 *  - `headers` — the RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post` pair, ready to pass
 *    straight into {@link import("../email/email.types.js").EmailTransportSendInput.headers}.
 *
 * `headers` is `{}` when `PUBLIC_API_BASE_URL` is unconfigured: a one-click header MUST point at
 * a URL the mail provider can POST to, so emitting a web-app URL there would be worse than
 * omitting it. This is logged, not silently swallowed. Nothing in M2 calls a transport with
 * these headers — this is infrastructure for M3.
 */

export type MarketingEmailEnvelope = {
  unsubscribePageUrl: string;
  headers: Record<string, string>;
};

export const LIST_UNSUBSCRIBE_POST_VALUE = "List-Unsubscribe=One-Click" as const;

/**
 * Marketing Email Stage M3B — the hard gate. A marketing campaign may not enter `SENDING` (and
 * no marketing email may be sent) unless `PUBLIC_API_BASE_URL` is configured, because every
 * marketing email MUST carry a working RFC 8058 one-click `List-Unsubscribe` header. Throws a
 * safe, generic {@link MarketingCampaignError} (no secret, no URL). In production the env schema
 * already refuses to boot without it; this is the belt-and-braces runtime check.
 */
export const assertMarketingOneClickConfigured = (): void => {
  if (!env.PUBLIC_API_BASE_URL) {
    throw new MarketingCampaignError("MARKETING_ONE_CLICK_NOT_CONFIGURED", 503);
  }
};

export const buildMarketingEmailEnvelope = async (
  userId: string,
): Promise<MarketingEmailEnvelope> => {
  const token = await signMarketingUnsubscribeToken(userId);
  const unsubscribePageUrl = buildMarketingUnsubscribePageUrl(token);
  const oneClickUrl = resolveMarketingUnsubscribeOneClickUrl(token);

  if (!oneClickUrl) {
    logger.warn(
      { operation: "marketing_email_envelope" },
      "PUBLIC_API_BASE_URL not configured — omitting one-click List-Unsubscribe headers",
    );
    return { unsubscribePageUrl, headers: {} };
  }

  return {
    unsubscribePageUrl,
    headers: {
      "List-Unsubscribe": `<${oneClickUrl}>`,
      "List-Unsubscribe-Post": LIST_UNSUBSCRIBE_POST_VALUE,
    },
  };
};
