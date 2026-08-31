import { SUPPORT_EMAIL } from "../../email.config.js";
import { buildFrontendUrl } from "../../email.links.js";
import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import {
  emailButton,
  emailMutedNote,
  emailParagraph,
  emailTitle,
} from "../components/email-primitives.js";
import { renderBookingDetailsHtml, renderBookingDetailsText } from "./booking-details-section.js";
import type { BookingEmailData } from "./booking-email-data.js";

/**
 * TRIGGER 2 (recipient A) — the customer who booked it themselves. Wording assumes the customer
 * initiated the booking. Never reused for a business-created booking (that is
 * BOOKING_FOR_CLIENT_CONFIRMED).
 */
export const BOOKING_CUSTOMER_CONFIRMED_SUBJECT = "Your Bookly booking is confirmed" as const;

const cancellationReminder = (data: BookingEmailData): string | undefined => {
  if (!data.cancellationPolicy) {
    return undefined;
  }
  return `If you need to cancel, do it as early as you can. A late cancellation or no-show may be charged up to ${data.cancellationPolicy.noShowPercentage}% of the booking value under ${data.businessName}'s cancellation policy.`;
};

export const renderBookingCustomerConfirmedEmail = (data: BookingEmailData): RenderedEmail => {
  const reminder = cancellationReminder(data);

  const cta = data.customerBookingUrlPath
    ? emailButton("View your booking", buildFrontendUrl(data.customerBookingUrlPath))
    : "";

  const contentHtml =
    emailTitle("Your booking is confirmed") +
    emailParagraph(
      `Hi ${data.customerName}, your booking with ${data.businessName} is confirmed. Here are the details:`,
    ) +
    renderBookingDetailsHtml(data) +
    (reminder ? emailParagraph(reminder) : "") +
    cta +
    emailMutedNote(`Questions about this appointment? Contact us at ${SUPPORT_EMAIL}.`);

  const contentText = [
    "Your booking is confirmed",
    "",
    `Hi ${data.customerName}, your booking with ${data.businessName} is confirmed.`,
    "",
    renderBookingDetailsText(data),
    ...(reminder ? ["", reminder] : []),
    ...(data.customerBookingUrlPath
      ? ["", `View your booking: ${buildFrontendUrl(data.customerBookingUrlPath)}`]
      : []),
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `${data.businessName} — ${data.appointmentDate} at ${data.appointmentTime}`,
    contentHtml,
    contentText,
  });

  return {
    subject: BOOKING_CUSTOMER_CONFIRMED_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
