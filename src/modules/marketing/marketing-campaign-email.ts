import type { RenderedEmail } from "../email/email.types.js";
import { formatMoney } from "../email/templates/components/email-format.js";
import {
  emailButton,
  emailCodeCard,
  emailMutedNote,
  emailParagraph,
  emailTitle,
} from "../email/templates/components/email-primitives.js";
import { renderMarketingEmailLayout } from "../email/templates/components/marketing-email-layout.js";
import type { ArticleSourceSnapshot, PromoSourceSnapshot } from "./marketing-campaign.types.js";

/**
 * Marketing Email Stage M3B — THE marketing campaign renderer. One function, two campaign
 * types, deriving entirely from the frozen `campaign.source.snapshot` + `source.ctaUrl` + the
 * per-recipient unsubscribe URL. NO admin-supplied subject/HTML/CTA, no raw `bodyHtml`, no cover
 * image (the storage service only mints short-lived presigned URLs — see M3B audit §E). Not
 * registered in the transactional `template-registry.ts`; delegates to `renderMarketingEmailLayout`.
 */

export type MarketingCampaignEmailPayload =
  | {
      type: "ARTICLE";
      snapshot: ArticleSourceSnapshot;
      ctaUrl: string;
      unsubscribeUrl: string;
    }
  | {
      type: "PROMO";
      snapshot: PromoSourceSnapshot;
      ctaUrl: string;
      unsubscribeUrl: string;
    };

const SUBJECT_MAX = 120;

const clampSubject = (value: string): string => {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length <= SUBJECT_MAX
    ? trimmed
    : `${trimmed.slice(0, SUBJECT_MAX - 1).trimEnd()}…`;
};

/** Fixed, timezone-free date — e.g. "14 Sep 2026". No countdown language, no customer timezone. */
const formatEndDate = (date: Date): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);

/** PERCENTAGE `value` is 0–100; FIXED `value` is integer cents (same convention as PromoCode). */
const discountLine = (snapshot: PromoSourceSnapshot): string =>
  snapshot.type === "PERCENTAGE"
    ? `${snapshot.value}% off`
    : `${formatMoney(snapshot.value, "EUR")} off`;

const scopeCopy = (scope: string): string => {
  if (scope === "ALL_FIRST_BOOKINGS") {
    return "For your first booking at a participating business.";
  }
  if (scope === "SELECTED_BUSINESSES") {
    return "Valid at a selected business on Bookly.";
  }
  return "Valid on bookings across Bookly.";
};

const PROMO_QUALIFICATION =
  "Valid on eligible bookings only, subject to terms, availability and while the offer lasts.";

const renderArticle = (
  payload: Extract<MarketingCampaignEmailPayload, { type: "ARTICLE" }>,
): {
  subject: string;
  contentHtml: string;
  contentText: string;
  preheader: string;
} => {
  const { title, excerpt } = payload.snapshot;
  const subject = clampSubject(title);
  const contentHtml =
    emailTitle(title) + emailParagraph(excerpt) + emailButton("Read the article", payload.ctaUrl);
  const contentText = [title, "", excerpt, "", `Read the article: ${payload.ctaUrl}`].join("\n");
  return { subject, contentHtml, contentText, preheader: excerpt.slice(0, 140) };
};

const renderPromo = (
  payload: Extract<MarketingCampaignEmailPayload, { type: "PROMO" }>,
): {
  subject: string;
  contentHtml: string;
  contentText: string;
  preheader: string;
} => {
  const snap = payload.snapshot;
  const line = discountLine(snap);
  const subject = clampSubject(`${line} at Bookly`);
  const ends = `Ends ${formatEndDate(new Date(snap.expiresAt))}`;

  const contentHtml =
    emailTitle(`${line} on your next booking`) +
    emailParagraph(scopeCopy(snap.scope)) +
    emailParagraph("Use this code at checkout:") +
    emailCodeCard(snap.normalizedCode) +
    emailButton("Browse and book", payload.ctaUrl) +
    emailMutedNote(PROMO_QUALIFICATION) +
    emailMutedNote(ends);

  const contentText = [
    `${line} on your next booking`,
    "",
    scopeCopy(snap.scope),
    `Use code ${snap.normalizedCode} at checkout.`,
    "",
    `Browse and book: ${payload.ctaUrl}`,
    "",
    PROMO_QUALIFICATION,
    ends,
  ].join("\n");

  return {
    subject,
    contentHtml,
    contentText,
    preheader: `${line} — use code ${snap.normalizedCode}`,
  };
};

export const renderMarketingCampaignEmail = (
  payload: MarketingCampaignEmailPayload,
): RenderedEmail => {
  const parts = payload.type === "ARTICLE" ? renderArticle(payload) : renderPromo(payload);

  const layout = renderMarketingEmailLayout({
    preheader: parts.preheader,
    contentHtml: parts.contentHtml,
    contentText: parts.contentText,
    unsubscribeUrl: payload.unsubscribeUrl,
  });

  return {
    subject: parts.subject,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
