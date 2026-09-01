import {
  BOOKLY_EMAIL_CID,
  booklyIconAttachment,
  booklyWordmarkAttachment,
} from "../../assets/bookly-email-assets.js";
import {
  BOOKLY_BRAND,
  EMAIL_CONTENT_WIDTH_PX,
  EMAIL_COPYRIGHT,
  EMAIL_FONT_STACK,
  getEmailFooterLinks,
  SUPPORT_EMAIL,
} from "../../email.config.js";
import type { EmailAttachment } from "../../email.types.js";
import { escapeHtml } from "./email-primitives.js";

/**
 * Marketing Email Stage M2 — the branded shell for MARKETING email only.
 *
 * A deliberately separate file from `email-layout.ts` so the transactional shell is byte-for-byte
 * unchanged: the shared transactional footer must NEVER sprout an unsubscribe link, and this
 * footer must NEVER carry the "automated transactional email" notice. The header (centred Bookly
 * wordmark + cyan divider) is intentionally identical to the transactional one.
 *
 * The one structural difference is the footer: it leads with a required, visible unsubscribe
 * line, then the same Contact / Privacy / Terms links + support address + copyright. No JS, no
 * external CSS, no web fonts, ~600px, table-based, inline styles — same constraints as the
 * transactional layout.
 */

export type MarketingEmailLayoutInput = {
  /** Hidden pre-header shown in the inbox list preview. */
  preheader: string;
  contentHtml: string;
  contentText: string;
  /** Absolute URL of the customer-facing unsubscribe confirmation page (carries the signed
   * token). Required — a marketing email may not render without a working unsubscribe link. */
  unsubscribeUrl: string;
};

export type MarketingEmailLayoutResult = {
  html: string;
  text: string;
  attachments: EmailAttachment[];
};

const renderHeader = (): string =>
  `<tr><td align="center" style="padding:32px 32px 22px;text-align:center;">` +
  `<img src="cid:${BOOKLY_EMAIL_CID.wordmark}" alt="Bookly.cy" width="184" height="56" style="display:block;border:0;outline:none;text-decoration:none;width:184px;max-width:100%;height:auto;margin:0 auto;" />` +
  `</td></tr>` +
  `<tr><td style="padding:0 32px;"><div style="height:3px;background:${BOOKLY_BRAND.cyan};border-radius:2px;font-size:0;line-height:0;">&nbsp;</div></td></tr>`;

const renderFooter = (unsubscribeUrl: string): string => {
  const safeUnsub = escapeHtml(unsubscribeUrl);
  const links = getEmailFooterLinks()
    .map(
      (link) =>
        `<a href="${escapeHtml(link.href)}" target="_blank" style="color:${BOOKLY_BRAND.slate};text-decoration:none;white-space:nowrap;">${escapeHtml(
          link.label,
        )}</a>`,
    )
    .join(`<span style="color:${BOOKLY_BRAND.border};padding:0 10px;">|</span>`);

  return (
    `<tr><td align="center" style="padding:28px 32px 30px;border-top:1px solid ${BOOKLY_BRAND.border};text-align:center;">` +
    `<img src="cid:${BOOKLY_EMAIL_CID.icon}" alt="Bookly.cy" width="26" height="32" style="display:block;border:0;outline:none;text-decoration:none;height:auto;margin:0 auto 14px;" />` +
    `<div style="font-family:${EMAIL_FONT_STACK};font-size:12px;line-height:1.8;color:${BOOKLY_BRAND.mutedText};text-align:center;margin-bottom:10px;">` +
    `You are receiving this because you opted in to marketing email from Bookly.cy.<br />` +
    `<a href="${safeUnsub}" target="_blank" style="color:${BOOKLY_BRAND.slate};text-decoration:underline;">Unsubscribe</a>` +
    `</div>` +
    `<div style="font-family:${EMAIL_FONT_STACK};font-size:13px;line-height:1.9;color:${BOOKLY_BRAND.slate};text-align:center;">${links}</div>` +
    `<div style="font-family:${EMAIL_FONT_STACK};font-size:12px;line-height:1.8;color:${BOOKLY_BRAND.mutedText};margin-top:12px;text-align:center;">` +
    `Need help? <a href="mailto:${SUPPORT_EMAIL}" style="color:${BOOKLY_BRAND.slate};text-decoration:none;">${SUPPORT_EMAIL}</a><br />` +
    `${escapeHtml(EMAIL_COPYRIGHT)}` +
    `</div></td></tr>`
  );
};

const footerText = (unsubscribeUrl: string): string =>
  `\n\n----------------------------------------\n` +
  `You are receiving this because you opted in to marketing email from Bookly.cy.\n` +
  `Unsubscribe: ${unsubscribeUrl}\n` +
  `${getEmailFooterLinks()
    .map((link) => `${link.label}: ${link.href}`)
    .join("\n")}\n` +
  `Need help? ${SUPPORT_EMAIL}\n` +
  `${EMAIL_COPYRIGHT}\n`;

export const renderMarketingEmailLayout = (
  input: MarketingEmailLayoutInput,
): MarketingEmailLayoutResult => {
  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />` +
    `<meta name="viewport" content="width=device-width,initial-scale=1" />` +
    `<meta name="x-apple-disable-message-reformatting" /></head>` +
    `<body style="margin:0;padding:0;background:${BOOKLY_BRAND.pageBackground};">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BOOKLY_BRAND.pageBackground};padding:24px 12px;">` +
    `<tr><td align="center">` +
    `<table role="presentation" width="${EMAIL_CONTENT_WIDTH_PX}" cellpadding="0" cellspacing="0" style="max-width:${EMAIL_CONTENT_WIDTH_PX}px;width:100%;background:${BOOKLY_BRAND.cardBackground};border:1px solid ${BOOKLY_BRAND.border};border-radius:14px;overflow:hidden;">` +
    renderHeader() +
    `<tr><td style="padding:24px 32px 8px;">${input.contentHtml}</td></tr>` +
    renderFooter(input.unsubscribeUrl) +
    `</table></td></tr></table></body></html>`;

  const text = `${input.contentText.trim()}${footerText(input.unsubscribeUrl)}`;

  return {
    html,
    text,
    attachments: [booklyWordmarkAttachment(), booklyIconAttachment()],
  };
};
