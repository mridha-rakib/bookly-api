import { SUPPORT_EMAIL } from "../../email.config.js";
import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import { emailMutedNote, emailParagraph, emailTitle } from "../components/email-primitives.js";

/**
 * STAFF NOTIFICATION — a staff member assigned to a booking is told its appointment date/time
 * changed (an actual `BookingLifecycleService` reschedule, customer- or owner-initiated). Fires
 * only for a real date/time move on a booking that has assigned staff — never for a notes /
 * price / metadata edit (reschedule is the only path that writes `schedule.startAt`). Carries
 * previous vs new appointment only; no financial detail, no CTA (no staff-facing per-booking
 * route exists — see the audit report).
 */
export type StaffBookingScheduleChangedPayload = {
  staffFirstName: string;
  bookingReference: string;
  businessName: string;
  customerName: string;
  previousDate: string;
  previousTime: string;
  newDate: string;
  newTime: string;
  services: string[];
};

export const STAFF_BOOKING_SCHEDULE_CHANGED_SUBJECT =
  "A booking assigned to you was rescheduled" as const;

export const renderStaffBookingScheduleChangedEmail = (
  payload: StaffBookingScheduleChangedPayload,
): RenderedEmail => {
  const servicesLine =
    payload.services.length > 0 ? payload.services.join(", ") : "the booked service";

  const factLines = [
    `Booking reference: ${payload.bookingReference}`,
    `Business: ${payload.businessName}`,
    `Customer: ${payload.customerName}`,
    `Previous appointment: ${payload.previousDate} at ${payload.previousTime}`,
    `New appointment: ${payload.newDate} at ${payload.newTime}`,
    `Service(s) you are covering: ${servicesLine}`,
  ];

  const contentHtml =
    emailTitle("A booking assigned to you was rescheduled") +
    emailParagraph(
      `Hi ${payload.staffFirstName}, the appointment time for a booking you are assigned to has changed. Please update your plans accordingly.`,
    ) +
    factLines.map((line) => emailParagraph(line)).join("") +
    emailMutedNote(`Need help? Contact us at ${SUPPORT_EMAIL}.`);

  const contentText = [
    "A booking assigned to you was rescheduled",
    "",
    `Hi ${payload.staffFirstName}, the appointment time for a booking you are assigned to has changed. Please update your plans accordingly.`,
    "",
    ...factLines,
    "",
    `Need help? Contact us at ${SUPPORT_EMAIL}.`,
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `${payload.businessName} — booking ${payload.bookingReference} rescheduled`,
    contentHtml,
    contentText,
  });

  return {
    subject: STAFF_BOOKING_SCHEDULE_CHANGED_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
