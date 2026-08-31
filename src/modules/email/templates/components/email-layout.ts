import {
  BOOKLY_EMAIL_CID,
  booklyIconAttachment,
  booklyWordmarkAttachment,
} from "../../assets/bookly-email-assets.js";
import {
  BOOKLY_BRAND,
  EMAIL_AUTOMATED_NOTICE,
  EMAIL_CONTENT_WIDTH_PX,
  EMAIL_COPYRIGHT,
  EMAIL_FONT_STACK,
  getEmailFooterLinks,
  SUPPORT_EMAIL,
} from "../../email.config.js";
import type { EmailAttachment } from "../../email.types.js";
import { escapeHtml } from "./email-primitives.js";

/**
 * The shared branded shell every transactional email uses (Phase I / J). Header + footer are
 * defined once here; the purpose-specific body is passed in as `contentHtml` / `contentText`.
 * No JS, no external CSS, no web fonts, ~600px, table-based outer structure, inline styles.
 */

export type EmailLayoutInput = {
  /** Hidden pre-header shown in the inbox list preview. */
  preheader: string;
  contentHtml: string;
  contentText: string;
  /**
   * When false, the returned `text` is exactly `contentText` with no appended footer block.
   * Used by the compatibility wrappers around legacy OTP-purpose / notice emails whose callers
   * (and tests) expect the plain-text body verbatim. Defaults to true for real templates.
   */
  appendFooterToText?: boolean;
};

export type EmailLayoutResult = {
  html: string;
  text: string;
  /** The brand images the transport must attach so `cid:` references resolve. */
  attachments: EmailAttachment[];
};

/**
 * Centred branding block. The wordmark CID is the full Bookly.cy lockup (icon + wordmark), so a
 * single centred image is the whole header — no flexbox, no CSS classes, just an `align="center"`
 * table cell + `margin:0 auto` on a block-level image for the widest client coverage. The cyan
 * accent divider is a zero-height-safe coloured row directly under it.
 */
const renderHeader = (): string =>
  `<tr><td align="center" style="padding:32px 32px 22px;text-align:center;">` +
  `<img src="cid:${BOOKLY_EMAIL_CID.wordmark}" alt="Bookly.cy" width="184" height="56" style="display:block;border:0;outline:none;text-decoration:none;width:184px;max-width:100%;height:auto;margin:0 auto;" />` +
  `</td></tr>` +
  `<tr><td style="padding:0 32px;"><div style="height:3px;background:${BOOKLY_BRAND.cyan};border-radius:2px;font-size:0;line-height:0;">&nbsp;</div></td></tr>`;

/**
 * Centred footer: the Bookly "b" icon, the three nav links, and the support / copyright lines
 * are each centred with `align="center"` + `text-align:center` (Outlook needs both). Links are
 * inline `<a>` inside a centred block so they wrap and stay centred on narrow screens.
 */
const renderFooter = (): string => {
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
    `<div style="font-family:${EMAIL_FONT_STACK};font-size:13px;line-height:1.9;color:${BOOKLY_BRAND.slate};text-align:center;">${links}</div>` +
    `<div style="font-family:${EMAIL_FONT_STACK};font-size:12px;line-height:1.8;color:${BOOKLY_BRAND.mutedText};margin-top:12px;text-align:center;">` +
    `Need help? <a href="mailto:${SUPPORT_EMAIL}" style="color:${BOOKLY_BRAND.slate};text-decoration:none;">${SUPPORT_EMAIL}</a><br />` +
    `${escapeHtml(EMAIL_COPYRIGHT)} &nbsp;&middot;&nbsp; ${escapeHtml(EMAIL_AUTOMATED_NOTICE)}` +
    `</div></td></tr>`
  );
};

const footerText = (): string => {
  const links = getEmailFooterLinks()
    .map((link) => `${link.label}: ${link.href}`)
    .join("\n");
  return (
    `\n\n----------------------------------------\n` +
    `${links}\n` +
    `Need help? ${SUPPORT_EMAIL}\n` +
    `${EMAIL_COPYRIGHT} — ${EMAIL_AUTOMATED_NOTICE}\n`
  );
};

export const renderEmailLayout = (input: EmailLayoutInput): EmailLayoutResult => {
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
    renderFooter() +
    `</table></td></tr></table></body></html>`;

  const text =
    input.appendFooterToText === false
      ? input.contentText
      : `${input.contentText.trim()}${footerText()}`;

  return {
    html,
    text,
    attachments: [booklyWordmarkAttachment(), booklyIconAttachment()],
  };
};
