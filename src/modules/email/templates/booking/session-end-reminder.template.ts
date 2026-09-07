import type { BookingDocument } from "../../../booking/booking.model.js";
import { buildFrontendUrl } from "../../email.links.js";
import type { RenderedEmail } from "../../email.types.js";
import { formatDateInTimezone, formatTimeInTimezone } from "../components/email-format.js";
import { renderEmailLayout } from "../components/email-layout.js";
import {
  emailMutedNote,
  emailParagraph,
  emailTitle,
  escapeHtml,
} from "../components/email-primitives.js";

/**
 * The session-end reminder — a transactional, NOT preference-gated email (see
 * CustomerNotificationPolicy's own "scope guard" doc comment; this reminder is never routed
 * through it). Whether it exists at all is decided once, at Booking-creation time, from
 * `Booking.sessionEndReminderSnapshot` (itself a snapshot of `Service.sessionExpiryAlert` — see
 * booking.model.ts's own doc comment); this template never reads live Service config.
 *
 * Deliberately minimal per product scope: Service name, Business name, and the session's
 * scheduled end time — nothing about payment, refunds, cancellation penalties, attendance, or
 * internal ids, and never a claim that the session has already ended (this fires BEFORE endAt).
 */
export type SessionEndReminderEmailData = {
  customerName: string;
  businessName: string;
  serviceName: string;
  /** Business/venue-local, from `Booking.schedule.timezone`. */
  endDate: string;
  endTime: string;
  /** IANA zone the time is in — shown so a travelling customer isn't misled. */
  venueTimezone: string;
  /** `/customer/bookings/view?id=<id>` — always present (reminders are linked-account only). */
  customerBookingUrlPath: string;
};

export const SESSION_END_REMINDER_SUBJECT = "Your session is ending soon" as const;

/** Build the reminder payload from a committed Booking's own snapshot + the Business name. Pure
 * — no I/O. Times come straight from `schedule.timezone`. */
export const buildSessionEndReminderEmailData = (
  booking: BookingDocument,
  context: { businessName: string },
): SessionEndReminderEmailData => {
  const tz = booking.schedule.timezone;
  return {
    customerName: booking.customer.contact.firstName,
    businessName: context.businessName,
    serviceName: booking.serviceLines[0]?.serviceSnapshot.name ?? "your session",
    endDate: formatDateInTimezone(booking.schedule.endAt, tz),
    endTime: formatTimeInTimezone(booking.schedule.endAt, tz),
    venueTimezone: tz,
    customerBookingUrlPath: `/customer/bookings/view?id=${String(booking._id)}`,
  };
};

export const renderSessionEndReminderEmail = (data: SessionEndReminderEmailData): RenderedEmail => {
  const contentHtml =
    emailTitle("Your session is ending soon") +
    emailParagraph(
      `Hi ${escapeHtml(data.customerName)}, your session for ${escapeHtml(
        data.serviceName,
      )} with ${escapeHtml(data.businessName)} is scheduled to end at ${escapeHtml(
        data.endTime,
      )} on ${escapeHtml(data.endDate)}.`,
    ) +
    emailMutedNote(`Times are shown in the venue's local timezone (${data.venueTimezone}).`);

  const contentText = [
    "Your session is ending soon",
    "",
    `Hi ${data.customerName}, your session for ${data.serviceName} with ${data.businessName} is scheduled to end at ${data.endTime} on ${data.endDate}.`,
    "",
    `Times are shown in the venue's local timezone (${data.venueTimezone}).`,
    "",
    `View your booking: ${buildFrontendUrl(data.customerBookingUrlPath)}`,
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `${data.businessName} — ending at ${data.endTime}`,
    contentHtml,
    contentText,
  });

  return {
    subject: SESSION_END_REMINDER_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
