import { BOOKLY_BRAND, EMAIL_FONT_STACK } from "../../email.config.js";
import { emailParagraph, escapeHtml } from "../components/email-primitives.js";
import type { BookingEmailData } from "./booking-email-data.js";

/**
 * F4A Tier 3 — customer-facing policy disclosure and payment receipt blocks. Rendering only:
 * every value is pre-formatted by buildBookingEmailData from the Booking's own snapshot and
 * from verified payment evidence. No amounts are computed here.
 */

const heading = (text: string): string =>
  `<h2 style="margin:20px 0 8px;font-family:${EMAIL_FONT_STACK};font-size:16px;line-height:1.4;font-weight:700;color:${BOOKLY_BRAND.ink};">${escapeHtml(
    text,
  )}</h2>`;

const row = (label: string, value: string): string =>
  `<tr>` +
  `<td style="padding:5px 0;font-family:${EMAIL_FONT_STACK};font-size:14px;color:${BOOKLY_BRAND.mutedText};vertical-align:top;">${escapeHtml(
    label,
  )}</td>` +
  `<td style="padding:5px 0 5px 16px;font-family:${EMAIL_FONT_STACK};font-size:14px;color:${BOOKLY_BRAND.ink};text-align:right;vertical-align:top;">${escapeHtml(
    value,
  )}</td>` +
  `</tr>`;

const table = (rows: string): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 12px;">${rows}</table>`;

const POLICY_HEADING = "Cancellation and no-show policy";
const POLICY_INTRO = "These terms were agreed when this booking was made:";
const NO_POLICY = "No cancellation or no-show fee applies to this booking.";
const UPFRONT_NOTE =
  "Any amount already paid online for this booking counts towards a cancellation or no-show fee.";
const RECEIPT_HEADING = "Payment receipt";
const RECEIPT_NOTE = "This receipt covers only the amount paid online.";

const PAYMENT_FOR_LABEL = {
  BOOKING: "This booking",
  PACKAGE_PURCHASE: "Package purchase",
  PACKAGE_SESSION_EXTRAS: "Add-ons and fees for this package session",
} as const;

export const renderPolicyHtml = (data: BookingEmailData): string => {
  const policy = data.policyDisclosure;
  if (!policy) return heading(POLICY_HEADING) + emailParagraph(NO_POLICY);
  return (
    heading(POLICY_HEADING) +
    emailParagraph(POLICY_INTRO) +
    table(
      policy.windows.map((window) => row(window.label, window.fee)).join("") +
        row("No-show", policy.noShow),
    ) +
    (policy.upfrontCountsTowardsFee ? emailParagraph(UPFRONT_NOTE) : "")
  );
};

export const renderPolicyText = (data: BookingEmailData): string => {
  const policy = data.policyDisclosure;
  if (!policy) return [POLICY_HEADING, NO_POLICY].join("\n");
  return [
    POLICY_HEADING,
    POLICY_INTRO,
    ...policy.windows.map((window) => `  - ${window.label}: ${window.fee}`),
    `  - No-show: ${policy.noShow}`,
    ...(policy.upfrontCountsTowardsFee ? [UPFRONT_NOTE] : []),
  ].join("\n");
};

/** Rendered ONLY for verified PAID evidence — never for NONE, UNVERIFIED or legacy data. */
export const renderReceiptHtml = (data: BookingEmailData): string => {
  const payment = data.onlinePayment;
  if (payment?.kind !== "PAID") return "";
  return (
    heading(RECEIPT_HEADING) +
    table(
      row("Amount paid", payment.amountFormatted) +
        row("Paid on", payment.paidAt) +
        row("Payment for", PAYMENT_FOR_LABEL[payment.paymentFor]) +
        row("Payment reference", payment.paymentReference) +
        row("Booking reference", data.reference),
    ) +
    emailParagraph(RECEIPT_NOTE)
  );
};

export const renderReceiptText = (data: BookingEmailData): string | undefined => {
  const payment = data.onlinePayment;
  if (payment?.kind !== "PAID") return undefined;
  return [
    RECEIPT_HEADING,
    `Amount paid: ${payment.amountFormatted}`,
    `Paid on: ${payment.paidAt}`,
    `Payment for: ${PAYMENT_FOR_LABEL[payment.paymentFor]}`,
    `Payment reference: ${payment.paymentReference}`,
    `Booking reference: ${data.reference}`,
    RECEIPT_NOTE,
  ].join("\n");
};
