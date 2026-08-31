import { BOOKLY_BRAND, EMAIL_FONT_STACK, SUPPORT_EMAIL } from "../../email.config.js";
import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import {
  emailMutedNote,
  emailParagraph,
  emailTitle,
  escapeHtml,
} from "../components/email-primitives.js";
import type { NoShowEmailData } from "./no-show-email-data.js";

/**
 * TRIGGER 3 — customer, after a SUCCESSFUL no-show fee charge (domain outcome "charged"). All
 * figures are the domain's own values; this template runs no formula and applies no clamp.
 */
export const NO_SHOW_CHARGED_SUBJECT = "No-show fee charged" as const;

const row = (label: string, value: string): string =>
  `<tr><td style="padding:5px 0;font-family:${EMAIL_FONT_STACK};font-size:14px;color:${BOOKLY_BRAND.mutedText};">${escapeHtml(
    label,
  )}</td><td style="padding:5px 0 5px 16px;font-family:${EMAIL_FONT_STACK};font-size:14px;color:${BOOKLY_BRAND.ink};text-align:right;">${escapeHtml(
    value,
  )}</td></tr>`;

export const renderNoShowChargedEmail = (data: NoShowEmailData): RenderedEmail => {
  const c = data.charged;
  const summaryHtml = c
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 14px;">` +
      row("Booking reference", data.bookingReference) +
      row("Business", data.businessName) +
      row("Appointment", `${data.appointmentDate}, ${data.appointmentTime}`) +
      row("No-show fee rate", `${c.noShowPercentage}%`) +
      row("Eligible booking amount", c.eligibleBasisFormatted) +
      row("No-show fee", c.grossFeeFormatted) +
      row("Already covered by your deposit", c.upfrontAppliedFormatted) +
      row("Charged to your card now", c.additionalChargeFormatted) +
      `</table>`
    : "";

  const summaryText = c
    ? [
        `Booking reference: ${data.bookingReference}`,
        `Business: ${data.businessName}`,
        `Appointment: ${data.appointmentDate}, ${data.appointmentTime}`,
        `No-show fee rate: ${c.noShowPercentage}%`,
        `Eligible booking amount: ${c.eligibleBasisFormatted}`,
        `No-show fee: ${c.grossFeeFormatted}`,
        `Already covered by your deposit: ${c.upfrontAppliedFormatted}`,
        `Charged to your card now: ${c.additionalChargeFormatted}`,
      ].join("\n")
    : `Booking reference: ${data.bookingReference}`;

  const contentHtml =
    emailTitle("No-show fee charged") +
    emailParagraph(
      `Hi ${data.customerFirstName}, because the appointment below was missed, ${data.businessName}'s no-show policy has been applied to your booking.`,
    ) +
    summaryHtml +
    emailParagraph(
      "Part of the fee was covered by the deposit already collected when you booked; only the remaining amount was charged to your card.",
    ) +
    emailMutedNote(`If you think this is a mistake, contact us at ${SUPPORT_EMAIL}.`);

  const contentText = [
    "No-show fee charged",
    "",
    `Hi ${data.customerFirstName}, because the appointment below was missed, ${data.businessName}'s no-show policy has been applied to your booking.`,
    "",
    summaryText,
    "",
    "Part of the fee was covered by the deposit already collected when you booked; only the remaining amount was charged to your card.",
    "",
    `If you think this is a mistake, contact us at ${SUPPORT_EMAIL}.`,
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `A no-show fee was applied to booking ${data.bookingReference}.`,
    contentHtml,
    contentText,
  });

  return {
    subject: NO_SHOW_CHARGED_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
