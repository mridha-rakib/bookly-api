import { SUPPORT_EMAIL } from "../../email.config.js";
import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import { emailMutedNote, emailParagraph, emailTitle } from "../components/email-primitives.js";
import type { NoShowEmailData } from "./no-show-email-data.js";

/**
 * TRIGGER 5 — customer, after the business cancels/reverses the no-show process before any
 * charge (domain status NO_SHOW_CANCELLED, from `cancelNoShowByBusiness`). Deliberately distinct
 * from the waived email: the domain keeps NO_SHOW_CANCELLED and NO_SHOW_WAIVED as separate
 * terminal states.
 */
export const NO_SHOW_CANCELLED_SUBJECT = "No-show status cancelled" as const;

export const renderNoShowCancelledEmail = (data: NoShowEmailData): RenderedEmail => {
  const contentHtml =
    emailTitle("No-show status cancelled") +
    emailParagraph(
      `Hi ${data.customerFirstName}, the no-show status on your booking with ${data.businessName} has been cancelled.`,
    ) +
    emailParagraph(
      `The no-show process for this booking (reference ${data.bookingReference}, ${data.appointmentDate} at ${data.appointmentTime}) has been reversed, and no no-show charge will be made to your card.`,
    ) +
    emailMutedNote(`Questions? Contact us at ${SUPPORT_EMAIL}.`);

  const contentText = [
    "No-show status cancelled",
    "",
    `Hi ${data.customerFirstName}, the no-show status on your booking with ${data.businessName} has been cancelled.`,
    "",
    `The no-show process for this booking (reference ${data.bookingReference}, ${data.appointmentDate} at ${data.appointmentTime}) has been reversed, and no no-show charge will be made to your card.`,
    "",
    `Questions? Contact us at ${SUPPORT_EMAIL}.`,
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `The no-show status on booking ${data.bookingReference} has been cancelled.`,
    contentHtml,
    contentText,
  });

  return {
    subject: NO_SHOW_CANCELLED_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
