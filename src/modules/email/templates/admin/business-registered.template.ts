import { BOOKLY_BRAND, EMAIL_FONT_STACK } from "../../email.config.js";
import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import { emailParagraph, emailTitle, escapeHtml } from "../components/email-primitives.js";

/**
 * TRIGGER 6 — INTERNAL operational notification (not customer-facing) for a completed new
 * business-owner registration. Only safe registration facts; never a password/OTP/token/secret.
 */
export type BusinessRegisteredEmailData = {
  businessId: string;
  businessName: string;
  ownerName: string;
  ownerEmail: string;
  phone?: string | undefined;
  category?: string | undefined;
  city?: string | undefined;
  /** The actual persisted business status at completion (currently always "PENDING"). */
  status: string;
  registeredAtFormatted: string;
};

export const businessRegisteredSubject = (businessName: string): string =>
  `New business registration — ${businessName}`;

const row = (label: string, value: string): string =>
  `<tr><td style="padding:5px 0;font-family:${EMAIL_FONT_STACK};font-size:14px;color:${BOOKLY_BRAND.mutedText};">${escapeHtml(
    label,
  )}</td><td style="padding:5px 0 5px 16px;font-family:${EMAIL_FONT_STACK};font-size:14px;color:${BOOKLY_BRAND.ink};text-align:right;">${escapeHtml(
    value,
  )}</td></tr>`;

export const renderBusinessRegisteredEmail = (data: BusinessRegisteredEmailData): RenderedEmail => {
  const rows =
    row("Business", data.businessName) +
    row("Owner", data.ownerName) +
    row("Owner email", data.ownerEmail) +
    (data.phone ? row("Phone", data.phone) : "") +
    (data.category ? row("Category", data.category) : "") +
    (data.city ? row("City", data.city) : "") +
    row("Business ID", data.businessId) +
    row("Status", data.status) +
    row("Registered", data.registeredAtFormatted);

  const contentHtml =
    emailTitle("New business registration") +
    emailParagraph(
      `${data.businessName} completed the Bookly.cy business registration and is awaiting review.`,
    ) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0;">${rows}</table>`;

  const contentText = [
    "New business registration",
    "",
    `${data.businessName} completed the Bookly.cy business registration and is awaiting review.`,
    "",
    `Business: ${data.businessName}`,
    `Owner: ${data.ownerName}`,
    `Owner email: ${data.ownerEmail}`,
    ...(data.phone ? [`Phone: ${data.phone}`] : []),
    ...(data.category ? [`Category: ${data.category}`] : []),
    ...(data.city ? [`City: ${data.city}`] : []),
    `Business ID: ${data.businessId}`,
    `Status: ${data.status}`,
    `Registered: ${data.registeredAtFormatted}`,
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `New business registration — ${data.businessName} (awaiting review)`,
    contentHtml,
    contentText,
  });

  return {
    subject: businessRegisteredSubject(data.businessName),
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
