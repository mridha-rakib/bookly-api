import { BOOKLY_BRAND, EMAIL_FONT_STACK } from "../../email.config.js";
import { escapeHtml } from "../components/email-primitives.js";
import type { CancellationEmailData } from "./cancellation-email-data.js";

/** Shared factual block for both cancellation emails — reference, business, appointment,
 * services. No amounts here (the per-recipient copy handles the financial outcome). */
const row = (label: string, value: string): string =>
  `<tr>` +
  `<td style="padding:5px 0;font-family:${EMAIL_FONT_STACK};font-size:14px;color:${BOOKLY_BRAND.mutedText};white-space:nowrap;vertical-align:top;">${escapeHtml(
    label,
  )}</td>` +
  `<td style="padding:5px 0 5px 16px;font-family:${EMAIL_FONT_STACK};font-size:14px;color:${BOOKLY_BRAND.ink};text-align:right;">${escapeHtml(
    value,
  )}</td>` +
  `</tr>`;

export const renderCancellationFactsHtml = (data: CancellationEmailData): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 14px;">` +
  row("Booking reference", data.bookingReference) +
  row("Business", data.businessName) +
  row("Appointment", `${data.appointmentDate}, ${data.appointmentTime}`) +
  row("Service(s)", data.services.join(", ")) +
  `</table>`;

export const renderCancellationFactsText = (data: CancellationEmailData): string =>
  [
    `Booking reference: ${data.bookingReference}`,
    `Business: ${data.businessName}`,
    `Appointment: ${data.appointmentDate}, ${data.appointmentTime}`,
    `Service(s): ${data.services.join(", ")}`,
  ].join("\n");
