import { SUPPORT_EMAIL } from "../../email.config.js";
import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import { emailMutedNote, emailParagraph, emailTitle } from "../components/email-primitives.js";

/**
 * STAFF NOTIFICATION — the affected staff member is told their access to a Business was
 * REACTIVATED (reversible `employmentActive: false -> true`; a `StaffAccessEvent` of type
 * REACTIVATED was persisted in the same transaction). No new password is sent and onboarding is
 * NOT re-triggered — the person keeps their existing Bookly staff account exactly as it was.
 */
export type StaffReactivatedPayload = {
  staffFirstName: string;
  businessName: string;
};

export const STAFF_REACTIVATED_SUBJECT = "Your access to Bookly has been restored" as const;

export const renderStaffReactivatedEmail = (payload: StaffReactivatedPayload): RenderedEmail => {
  const contentHtml =
    emailTitle(`Your access to ${payload.businessName} has been restored`) +
    emailParagraph(`Hi ${payload.staffFirstName},`) +
    emailParagraph(
      `Your staff access to ${payload.businessName} on Bookly is active again. You can keep using your existing Bookly staff account — no new sign-up or password is needed.`,
    ) +
    emailMutedNote(`Questions? Contact ${payload.businessName}, or reach us at ${SUPPORT_EMAIL}.`);

  const contentText = [
    `Your access to ${payload.businessName} has been restored`,
    "",
    `Hi ${payload.staffFirstName},`,
    "",
    `Your staff access to ${payload.businessName} on Bookly is active again. You can keep using your existing Bookly staff account — no new sign-up or password is needed.`,
    "",
    `Questions? Contact ${payload.businessName}, or reach us at ${SUPPORT_EMAIL}.`,
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `Your staff access to ${payload.businessName} is active again.`,
    contentHtml,
    contentText,
  });

  return {
    subject: STAFF_REACTIVATED_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
