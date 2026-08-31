import { BOOKLY_BRAND, EMAIL_FONT_STACK } from "../../email.config.js";

/**
 * A deliberately small set of email-safe HTML primitives (Phase I). Every primitive is inline-
 * styled, table-safe where it matters, and has a matching plain-text helper so a template can
 * build HTML and text from the same call site. Trivial markup is NOT wrapped in a helper.
 */

const AMP_RE = /&/g;
const LT_RE = /</g;
const GT_RE = />/g;
const DQUOTE_RE = /"/g;
const SQUOTE_RE = /'/g;

export const escapeHtml = (value: string): string =>
  value
    .replace(AMP_RE, "&amp;")
    .replace(LT_RE, "&lt;")
    .replace(GT_RE, "&gt;")
    .replace(DQUOTE_RE, "&quot;")
    .replace(SQUOTE_RE, "&#39;");

export const emailTitle = (text: string): string =>
  `<h1 style="margin:0 0 16px;font-family:${EMAIL_FONT_STACK};font-size:22px;line-height:1.3;font-weight:700;color:${BOOKLY_BRAND.ink};">${escapeHtml(
    text,
  )}</h1>`;

export const emailParagraph = (text: string): string =>
  `<p style="margin:0 0 16px;font-family:${EMAIL_FONT_STACK};font-size:15px;line-height:1.6;color:${BOOKLY_BRAND.slate};">${escapeHtml(
    text,
  )}</p>`;

/** A large, spaced, easy-to-read one-line code block (OTP / reference codes). */
export const emailCodeCard = (code: string): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;">` +
  `<tr><td align="center" style="background:${BOOKLY_BRAND.pageBackground};border:1px solid ${BOOKLY_BRAND.border};border-radius:10px;padding:20px 16px;">` +
  `<span style="font-family:${EMAIL_FONT_STACK};font-size:32px;letter-spacing:8px;font-weight:700;color:${BOOKLY_BRAND.ink};">${escapeHtml(
    code,
  )}</span>` +
  `</td></tr></table>`;

export const emailDivider = (): string =>
  `<hr style="border:none;border-top:1px solid ${BOOKLY_BRAND.border};margin:24px 0;" />`;

export const emailButton = (label: string, href: string): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;"><tr>` +
  `<td align="center" style="border-radius:8px;background:${BOOKLY_BRAND.cyan};">` +
  `<a href="${escapeHtml(href)}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:${EMAIL_FONT_STACK};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(
    label,
  )}</a></td></tr></table>`;

export const emailMutedNote = (text: string): string =>
  `<p style="margin:0 0 8px;font-family:${EMAIL_FONT_STACK};font-size:13px;line-height:1.6;color:${BOOKLY_BRAND.mutedText};">${escapeHtml(
    text,
  )}</p>`;
