import { SUPPORT_EMAIL } from "../../email.config.js";
import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import { emailMutedNote, emailParagraph, emailTitle } from "../components/email-primitives.js";

/**
 * STAFF NOTIFICATION — the affected staff member is told their access to a Business was
 * DEACTIVATED (reversible `employmentActive: true -> false`; a `StaffAccessEvent` of type
 * DEACTIVATED was persisted in the same transaction). This is NOT removal, NOT deletion, NOT a
 * ban/suspension — those are different (or non-existent) domain states and the copy never
 * implies them. No reason is captured or invented.
 */
export type StaffDeactivatedPayload = {
  staffFirstName: string;
  businessName: string;
};

export const STAFF_DEACTIVATED_SUBJECT = "Your access to Bookly has been deactivated" as const;

export const renderStaffDeactivatedEmail = (payload: StaffDeactivatedPayload): RenderedEmail => {
  const contentHtml =
    emailTitle(`Your access to ${payload.businessName} has been deactivated`) +
    emailParagraph(`Hi ${payload.staffFirstName},`) +
    emailParagraph(
      `Your staff access to ${payload.businessName} on Bookly has been deactivated. While it is deactivated you will not be assigned new bookings or schedules for this business. Your Bookly account itself is unaffected.`,
    ) +
    emailParagraph(
      `If this is unexpected, please contact the business owner, or reach us at ${SUPPORT_EMAIL}.`,
    ) +
    emailMutedNote("Access can be restored by the business at any time.");

  const contentText = [
    `Your access to ${payload.businessName} has been deactivated`,
    "",
    `Hi ${payload.staffFirstName},`,
    "",
    `Your staff access to ${payload.businessName} on Bookly has been deactivated. While it is deactivated you will not be assigned new bookings or schedules for this business. Your Bookly account itself is unaffected.`,
    "",
    `If this is unexpected, please contact the business owner, or reach us at ${SUPPORT_EMAIL}.`,
    "",
    "Access can be restored by the business at any time.",
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `Your staff access to ${payload.businessName} has been deactivated.`,
    contentHtml,
    contentText,
  });

  return {
    subject: STAFF_DEACTIVATED_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
