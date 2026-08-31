import { SUPPORT_EMAIL } from "../../email.config.js";
import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import { emailMutedNote, emailParagraph, emailTitle } from "../components/email-primitives.js";

/**
 * STAFF NOTIFICATION — the affected staff member is told their role at a Business changed
 * (BUSINESS_OWNER used the role control; a `StaffAccessEvent` of type ROLE_CHANGED was persisted
 * in the SAME transaction as the role write). States only the two persisted role labels — no
 * permission ids, no invented list of capabilities, no CTA (no staff-facing dashboard route
 * exists to link to).
 */
export type StaffRoleChangedPayload = {
  staffFirstName: string;
  businessName: string;
  /** Human-readable role labels, e.g. "Staff" / "Supervisor" — already mapped by the notifier. */
  previousRole: string;
  newRole: string;
};

export const STAFF_ROLE_CHANGED_SUBJECT = "Your role at Bookly has changed" as const;

export const renderStaffRoleChangedEmail = (payload: StaffRoleChangedPayload): RenderedEmail => {
  const contentHtml =
    emailTitle(`Your role at ${payload.businessName} has changed`) +
    emailParagraph(`Hi ${payload.staffFirstName},`) +
    emailParagraph(`Your role at ${payload.businessName} has been updated.`) +
    emailParagraph(`Previous role: ${payload.previousRole}`) +
    emailParagraph(`New role: ${payload.newRole}`) +
    emailParagraph("Your available access may now reflect your updated role.") +
    emailMutedNote(`Questions? Contact ${payload.businessName}, or reach us at ${SUPPORT_EMAIL}.`);

  const contentText = [
    `Your role at ${payload.businessName} has changed`,
    "",
    `Hi ${payload.staffFirstName},`,
    "",
    `Your role at ${payload.businessName} has been updated.`,
    "",
    `Previous role: ${payload.previousRole}`,
    `New role: ${payload.newRole}`,
    "",
    "Your available access may now reflect your updated role.",
    "",
    `Questions? Contact ${payload.businessName}, or reach us at ${SUPPORT_EMAIL}.`,
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `Your role at ${payload.businessName} is now ${payload.newRole}.`,
    contentHtml,
    contentText,
  });

  return {
    subject: STAFF_ROLE_CHANGED_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
