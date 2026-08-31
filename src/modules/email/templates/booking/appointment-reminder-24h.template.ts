import type { BookingDocument } from "../../../booking/booking.model.js";
import { BOOKLY_BRAND, EMAIL_FONT_STACK, SUPPORT_EMAIL } from "../../email.config.js";
import { buildFrontendUrl } from "../../email.links.js";
import type { RenderedEmail } from "../../email.types.js";
import {
  durationMinutesBetween,
  formatDateInTimezone,
  formatTimeInTimezone,
} from "../components/email-format.js";
import { renderEmailLayout } from "../components/email-layout.js";
import {
  emailButton,
  emailDivider,
  emailMutedNote,
  emailParagraph,
  emailTitle,
  escapeHtml,
} from "../components/email-primitives.js";
import { formatFulfilmentAddress } from "./booking-email-data.js";

/**
 * The 24-hour appointment reminder — a transactional nudge, NOT a mandatory booking record.
 * Whether it is sent at all is gated by `UserProfile.notifications.appointmentReminderEmail`
 * (see CustomerNotificationPolicy) BEFORE this template is ever enqueued; no template does a DB
 * read or a preference check.
 *
 * Contains no payment data and no tokens — only the facts a customer needs to show up: who,
 * when (formatted in `Booking.schedule.timezone`, exactly like every other Bookly surface),
 * where, and what. The "manage" link is the existing authenticated `/customer/bookings/view`
 * route — never an invented tokenized URL.
 */
export type AppointmentReminderEmailServiceLine = {
  name: string;
  durationMin: number;
  staffName?: string;
};

export type AppointmentReminderEmailData = {
  customerName: string;
  businessName: string;
  reference: string;
  /** Business/venue-local, from `Booking.schedule.timezone`. */
  appointmentDate: string;
  appointmentTime: string;
  durationMin: number;
  /** IANA zone the times are in — shown so a travelling customer isn't misled. */
  venueTimezone: string;
  serviceLines: AppointmentReminderEmailServiceLine[];
  fulfilment:
    | { kind: "AT_BUSINESS_LOCATION"; address: string | null }
    | { kind: "TRAVEL_TO_CUSTOMER"; address: string | null };
  /** `/customer/bookings/view?id=<id>` — always present (reminders are linked-account only). */
  customerBookingUrlPath: string;
};

export const APPOINTMENT_REMINDER_24H_SUBJECT = "Reminder: your appointment is tomorrow" as const;

/** Build the reminder payload from a committed Booking's own snapshots + the Business name.
 * Pure — no I/O, no money arithmetic. Times come straight from `schedule.timezone`. */
export const buildAppointmentReminderEmailData = (
  booking: BookingDocument,
  context: { businessName: string },
): AppointmentReminderEmailData => {
  const tz = booking.schedule.timezone;
  return {
    customerName: booking.customer.contact.firstName,
    businessName: context.businessName,
    reference: booking.reference,
    appointmentDate: formatDateInTimezone(booking.schedule.startAt, tz),
    appointmentTime: formatTimeInTimezone(booking.schedule.startAt, tz),
    durationMin: durationMinutesBetween(booking.schedule.startAt, booking.schedule.endAt),
    venueTimezone: tz,
    serviceLines: booking.serviceLines.map((line) => ({
      name: line.serviceSnapshot.name,
      durationMin: line.serviceSnapshot.durationMin,
      ...(line.staffSnapshot
        ? {
            staffName: [line.staffSnapshot.firstName, line.staffSnapshot.lastName]
              .filter(Boolean)
              .join(" "),
          }
        : {}),
    })),
    fulfilment: {
      kind: booking.fulfilment.mode as "AT_BUSINESS_LOCATION" | "TRAVEL_TO_CUSTOMER",
      address: formatFulfilmentAddress(booking),
    },
    customerBookingUrlPath: `/customer/bookings/view?id=${String(booking._id)}`,
  };
};

const detailRow = (label: string, value: string): string =>
  `<tr>` +
  `<td style="padding:6px 0;font-family:${EMAIL_FONT_STACK};font-size:14px;color:${BOOKLY_BRAND.mutedText};white-space:nowrap;vertical-align:top;">${escapeHtml(
    label,
  )}</td>` +
  `<td style="padding:6px 0 6px 16px;font-family:${EMAIL_FONT_STACK};font-size:14px;color:${BOOKLY_BRAND.ink};text-align:right;">${escapeHtml(
    value,
  )}</td>` +
  `</tr>`;

const serviceSummary = (line: AppointmentReminderEmailServiceLine): string =>
  `${line.name} (${line.durationMin} min${line.staffName ? ` · ${line.staffName}` : ""})`;

export const renderAppointmentReminder24hEmail = (
  data: AppointmentReminderEmailData,
): RenderedEmail => {
  const locationLabel =
    data.fulfilment.kind === "TRAVEL_TO_CUSTOMER" ? "At your address" : "At the venue";
  const locationValue = data.fulfilment.address ?? locationLabel;

  const detailsHtml =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;">` +
    detailRow("Booking reference", data.reference) +
    detailRow("Business", data.businessName) +
    detailRow("Date", data.appointmentDate) +
    detailRow("Time", `${data.appointmentTime} (${data.durationMin} min)`) +
    detailRow(locationLabel, locationValue) +
    data.serviceLines.map((line) => detailRow("Service", serviceSummary(line))).join("") +
    `</table>` +
    emailDivider();

  const contentHtml =
    emailTitle("Your appointment is tomorrow") +
    emailParagraph(
      `Hi ${data.customerName}, this is a reminder that your appointment with ${data.businessName} is coming up in about 24 hours.`,
    ) +
    detailsHtml +
    emailMutedNote(`Times are shown in the venue's local timezone (${data.venueTimezone}).`) +
    emailButton("View your booking", buildFrontendUrl(data.customerBookingUrlPath)) +
    emailMutedNote(
      `Need to change or cancel? Manage it from your booking, or contact ${SUPPORT_EMAIL}.`,
    );

  const contentText = [
    "Your appointment is tomorrow",
    "",
    `Hi ${data.customerName}, this is a reminder that your appointment with ${data.businessName} is coming up in about 24 hours.`,
    "",
    `Booking reference: ${data.reference}`,
    `Business: ${data.businessName}`,
    `Date: ${data.appointmentDate}`,
    `Time: ${data.appointmentTime} (${data.durationMin} min)`,
    `${locationLabel}: ${locationValue}`,
    ...data.serviceLines.map((line) => `Service: ${serviceSummary(line)}`),
    "",
    `Times are shown in the venue's local timezone (${data.venueTimezone}).`,
    "",
    `View your booking: ${buildFrontendUrl(data.customerBookingUrlPath)}`,
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `${data.businessName} — tomorrow at ${data.appointmentTime}`,
    contentHtml,
    contentText,
  });

  return {
    subject: APPOINTMENT_REMINDER_24H_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
