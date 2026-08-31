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
 * TRIGGERS 3 & 4 (recipient: the client) — a Business Owner or Supervisor created the booking
 * FOR the client. Wording makes clear the client did not initiate it ("{business} has booked an
 * appointment for you"), never "thanks for booking".
 */
export const BOOKING_FOR_CLIENT_CONFIRMED_SUBJECT =
  "An appointment has been booked for you" as const;

const cancellationReminder = (data: BookingEmailData): string | undefined => {
  if (!data.cancellationPolicy) {
    return undefined;
  }
  return `If this time doesn't work, let ${data.businessName} know as early as you can. A late cancellation or no-show may be charged up to ${data.cancellationPolicy.noShowPercentage}% of the booking value under their cancellation policy.`;
};

export const renderBookingForClientConfirmedEmail = (data: BookingEmailData): RenderedEmail => {
  const reminder = cancellationReminder(data);
  const cta = data.customerBookingUrlPath
    ? emailButton("View this booking", buildFrontendUrl(data.customerBookingUrlPath))
    : "";

  const contentHtml =
    emailTitle("An appointment has been booked for you") +
    emailParagraph(
      `Hi ${data.customerName}, ${data.businessName} has booked an appointment for you on Bookly.cy. Here are the details:`,
    ) +
    renderBookingDetailsHtml(data) +
    (reminder ? emailParagraph(reminder) : "") +
    cta +
    emailMutedNote(
      `Didn't expect this? Contact ${data.businessName}, or reach us at ${SUPPORT_EMAIL}.`,
    );

  const contentText = [
    "An appointment has been booked for you",
    "",
    `Hi ${data.customerName}, ${data.businessName} has booked an appointment for you on Bookly.cy.`,
    "",
    renderBookingDetailsText(data),
    ...(reminder ? ["", reminder] : []),
    ...(data.customerBookingUrlPath
      ? ["", `View this booking: ${buildFrontendUrl(data.customerBookingUrlPath)}`]
      : []),
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `${data.businessName} — ${data.appointmentDate} at ${data.appointmentTime}`,
    contentHtml,
    contentText,
  });

  return {
    subject: BOOKING_FOR_CLIENT_CONFIRMED_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
