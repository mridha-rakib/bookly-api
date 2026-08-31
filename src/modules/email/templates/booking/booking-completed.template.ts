import { BOOKLY_BRAND, EMAIL_FONT_STACK, SUPPORT_EMAIL } from "../../email.config.js";
import { buildFrontendUrl } from "../../email.links.js";
import type { RenderedEmail } from "../../email.types.js";
import { renderEmailLayout } from "../components/email-layout.js";
import {
  emailButton,
  emailDivider,
  emailMutedNote,
  emailParagraph,
  emailTitle,
  escapeHtml,
} from "../components/email-primitives.js";
import type { InvoiceData } from "../invoice/invoice-data.js";

/**
 * TRIGGER 5 — the customer, after a Business Owner / Supervisor completes their booking. Body =
 * greeting + completion confirmation + appointment facts + an invoice-style summary + a note
 * that the PDF invoice is attached. Renders entirely from the shared {@link InvoiceData} (no
 * money computed here); the PDF attachment is added by the worker from the SAME InvoiceData.
 */
export type BookingCompletedEmailPayload = {
  invoice: InvoiceData;
  /** `/customer/bookings/view?id=<id>` — only when the booking's customer is a linked user. */
  customerBookingUrlPath?: string;
};

export const BOOKING_COMPLETED_SUBJECT = "Your booking is complete" as const;

const money = (label: string, value: string, opts: { strong?: boolean } = {}): string =>
  `<tr>` +
  `<td style="padding:5px 0;font-family:${EMAIL_FONT_STACK};font-size:14px;color:${
    opts.strong ? BOOKLY_BRAND.ink : BOOKLY_BRAND.mutedText
  };">${escapeHtml(label)}</td>` +
  `<td style="padding:5px 0 5px 16px;font-family:${EMAIL_FONT_STACK};font-size:14px;font-weight:${
    opts.strong ? "700" : "400"
  };color:${BOOKLY_BRAND.ink};text-align:right;">${escapeHtml(value)}</td>` +
  `</tr>`;

const renderSummaryHtml = (invoice: InvoiceData): string => {
  const f = invoice.financial;
  const itemRows = invoice.lineItems
    .map(
      (item) =>
        `<tr><td style="padding:6px 0;border-top:1px solid ${BOOKLY_BRAND.border};font-family:${EMAIL_FONT_STACK};font-size:14px;color:${BOOKLY_BRAND.ink};">${escapeHtml(
          item.label,
        )}${item.kind === "ADDON" ? ` <span style="color:${BOOKLY_BRAND.mutedText};">(add-on)</span>` : ""}</td>` +
        `<td style="padding:6px 0;border-top:1px solid ${BOOKLY_BRAND.border};font-family:${EMAIL_FONT_STACK};font-size:14px;color:${BOOKLY_BRAND.ink};text-align:right;">${escapeHtml(
          item.amountFormatted,
        )}</td></tr>`,
    )
    .join("");

  const totalsRows =
    money("Services subtotal", f.servicesSubtotalFormatted) +
    (f.show.addons ? money("Add-ons subtotal", f.addonsSubtotalFormatted) : "") +
    (f.show.serviceDiscount ? money("Discount", `-${f.serviceDiscountFormatted}`) : "") +
    (f.show.promoDiscount ? money("Promo discount", `-${f.promoDiscountFormatted}`) : "") +
    (f.show.travelFee ? money("Travel fee", f.travelFeeFormatted) : "") +
    money("Total", f.totalFormatted, { strong: true }) +
    money("Paid online", f.upfrontPaidFormatted) +
    (f.show.venuePayment ? money("Paid at venue", f.venuePaymentFormatted) : "") +
    money("Total paid", f.totalPaidFormatted, { strong: true }) +
    (f.show.outstanding ? money("Outstanding", f.outstandingFormatted, { strong: true }) : "");

  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0;">` +
    money("Booking reference", invoice.bookingReference) +
    money("Business", invoice.business.name) +
    money(
      "Appointment",
      `${invoice.appointment.dateFormatted}, ${invoice.appointment.timeFormatted}`,
    ) +
    money("Invoice issued", invoice.issuedAtFormatted) +
    `</table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 2px;">${itemRows}</table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 2px;">${totalsRows}</table>` +
    `<p style="margin:12px 0 0;font-family:${EMAIL_FONT_STACK};font-size:14px;color:${BOOKLY_BRAND.ink};"><strong>Payment status:</strong> ${escapeHtml(
      invoice.financial.settlementLabel,
    )}</p>`
  );
};

const renderSummaryText = (invoice: InvoiceData): string => {
  const f = invoice.financial;
  const lines: string[] = [
    `Booking reference: ${invoice.bookingReference}`,
    `Business: ${invoice.business.name}`,
    `Appointment: ${invoice.appointment.dateFormatted}, ${invoice.appointment.timeFormatted}`,
    `Invoice issued: ${invoice.issuedAtFormatted}`,
    "",
    "Items:",
    ...invoice.lineItems.map(
      (item) =>
        `  - ${item.label}${item.kind === "ADDON" ? " (add-on)" : ""}: ${item.amountFormatted}`,
    ),
    "",
    `Services subtotal: ${f.servicesSubtotalFormatted}`,
  ];
  if (f.show.addons) lines.push(`Add-ons subtotal: ${f.addonsSubtotalFormatted}`);
  if (f.show.serviceDiscount) lines.push(`Discount: -${f.serviceDiscountFormatted}`);
  if (f.show.promoDiscount) lines.push(`Promo discount: -${f.promoDiscountFormatted}`);
  if (f.show.travelFee) lines.push(`Travel fee: ${f.travelFeeFormatted}`);
  lines.push(`Total: ${f.totalFormatted}`);
  lines.push(`Paid online: ${f.upfrontPaidFormatted}`);
  if (f.show.venuePayment) lines.push(`Paid at venue: ${f.venuePaymentFormatted}`);
  lines.push(`Total paid: ${f.totalPaidFormatted}`);
  if (f.show.outstanding) lines.push(`Outstanding: ${f.outstandingFormatted}`);
  lines.push("");
  lines.push(`Payment status: ${f.settlementLabel}`);
  return lines.join("\n");
};

export const renderBookingCompletedEmail = (
  payload: BookingCompletedEmailPayload,
): RenderedEmail => {
  const { invoice } = payload;

  const cta = payload.customerBookingUrlPath
    ? emailButton("View your booking", buildFrontendUrl(payload.customerBookingUrlPath))
    : "";

  const contentHtml =
    emailTitle("Your booking is complete") +
    emailParagraph(
      `Hi ${invoice.customer.firstName}, your appointment with ${invoice.business.name} is now complete.`,
    ) +
    emailParagraph(
      "Here's a summary of your booking and payments. A PDF copy of your invoice is attached to this email for your records.",
    ) +
    renderSummaryHtml(invoice) +
    emailDivider() +
    cta +
    emailMutedNote(`Questions about this invoice? Contact us at ${SUPPORT_EMAIL}.`);

  const contentText = [
    "Your booking is complete",
    "",
    `Hi ${invoice.customer.firstName}, your appointment with ${invoice.business.name} is now complete.`,
    "",
    "Here's a summary of your booking and payments. A PDF copy of your invoice is attached to this email for your records.",
    "",
    renderSummaryText(invoice),
    ...(payload.customerBookingUrlPath
      ? ["", `View your booking: ${buildFrontendUrl(payload.customerBookingUrlPath)}`]
      : []),
    "",
    `Questions about this invoice? Contact us at ${SUPPORT_EMAIL}.`,
  ].join("\n");

  const layout = renderEmailLayout({
    preheader: `Your appointment with ${invoice.business.name} is complete — invoice attached.`,
    contentHtml,
    contentText,
  });

  return {
    subject: BOOKING_COMPLETED_SUBJECT,
    html: layout.html,
    text: layout.text,
    attachments: layout.attachments,
  };
};
