import type { BookingDocument } from "../../../booking/booking.model.js";
import { BOOKLY_BRAND, EMAIL_FONT_STACK } from "../../email.config.js";
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

/**
 * Fix #7 — transactional Business Owner email for a committed CUSTOMER-initiated reschedule.
 * Not preference-gated. Contains only what the Owner needs to act: who moved which appointment,
 * from when, to when (both in `Booking.schedule.timezone`, which a reschedule never changes), the
 * services and assigned professional. No payment, refund, token or internal identifiers, and no
 * customer contact details beyond the name. The link is the existing authenticated Business
 * dashboard bookings section (the booking reference identifies the appointment there).
 */
export type BookingRescheduledOwnerEmailData = {
  businessName: string;
  bookingReference: string;
  customerName: string;
  previousDate: string;
  previousTime: string;
  newDate: string;
  newTime: string;
  durationMin: number;
  venueTimezone: string;
  services: Array<{ name: string; durationMin: number; staffName?: string }>;
  manageBookingsUrlPath: string;
};

export const BUSINESS_BOOKINGS_PATH = "/business-dashboard?section=all-bookings";

export const bookingRescheduledOwnerSubject = (bookingReference: string): string =>
  `Booking rescheduled by customer — ${bookingReference}`;

/** Pure: derived from the committed Booking's last reschedule-history entry and snapshots. */
export const buildBookingRescheduledOwnerEmailData = (
  booking: BookingDocument,
  context: { businessName: string },
): BookingRescheduledOwnerEmailData => {
  const entry = booking.rescheduleHistory.at(-1);
  if (!entry) {
    throw new Error("buildBookingRescheduledOwnerEmailData: booking has no reschedule entry");
  }
  const tz = booking.schedule.timezone;
  const previousStart = new Date(entry.previousStart);
  const newStart = new Date(entry.newStart);
  return {
    businessName: context.businessName,
    bookingReference: booking.reference,
    customerName:
      [booking.customer.contact.firstName, booking.customer.contact.lastName]
        .filter(Boolean)
        .join(" ")
        .trim() || "Your customer",
    previousDate: formatDateInTimezone(previousStart, tz),
    previousTime: formatTimeInTimezone(previousStart, tz),
    newDate: formatDateInTimezone(newStart, tz),
    newTime: formatTimeInTimezone(newStart, tz),
    durationMin: durationMinutesBetween(newStart, new Date(entry.newEnd)),
    venueTimezone: tz,
    services: booking.serviceLines.map((line) => {
      const staffName = line.staffSnapshot
        ? [line.staffSnapshot.firstName, line.staffSnapshot.lastName]
            .filter(Boolean)
            .join(" ")
            .trim()
        : "";
      return {
        name: line.serviceSnapshot.name,
        durationMin: line.serviceSnapshot.durationMin,
        ...(staffName ? { staffName } : {}),
      };
    }),
    manageBookingsUrlPath: BUSINESS_BOOKINGS_PATH,
  };
};

const detailRow = (label: string, value: string): string =>
  `<tr>` +
  `<td style="padding:6px 0;font-family:${EMAIL_FONT_STACK};font-size:14px;color:${BOOKLY_BRAND.mutedText};white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>` +
  `<td style="padding:6px 0 6px 16px;font-family:${EMAIL_FONT_STACK};font-size:14px;color:${BOOKLY_BRAND.ink};text-align:right;">${escapeHtml(value)}</td>` +
  `</tr>`;

const serviceSummary = (line: BookingRescheduledOwnerEmailData["services"][number]): string =>
  `${line.name} (${line.durationMin} min${line.staffName ? ` · ${line.staffName}` : ""})`;

export const renderBookingRescheduledOwnerEmail = (
  data: BookingRescheduledOwnerEmailData,
): RenderedEmail => {
  const sentence = `${data.customerName} rescheduled their appointment with ${data.businessName}. The customer requested this change.`;
  const zoneNote = `Times are shown in ${data.businessName}'s timezone (${data.venueTimezone}).`;
  const url = buildFrontendUrl(data.manageBookingsUrlPath);

  const contentHtml =
    emailTitle("Booking rescheduled by customer") +
    emailParagraph(sentence) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;">` +
    detailRow("Booking reference", data.bookingReference) +
    detailRow("Customer", data.customerName) +
    detailRow("Previous", `${data.previousDate} at ${data.previousTime}`) +
    detailRow("New", `${data.newDate} at ${data.newTime} (${data.durationMin} min)`) +
    detailRow("Timezone", data.venueTimezone) +
    data.services.map((line) => detailRow("Service", serviceSummary(line))).join("") +
    `</table>` +
    emailDivider() +
    emailMutedNote(zoneNote) +
    emailButton("Manage bookings", url) +
    emailMutedNote(`Find this appointment by its booking reference ${data.bookingReference}.`);

  const contentText = [
    "Booking rescheduled by customer",
    "",
    sentence,
    "",
    `Booking reference: ${data.bookingReference}`,
    `Customer: ${data.customerName}`,
    `Previous: ${data.previousDate} at ${data.previousTime}`,
    `New: ${data.newDate} at ${data.newTime} (${data.durationMin} min)`,
    `Timezone: ${data.venueTimezone}`,
    ...data.services.map((line) => `Service: ${serviceSummary(line)}`),
    "",
    zoneNote,
    `Manage bookings: ${url}`,
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `${data.customerName} moved ${data.bookingReference} to ${data.newDate} at ${data.newTime}`,
    contentHtml,
    contentText,
  });

  return {
    subject: bookingRescheduledOwnerSubject(data.bookingReference),
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
