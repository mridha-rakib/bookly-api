import { SUPPORT_EMAIL } from "../../email.config.js";
import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import { emailMutedNote, emailParagraph, emailTitle } from "../components/email-primitives.js";

/**
 * TRIGGER 1 — a Business Owner (or Supervisor) added this person to their client list. This is
 * NOT an account invite: Bookly's client-creation flow does not issue a password, activation
 * link, or login, so this email never implies the recipient can sign in.
 */
export type ClientCreatedEmailData = {
  clientFirstName: string;
  businessName: string;
};

export const CLIENT_CREATED_SUBJECT = "You've been added as a client" as const;

export const renderClientCreatedEmail = (data: ClientCreatedEmailData): RenderedEmail => {
  const contentHtml =
    emailTitle("You've been added as a client") +
    emailParagraph(
      `Hi ${data.clientFirstName}, ${data.businessName} has added you to their client list on Bookly.cy so they can manage your appointments and booking details.`,
    ) +
    emailParagraph(
      "There's nothing you need to do right now. If you book with them, you'll get a confirmation email with the appointment details.",
    ) +
    emailMutedNote(
      `If you don't recognise ${data.businessName}, you can ignore this email or contact us at ${SUPPORT_EMAIL}.`,
    );

  const contentText = [
    "You've been added as a client",
    "",
    `Hi ${data.clientFirstName}, ${data.businessName} has added you to their client list on Bookly.cy so they can manage your appointments and booking details.`,
    "",
    "There's nothing you need to do right now. If you book with them, you'll get a confirmation email with the appointment details.",
    "",
    `If you don't recognise ${data.businessName}, you can ignore this email or contact us at ${SUPPORT_EMAIL}.`,
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `${data.businessName} added you to their Bookly client list.`,
    contentHtml,
    contentText,
  });

  return {
    subject: CLIENT_CREATED_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
