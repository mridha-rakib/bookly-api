import { SUPPORT_EMAIL } from "../../email.config.js";
import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import { emailMutedNote, emailParagraph, emailTitle } from "../components/email-primitives.js";
import type { NoShowEmailData } from "./no-show-email-data.js";

/**
 * TRIGGER 4 — customer, after a no-show fee is WAIVED (domain status NO_SHOW_WAIVED, from either
 * a business waiver or the auto-resolver's no-chargeable-amount / no-policy branches). No
 * internal waiver reason / note is ever included (not customer-facing).
 */
export const NO_SHOW_WAIVED_SUBJECT = "No-show fee waived" as const;

export const renderNoShowWaivedEmail = (data: NoShowEmailData): RenderedEmail => {
  const contentHtml =
    emailTitle("No-show fee waived") +
    emailParagraph(
      `Hi ${data.customerFirstName}, the no-show fee for your booking with ${data.businessName} has been waived.`,
    ) +
    emailParagraph(
      `No no-show charge will be made to your card for this booking (reference ${data.bookingReference}, ${data.appointmentDate} at ${data.appointmentTime}).`,
    ) +
    emailMutedNote(`Questions? Contact us at ${SUPPORT_EMAIL}.`);

  const contentText = [
    "No-show fee waived",
    "",
    `Hi ${data.customerFirstName}, the no-show fee for your booking with ${data.businessName} has been waived.`,
    "",
    `No no-show charge will be made to your card for this booking (reference ${data.bookingReference}, ${data.appointmentDate} at ${data.appointmentTime}).`,
    "",
    `Questions? Contact us at ${SUPPORT_EMAIL}.`,
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `The no-show fee for booking ${data.bookingReference} has been waived.`,
    contentHtml,
    contentText,
  });

  return {
    subject: NO_SHOW_WAIVED_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
