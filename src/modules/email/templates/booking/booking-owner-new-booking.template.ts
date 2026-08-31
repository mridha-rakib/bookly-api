import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import { emailParagraph, emailTitle } from "../components/email-primitives.js";
import { renderBookingDetailsHtml, renderBookingDetailsText } from "./booking-details-section.js";
import type { BookingEmailData } from "./booking-email-data.js";

/**
 * TRIGGER 2 (recipient B) — the Business Owner, when a customer books online. Operational tone.
 * Carries the customer's name and the appointment facts only — no customer email/phone, no card
 * or payment-method identifiers.
 */
export const bookingOwnerNewBookingSubject = (customerName: string): string =>
  `New booking received — ${customerName}`;

export const renderBookingOwnerNewBookingEmail = (data: BookingEmailData): RenderedEmail => {
  const contentHtml =
    emailTitle("New booking received") +
    emailParagraph(
      `${data.customerName} booked online with ${data.businessName}. Here are the details:`,
    ) +
    renderBookingDetailsHtml(data) +
    emailParagraph("This appointment is now on your Bookly calendar.");

  const contentText = [
    "New booking received",
    "",
    `${data.customerName} booked online with ${data.businessName}.`,
    "",
    renderBookingDetailsText(data),
    "",
    "This appointment is now on your Bookly calendar.",
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `${data.customerName} — ${data.appointmentDate} at ${data.appointmentTime}`,
    contentHtml,
    contentText,
  });

  return {
    subject: bookingOwnerNewBookingSubject(data.customerName),
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
