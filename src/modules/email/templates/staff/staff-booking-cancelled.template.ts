import { SUPPORT_EMAIL } from "../../email.config.js";
import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import { emailMutedNote, emailParagraph, emailTitle } from "../components/email-primitives.js";

/**
 * STAFF NOTIFICATION — a staff member assigned to a booking (via a service line's
 * `responsibleStaffMembershipId`) is told the appointment was cancelled. Operational only:
 * booking reference, business, when it was, which service(s) they were covering, and who
 * cancelled it. Deliberately carries NO fee / refund / deposit detail (staff don't need the
 * money side) and NO "view booking" CTA (no staff-facing per-booking route exists — see the
 * audit report's CTA section).
 */
export type StaffBookingCancelledPayload = {
  staffFirstName: string;
  bookingReference: string;
  businessName: string;
  customerName: string;
  appointmentDate: string;
  appointmentTime: string;
  services: string[];
  cancelledBy: "CUSTOMER" | "BUSINESS";
};

export const STAFF_BOOKING_CANCELLED_SUBJECT = "A booking assigned to you was cancelled" as const;

const cancelledByLabel = (cancelledBy: "CUSTOMER" | "BUSINESS"): string =>
  cancelledBy === "CUSTOMER" ? "the customer" : "the business";

export const renderStaffBookingCancelledEmail = (
  payload: StaffBookingCancelledPayload,
): RenderedEmail => {
  const servicesLine =
    payload.services.length > 0 ? payload.services.join(", ") : "the booked service";

  const factLines = [
    `Booking reference: ${payload.bookingReference}`,
    `Business: ${payload.businessName}`,
    `Customer: ${payload.customerName}`,
    `Appointment: ${payload.appointmentDate} at ${payload.appointmentTime}`,
    `Service(s) you were covering: ${servicesLine}`,
    `Cancelled by: ${cancelledByLabel(payload.cancelledBy)}`,
  ];

  const contentHtml =
    emailTitle("A booking assigned to you was cancelled") +
    emailParagraph(
      `Hi ${payload.staffFirstName}, a booking you were assigned to has been cancelled. You no longer need to cover this appointment.`,
    ) +
    factLines.map((line) => emailParagraph(line)).join("") +
    emailMutedNote(`Need help? Contact us at ${SUPPORT_EMAIL}.`);

  const contentText = [
    "A booking assigned to you was cancelled",
    "",
    `Hi ${payload.staffFirstName}, a booking you were assigned to has been cancelled. You no longer need to cover this appointment.`,
    "",
    ...factLines,
    "",
    `Need help? Contact us at ${SUPPORT_EMAIL}.`,
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `${payload.businessName} — booking ${payload.bookingReference} cancelled`,
    contentHtml,
    contentText,
  });

  return {
    subject: STAFF_BOOKING_CANCELLED_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
