import { SUPPORT_EMAIL } from "../../email.config.js";
import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import { emailMutedNote, emailParagraph, emailTitle } from "../components/email-primitives.js";

/**
 * STAFF NOTIFICATION — the affected staff member is told their employment membership at a
 * Business has been removed (BUSINESS_OWNER used the "remove staff" action —
 * `StaffService.removeStaff` / `StaffRepository.softRemoveById`). Purely operational: it states
 * only the authoritative fact (membership removed) and never invents a reason — none is
 * persisted. The person's Bookly login/identity is untouched, which the copy makes explicit.
 */
export type StaffAccessRemovedPayload = {
  staffFirstName: string;
  businessName: string;
};

export const STAFF_ACCESS_REMOVED_SUBJECT = "Your team access has been removed" as const;

export const renderStaffAccessRemovedEmail = (
  payload: StaffAccessRemovedPayload,
): RenderedEmail => {
  const contentHtml =
    emailTitle("Your team access has been removed") +
    emailParagraph(`Hi ${payload.staffFirstName},`) +
    emailParagraph(
      `Your staff access to ${payload.businessName} on Bookly has been removed. You are no longer part of this business's team and will not receive further bookings or schedule assignments from them.`,
    ) +
    emailParagraph(
      `Your Bookly login itself still works. If you believe this was a mistake, please contact ${payload.businessName} directly.`,
    ) +
    emailMutedNote(`Questions about your Bookly account? Contact us at ${SUPPORT_EMAIL}.`);

  const contentText = [
    "Your team access has been removed",
    "",
    `Hi ${payload.staffFirstName},`,
    "",
    `Your staff access to ${payload.businessName} on Bookly has been removed. You are no longer part of this business's team and will not receive further bookings or schedule assignments from them.`,
    "",
    `Your Bookly login itself still works. If you believe this was a mistake, please contact ${payload.businessName} directly.`,
    "",
    `Questions about your Bookly account? Contact us at ${SUPPORT_EMAIL}.`,
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `Your staff access to ${payload.businessName} has been removed.`,
    contentHtml,
    contentText,
  });

  return {
    subject: STAFF_ACCESS_REMOVED_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
