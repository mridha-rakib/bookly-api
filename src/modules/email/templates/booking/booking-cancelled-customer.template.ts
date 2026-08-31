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
import type { CancellationEmailData } from "./cancellation-email-data.js";
import {
  renderCancellationFactsHtml,
  renderCancellationFactsText,
} from "./cancellation-facts-section.js";

/** TRIGGERS 1 & 2 (recipient: customer). Wording branches on `cancelledBy`. */
export const BOOKING_CANCELLED_CUSTOMER_SUBJECT = "Your booking has been cancelled" as const;

const financialLinesText = (data: CancellationEmailData): string[] => {
  const f = data.financialOutcome;
  const lines: string[] = [];
  if (data.cancelledBy === "CUSTOMER") {
    if (f.hasCancellationFee) {
      lines.push(`Cancellation fee: ${f.cancellationFeeFormatted}`);
      if (f.hasDepositApplied)
        lines.push(`Applied from your deposit already paid: ${f.depositAppliedFormatted}`);
      if (f.hasAdditionalCharge)
        lines.push(`Additional amount charged: ${f.additionalChargeFormatted}`);
    } else {
      lines.push("No cancellation fee applies to this cancellation.");
    }
  } else {
    if (f.hasRefund) {
      lines.push(
        f.settlementStatus === "SUCCEEDED"
          ? `Refund of ${f.refundFormatted} for your upfront payment has been processed.`
          : `A refund of ${f.refundFormatted} for your upfront payment is being arranged — our team will be in touch if anything is needed.`,
      );
    } else {
      lines.push("There was no upfront payment to refund for this booking.");
    }
  }
  return lines;
};

export const renderBookingCancelledCustomerEmail = (data: CancellationEmailData): RenderedEmail => {
  const cancelledSentence =
    data.cancelledBy === "CUSTOMER"
      ? `Your booking with ${data.businessName} has been cancelled as you requested.`
      : `${data.businessName} has cancelled your booking.`;

  const finLines = financialLinesText(data);
  const cta =
    data.cancelledBy === "CUSTOMER" && data.customerBookingUrlPath
      ? emailButton("View your bookings", buildFrontendUrl(data.customerBookingUrlPath))
      : "";

  const contentHtml =
    emailTitle("Your booking has been cancelled") +
    emailParagraph(`Hi ${data.customerFirstName}, ${cancelledSentence}`) +
    renderCancellationFactsHtml(data) +
    finLines.map((line) => emailParagraph(line)).join("") +
    cta +
    emailMutedNote(`Need help? Contact us at ${SUPPORT_EMAIL}.`);

  const contentText = [
    "Your booking has been cancelled",
    "",
    `Hi ${data.customerFirstName}, ${cancelledSentence}`,
    "",
    renderCancellationFactsText(data),
    "",
    ...finLines,
    ...(data.cancelledBy === "CUSTOMER" && data.customerBookingUrlPath
      ? ["", `View your bookings: ${buildFrontendUrl(data.customerBookingUrlPath)}`]
      : []),
    "",
    `Need help? Contact us at ${SUPPORT_EMAIL}.`,
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `${data.businessName} — booking ${data.bookingReference} cancelled`,
    contentHtml,
    contentText,
  });

  return {
    subject: BOOKING_CANCELLED_CUSTOMER_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
