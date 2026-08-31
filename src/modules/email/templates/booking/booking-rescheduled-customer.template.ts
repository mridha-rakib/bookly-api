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
 * MANDATORY customer transactional email — sent when a committed booking's appointment schedule
 * is changed, by the customer OR by the business (Owner/Supervisor). NOT the 24h reminder, NOT
 * preference-gated: whether it is sent is never checked against
 * `UserProfile.notifications.*` or `CustomerNotificationPolicy` (see
 * BookingRescheduledCustomerNotifier — no policy import).
 *
 * Contains no payment data, no tokens, and no internal actor identity — only the facts the
 * customer needs: what moved, from when, to when (both formatted in `Booking.schedule.timezone`,
 * which a reschedule never changes), where, and what. The "manage" link is the existing
 * authenticated `/customer/bookings/view` route, included only for a linked Customer account.
 */
export type BookingRescheduledEmailServiceLine = {
  name: string;
  durationMin: number;
};

export type BookingRescheduledEmailData = {
  customerFirstName: string;
  customerName: string;
  businessName: string;
  bookingReference: string;
  /** true when the move was made by the business (actorRole !== "CUSTOMER") — drives wording. */
  rescheduledByBusiness: boolean;
  /** Venue-local (from `Booking.schedule.timezone`), from the reschedule history entry. */
  previousDate: string;
  previousTime: string;
  newDate: string;
  newTime: string;
  durationMin: number;
  /** IANA zone the times are in — shown so a travelling customer isn't misled. */
  venueTimezone: string;
  services: BookingRescheduledEmailServiceLine[];
  fulfilment:
    | { kind: "AT_BUSINESS_LOCATION"; address: string | null }
    | { kind: "TRAVEL_TO_CUSTOMER"; address: string | null };
  /** `/customer/bookings/view?id=<id>` — present only when the customer has a linked account. */
  customerBookingUrlPath?: string;
};

export const BOOKING_RESCHEDULED_CUSTOMER_SUBJECT =
  "Your appointment has been rescheduled" as const;

/**
 * Build the reschedule-confirmation payload from a committed Booking's own snapshots + the
 * Business name. Pure — no I/O, no money arithmetic. Old/new times come from the LAST
 * `rescheduleHistory` entry (the one the reschedule transaction just appended); both are
 * formatted in `schedule.timezone`, which a reschedule never mutates.
 */
export const buildBookingRescheduledEmailData = (
  booking: BookingDocument,
  context: { businessName: string },
): BookingRescheduledEmailData => {
  const entry = booking.rescheduleHistory[booking.rescheduleHistory.length - 1];
  if (!entry) {
    throw new Error("buildBookingRescheduledEmailData: booking has no reschedule history entry");
  }
  const tz = booking.schedule.timezone;
  const previousStart = new Date(entry.previousStart);
  const newStart = new Date(entry.newStart);
  const newEnd = new Date(entry.newEnd);

  return {
    customerFirstName: booking.customer.contact.firstName,
    customerName: [booking.customer.contact.firstName, booking.customer.contact.lastName]
      .filter(Boolean)
      .join(" "),
    businessName: context.businessName,
    bookingReference: booking.reference,
    rescheduledByBusiness: entry.actorRole !== "CUSTOMER",
    previousDate: formatDateInTimezone(previousStart, tz),
    previousTime: formatTimeInTimezone(previousStart, tz),
    newDate: formatDateInTimezone(newStart, tz),
    newTime: formatTimeInTimezone(newStart, tz),
    durationMin: durationMinutesBetween(newStart, newEnd),
    venueTimezone: tz,
    services: booking.serviceLines.map((line) => ({
      name: line.serviceSnapshot.name,
      durationMin: line.serviceSnapshot.durationMin,
    })),
    fulfilment: {
      kind: booking.fulfilment.mode as "AT_BUSINESS_LOCATION" | "TRAVEL_TO_CUSTOMER",
      address: formatFulfilmentAddress(booking),
    },
    ...(booking.customer.customerUserId
      ? { customerBookingUrlPath: `/customer/bookings/view?id=${String(booking._id)}` }
      : {}),
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

const serviceSummary = (line: BookingRescheduledEmailServiceLine): string =>
  `${line.name} (${line.durationMin} min)`;

export const renderBookingRescheduledCustomerEmail = (
  data: BookingRescheduledEmailData,
): RenderedEmail => {
  const locationLabel =
    data.fulfilment.kind === "TRAVEL_TO_CUSTOMER" ? "At your address" : "At the venue";
  const locationValue = data.fulfilment.address ?? locationLabel;

  const movedSentence = data.rescheduledByBusiness
    ? `${data.businessName} has moved your appointment to a new time.`
    : `You've rescheduled your appointment with ${data.businessName}.`;

  const detailsHtml =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;">` +
    detailRow("Booking reference", data.bookingReference) +
    detailRow("Business", data.businessName) +
    detailRow("Previous", `${data.previousDate} at ${data.previousTime}`) +
    detailRow("New", `${data.newDate} at ${data.newTime} (${data.durationMin} min)`) +
    detailRow(locationLabel, locationValue) +
    data.services.map((line) => detailRow("Service", serviceSummary(line))).join("") +
    `</table>` +
    emailDivider();

  const cta = data.customerBookingUrlPath
    ? emailButton("View your booking", buildFrontendUrl(data.customerBookingUrlPath))
    : "";

  const contentHtml =
    emailTitle("Your appointment has been rescheduled") +
    emailParagraph(`Hi ${data.customerFirstName}, ${movedSentence}`) +
    detailsHtml +
    emailMutedNote(`Times are shown in the venue's local timezone (${data.venueTimezone}).`) +
    cta +
    emailMutedNote(
      `Need to change or cancel? Manage it from your booking, or contact ${SUPPORT_EMAIL}.`,
    );

  const contentText = [
    "Your appointment has been rescheduled",
    "",
    `Hi ${data.customerFirstName}, ${movedSentence}`,
    "",
    `Booking reference: ${data.bookingReference}`,
    `Business: ${data.businessName}`,
    `Previous: ${data.previousDate} at ${data.previousTime}`,
    `New: ${data.newDate} at ${data.newTime} (${data.durationMin} min)`,
    `${locationLabel}: ${locationValue}`,
    ...data.services.map((line) => `Service: ${serviceSummary(line)}`),
    "",
    `Times are shown in the venue's local timezone (${data.venueTimezone}).`,
    ...(data.customerBookingUrlPath
      ? ["", `View your booking: ${buildFrontendUrl(data.customerBookingUrlPath)}`]
      : []),
    "",
    `Need to change or cancel? Manage it from your booking, or contact ${SUPPORT_EMAIL}.`,
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `${data.businessName} — now ${data.newDate} at ${data.newTime}`,
    contentHtml,
    contentText,
  });

  return {
    subject: BOOKING_RESCHEDULED_CUSTOMER_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
