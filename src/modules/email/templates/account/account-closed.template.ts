import { SUPPORT_EMAIL } from "../../email.config.js";
import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import { emailMutedNote, emailParagraph, emailTitle } from "../components/email-primitives.js";

/**
 * CUSTOMER NOTIFICATION — confirms the customer's own account has been closed at their request
 * (soft delete + anonymization via DELETE /auth/me). Sent once, best-effort, from the
 * post-commit tail of AuthService.deleteMyAccount to the address the account had BEFORE it was
 * freed. No sign-in link and no re-open link — closure is immediate and irreversible in this
 * version. `firstName` is captured before the profile is anonymized.
 */
export type AccountClosedPayload = {
  firstName: string;
};

export const ACCOUNT_CLOSED_SUBJECT = "Your Bookly account has been closed" as const;

export const renderAccountClosedEmail = (payload: AccountClosedPayload): RenderedEmail => {
  const contentHtml =
    emailTitle("Your Bookly account has been closed") +
    emailParagraph(`Hi ${payload.firstName},`) +
    emailParagraph(
      "Your Bookly account has been closed at your request. You can no longer sign in, and your personal details have been removed from your profile.",
    ) +
    emailParagraph(
      "Records we are required to keep — your past bookings and their payment history — are retained in anonymized form. This action cannot be undone, but you are welcome to create a new account at any time.",
    ) +
    emailMutedNote(`If you did not request this, contact us immediately at ${SUPPORT_EMAIL}.`);

  const contentText = [
    "Your Bookly account has been closed",
    "",
    `Hi ${payload.firstName},`,
    "",
    "Your Bookly account has been closed at your request. You can no longer sign in, and your personal details have been removed from your profile.",
    "",
    "Records we are required to keep — your past bookings and their payment history — are retained in anonymized form. This action cannot be undone, but you are welcome to create a new account at any time.",
    "",
    `If you did not request this, contact us immediately at ${SUPPORT_EMAIL}.`,
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: "Your Bookly account has been closed at your request.",
    contentHtml,
    contentText,
  });

  return {
    subject: ACCOUNT_CLOSED_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
