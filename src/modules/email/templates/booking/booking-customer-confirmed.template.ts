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
import {
  renderPolicyHtml,
  renderPolicyText,
  renderReceiptHtml,
  renderReceiptText,
} from "./booking-policy-receipt-section.js";

/**
 * TRIGGER 2 (recipient A) — the customer who booked it themselves. Wording assumes the customer
 * initiated the booking. Never reused for a business-created booking (that is
 * BOOKING_FOR_CLIENT_CONFIRMED).
 */
export const BOOKING_CUSTOMER_CONFIRMED_SUBJECT = "Your Bookly booking is confirmed" as const;

// F4A Tier 3: the policy terms come from the Booking's own snapshot (booking-policy-receipt-
// section.ts). The previous sentence applied the no-show percentage to late cancellations too.
const CANCEL_EARLY = "If you need to cancel, do it as early as you can.";

export const renderBookingCustomerConfirmedEmail = (data: BookingEmailData): RenderedEmail => {
  const receiptText = renderReceiptText(data);

  const cta = data.customerBookingUrlPath
    ? emailButton("View your booking", buildFrontendUrl(data.customerBookingUrlPath))
    : "";

  const contentHtml =
    emailTitle("Your booking is confirmed") +
    emailParagraph(
      `Hi ${data.customerName}, your booking with ${data.businessName} is confirmed. Here are the details:`,
    ) +
    renderBookingDetailsHtml(data) +
    renderReceiptHtml(data) +
    renderPolicyHtml(data) +
    emailParagraph(CANCEL_EARLY) +
    cta +
    emailMutedNote(`Questions about this appointment? Contact us at ${SUPPORT_EMAIL}.`);

  const contentText = [
    "Your booking is confirmed",
    "",
    `Hi ${data.customerName}, your booking with ${data.businessName} is confirmed.`,
    "",
    renderBookingDetailsText(data),
    ...(receiptText ? ["", receiptText] : []),
    "",
    renderPolicyText(data),
    "",
    CANCEL_EARLY,
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
