import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import { emailParagraph, emailTitle } from "../components/email-primitives.js";
import { renderBookingDetailsHtml, renderBookingDetailsText } from "./booking-details-section.js";
import type { BookingEmailData } from "./booking-email-data.js";

/**
 * TRIGGERS 3 & 4 (business-side recipients) — the acting Business Owner, the acting Supervisor,
 * and (for a Supervisor-created booking) the Business Owner. `createdByLabel` is set per
 * recipient by the notification layer so the same template can truthfully say "You created…"
 * to the actor and "{Supervisor} created…" to the Owner — never a generic body.
 */
export type StaffCreatedBookingEmailData = BookingEmailData & { createdByLabel: string };

export const BOOKING_STAFF_CREATED_SUBJECT = "Booking created" as const;

export const renderBookingStaffCreatedEmail = (
  data: StaffCreatedBookingEmailData,
): RenderedEmail => {
  const contentHtml =
    emailTitle("Booking created") +
    emailParagraph(`${data.createdByLabel} for ${data.customerName} at ${data.businessName}.`) +
    renderBookingDetailsHtml(data) +
    emailParagraph("The appointment is now on the Bookly calendar.");

  const contentText = [
    "Booking created",
    "",
    `${data.createdByLabel} for ${data.customerName} at ${data.businessName}.`,
    "",
    renderBookingDetailsText(data),
    "",
    "The appointment is now on the Bookly calendar.",
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `${data.customerName} — ${data.appointmentDate} at ${data.appointmentTime}`,
    contentHtml,
    contentText,
  });

  return {
    subject: BOOKING_STAFF_CREATED_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
