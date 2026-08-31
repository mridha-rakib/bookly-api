import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import { emailParagraph, emailTitle } from "../components/email-primitives.js";
import type { CancellationEmailData } from "./cancellation-email-data.js";
import {
  renderCancellationFactsHtml,
  renderCancellationFactsText,
} from "./cancellation-facts-section.js";

/** TRIGGERS 1 & 2 (recipient: Business Owner). Operational tone; wording states who cancelled. */
export const bookingCancelledOwnerSubject = (bookingReference: string): string =>
  `Booking cancelled — ${bookingReference}`;

const settlementLine = (data: CancellationEmailData): string | undefined => {
  const f = data.financialOutcome;
  if (data.cancelledBy === "CUSTOMER") {
    if (!f.hasCancellationFee) {
      return "No cancellation fee applied.";
    }
    if (f.settlementStatus === "SUCCEEDED") {
      return `Cancellation fee ${f.cancellationFeeFormatted} settled${f.hasAdditionalCharge ? ` (${f.additionalChargeFormatted} charged, ${f.depositAppliedFormatted} from deposit)` : " from the deposit already held"}.`;
    }
    if (f.settlementStatus === "FAILED") {
      return `Cancellation fee ${f.cancellationFeeFormatted} classified — the additional card charge did not go through and is flagged for manual follow-up.`;
    }
    return `Cancellation fee ${f.cancellationFeeFormatted} classified.`;
  }
  if (!f.hasRefund) {
    return "No upfront payment was held, so no refund was required.";
  }
  return f.settlementStatus === "SUCCEEDED"
    ? `Upfront payment of ${f.refundFormatted} refunded to the customer.`
    : `Refund of ${f.refundFormatted} did not complete automatically and is flagged for manual follow-up.`;
};

export const renderBookingCancelledOwnerEmail = (data: CancellationEmailData): RenderedEmail => {
  const whoLine =
    data.cancelledBy === "CUSTOMER"
      ? `${data.customerName} cancelled this booking.`
      : `This booking was cancelled by ${data.businessName}.`;

  const settlement = settlementLine(data);

  const contentHtml =
    emailTitle("Booking cancelled") +
    emailParagraph(whoLine) +
    renderCancellationFactsHtml(data) +
    (settlement ? emailParagraph(settlement) : "") +
    emailParagraph("The appointment slot has been released.");

  const contentText = [
    "Booking cancelled",
    "",
    whoLine,
    "",
    renderCancellationFactsText(data),
    `Customer: ${data.customerName}`,
    ...(settlement ? ["", settlement] : []),
    "",
    "The appointment slot has been released.",
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `${data.customerName} — booking ${data.bookingReference} cancelled`,
    contentHtml,
    contentText,
  });

  return {
    subject: bookingCancelledOwnerSubject(data.bookingReference),
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
