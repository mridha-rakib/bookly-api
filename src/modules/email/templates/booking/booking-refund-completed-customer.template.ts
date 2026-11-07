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

/**
 * Customer notice that a refund has been CONFIRMED by the payment provider. Enqueued only by
 * ensureBusinessRefundNotification after the RefundOperation is SUCCEEDED and its REFUND ledger
 * row exists (never for a pending or failed refund), so this copy may state completion.
 * The amount is the refunded amount from the operation; no card details are included.
 */
export const BOOKING_REFUND_COMPLETED_CUSTOMER_SUBJECT = "Your refund has been processed" as const;

export const renderBookingRefundCompletedCustomerEmail = (
  data: CancellationEmailData,
): RenderedEmail => {
  const amount = data.financialOutcome.refundFormatted;
  const sentence = `Your refund of ${amount} (${data.currency}) for booking ${data.bookingReference} with ${data.businessName} has been processed.`;
  const timing =
    "It is returned to the payment method used for the booking. Your bank may take a few business days to show it.";
  const cta = data.customerBookingUrlPath
    ? emailButton("View your booking", buildFrontendUrl(data.customerBookingUrlPath))
    : "";

  const contentHtml =
    emailTitle("Your refund has been processed") +
    emailParagraph(`Hi ${data.customerFirstName}, ${sentence}`) +
    emailParagraph(timing) +
    renderCancellationFactsHtml(data) +
    cta +
    emailMutedNote(`Need help? Contact us at ${SUPPORT_EMAIL}.`);

  const contentText = [
    "Your refund has been processed",
    "",
    `Hi ${data.customerFirstName}, ${sentence}`,
    timing,
    "",
    renderCancellationFactsText(data),
    ...(data.customerBookingUrlPath
      ? ["", `View your booking: ${buildFrontendUrl(data.customerBookingUrlPath)}`]
      : []),
    "",
    `Need help? Contact us at ${SUPPORT_EMAIL}.`,
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `${data.businessName} — refund for booking ${data.bookingReference} processed`,
    contentHtml,
    contentText,
  });
  return {
    subject: BOOKING_REFUND_COMPLETED_CUSTOMER_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
