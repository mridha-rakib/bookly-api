/**
 * Foundation for the 24h appointment-reminder SMS body. PURE: typed input → string. No DB, no
 * provider, no preference check, no Booking/User fetch. Stage 3B feeds it already-formatted
 * values (date/time already rendered in `Booking.schedule.timezone`, exactly like the reminder
 * email) and enqueues the returned string as the frozen SmsOutbox `body`.
 *
 * Kept intentionally terse and factual — no payment amounts, no links, no tokens, no PII beyond
 * the business name and appointment time. Wording/length may be tuned in Stage 3B; the contract
 * (pure, deterministic, single string) will not change.
 */
export type AppointmentReminderSmsInput = {
  businessName: string;
  /** Already formatted for the venue's timezone, e.g. "Thu 10 Sep". */
  appointmentDate: string;
  /** Already formatted for the venue's timezone, e.g. "12:00". */
  appointmentTime: string;
  /** IANA zone the time is in, e.g. "Europe/Nicosia" — so a travelling customer isn't misled. */
  venueTimezone: string;
};

export const buildAppointmentReminderSmsMessage = (input: AppointmentReminderSmsInput): string =>
  `Bookly reminder: your appointment with ${input.businessName} is tomorrow, ` +
  `${input.appointmentDate} at ${input.appointmentTime} (${input.venueTimezone}). ` +
  `Manage it in the Bookly app.`;
