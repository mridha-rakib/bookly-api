import { BOOKLY_BRAND, EMAIL_FONT_STACK } from "../../email.config.js";
import { emailDivider, escapeHtml } from "../components/email-primitives.js";
import type { BookingEmailData } from "./booking-email-data.js";

/**
 * Reusable *body sub-section* for the factual part of a booking email — reference, schedule,
 * services, and payment summary. The surrounding copy (greeting, who booked, next steps) stays
 * unique per template; this is only the shared "here are the details" block, built from the
 * already-formatted {@link BookingEmailData} (no amounts computed here).
 */

const row = (label: string, value: string): string =>
  `<tr>` +
  `<td style="padding:6px 0;font-family:${EMAIL_FONT_STACK};font-size:14px;color:${BOOKLY_BRAND.mutedText};white-space:nowrap;vertical-align:top;">${escapeHtml(
    label,
  )}</td>` +
  `<td style="padding:6px 0 6px 16px;font-family:${EMAIL_FONT_STACK};font-size:14px;color:${BOOKLY_BRAND.ink};text-align:right;">${escapeHtml(
    value,
  )}</td>` +
  `</tr>`;

export const renderBookingDetailsHtml = (data: BookingEmailData): string => {
  const serviceRows = data.serviceLines
    .map((line) => {
      const addonBits = line.addons
        .map((addon) => `+ ${escapeHtml(addon.name)} (${escapeHtml(addon.priceFormatted)})`)
        .join("<br />");
      const staff = line.staffName ? ` · ${escapeHtml(line.staffName)}` : "";
      return (
        `<tr><td style="padding:8px 0;border-top:1px solid ${BOOKLY_BRAND.border};font-family:${EMAIL_FONT_STACK};font-size:14px;color:${BOOKLY_BRAND.ink};">` +
        `${escapeHtml(line.name)} <span style="color:${BOOKLY_BRAND.mutedText};">(${line.durationMin} min${staff})</span>` +
        (addonBits
          ? `<br /><span style="color:${BOOKLY_BRAND.slate};font-size:13px;">${addonBits}</span>`
          : "") +
        `</td><td style="padding:8px 0;border-top:1px solid ${BOOKLY_BRAND.border};font-family:${EMAIL_FONT_STACK};font-size:14px;color:${BOOKLY_BRAND.ink};text-align:right;vertical-align:top;">${escapeHtml(
          line.amountFormatted,
        )}</td></tr>`
      );
    })
    .join("");

  const moneyRows =
    row("Services subtotal", data.money.servicesSubtotalFormatted) +
    (data.money.hasAddons ? row("Add-ons", data.money.addonsSubtotalFormatted) : "") +
    (data.money.hasServiceDiscount
      ? row("Discount", `-${data.money.serviceDiscountFormatted}`)
      : "") +
    (data.money.hasTravelFee ? row("Travel fee", data.money.travelFeeFormatted) : "") +
    row("Total", data.money.totalFormatted) +
    row("Paid online now", data.money.paidNowFormatted) +
    row("Balance due at the venue", data.money.balanceDueFormatted);

  const locationLabel =
    data.fulfilment.kind === "TRAVEL_TO_CUSTOMER" ? "At your address" : "At the venue";
  const locationValue = data.fulfilment.address ?? locationLabel;

  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;">` +
    row("Booking reference", data.reference) +
    row("Business", data.businessName) +
    row("Date", data.appointmentDate) +
    row("Time", `${data.appointmentTime} (${data.durationMin} min)`) +
    row(locationLabel, locationValue) +
    `</table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 4px;">${serviceRows}</table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 4px;">${moneyRows}</table>` +
    emailDivider()
  );
};

export const renderBookingDetailsText = (data: BookingEmailData): string => {
  const lines: string[] = [
    `Booking reference: ${data.reference}`,
    `Business: ${data.businessName}`,
    `Date: ${data.appointmentDate}`,
    `Time: ${data.appointmentTime} (${data.durationMin} min)`,
  ];
  const locationLabel =
    data.fulfilment.kind === "TRAVEL_TO_CUSTOMER" ? "At your address" : "At the venue";
  lines.push(`${locationLabel}: ${data.fulfilment.address ?? locationLabel}`);
  lines.push("");
  lines.push("Services:");
  for (const line of data.serviceLines) {
    const staff = line.staffName ? ` with ${line.staffName}` : "";
    lines.push(`  - ${line.name} (${line.durationMin} min${staff}) — ${line.amountFormatted}`);
    for (const addon of line.addons) {
      lines.push(`      + ${addon.name} (${addon.priceFormatted})`);
    }
  }
  lines.push("");
  lines.push(`Services subtotal: ${data.money.servicesSubtotalFormatted}`);
  if (data.money.hasAddons) lines.push(`Add-ons: ${data.money.addonsSubtotalFormatted}`);
  if (data.money.hasServiceDiscount)
    lines.push(`Discount: -${data.money.serviceDiscountFormatted}`);
  if (data.money.hasTravelFee) lines.push(`Travel fee: ${data.money.travelFeeFormatted}`);
  lines.push(`Total: ${data.money.totalFormatted}`);
  lines.push(`Paid online now: ${data.money.paidNowFormatted}`);
  lines.push(`Balance due at the venue: ${data.money.balanceDueFormatted}`);
  return lines.join("\n");
};
