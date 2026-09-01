import { env } from "../../config/env.js";
import { buildFrontendUrl } from "../email/email.links.js";

/**
 * Marketing Email Stage M2 — URL builders for the unsubscribe flow. Two distinct URLs, on
 * purpose:
 *
 *  - the VISIBLE, human-facing link in the email body → the web app confirmation page
 *    ({@link buildMarketingUnsubscribePageUrl}), built from `FRONTEND_BASE_URL` via the same
 *    `buildFrontendUrl` helper the transactional footer already uses;
 *  - the RFC 8058 ONE-CLICK `List-Unsubscribe` header target → the API endpoint
 *    ({@link resolveMarketingUnsubscribeOneClickUrl}), which mail providers POST to directly with
 *    no browser, so it must resolve to the backend, not the web app. Built from
 *    `PUBLIC_API_BASE_URL`; returns `undefined` when that is unconfigured (dev/test) so the
 *    envelope builder can omit the one-click headers instead of emitting a broken URL.
 *
 * The token is always carried as a `token` query param (opaque, signed — see
 * marketing-unsubscribe.token.ts).
 */

const MARKETING_UNSUBSCRIBE_PATH = "/marketing/unsubscribe";

export const buildMarketingUnsubscribePageUrl = (token: string): string =>
  `${buildFrontendUrl(MARKETING_UNSUBSCRIBE_PATH)}?token=${encodeURIComponent(token)}`;

export const resolveMarketingUnsubscribeOneClickUrl = (token: string): string | undefined => {
  const base = env.PUBLIC_API_BASE_URL;
  if (!base) {
    return undefined;
  }
  return `${base}${MARKETING_UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}`;
};
