/**
 * Appointment reminder domain vocabulary (Stage 2 — 24h email; Stage 3 adds SMS as another
 * per-channel sub-decision on the SAME row, no migration).
 *
 * A reminder row is one logical reminder for ONE booking at ONE offset for ONE schedule version.
 * "Schedule version" is proven by `scheduleStartAt` (the absolute appointment instant this
 * reminder was created for): a reschedule always moves `Booking.schedule.startAt`, which yields
 * a different {@link buildAppointmentReminderDedupeKey}, hence a distinct logical reminder — the
 * old one is retired, the new one scheduled.
 */

/** The only reminder offset implemented. A future 1h reminder adds `"REMINDER_1H"` here, a
 * matching `offsetMinutes`, its own template key + a case in `buildAppointmentReminderDedupeKey`
 * / `appointmentReminderEventKeyPrefix` — the model, repository, worker and claim query are
 * already offset-agnostic (they key off `status` + `dueAt`). */
export const appointmentReminderKinds = ["REMINDER_24H"] as const;
export type AppointmentReminderKind = (typeof appointmentReminderKinds)[number];

export const APPOINTMENT_REMINDER_OFFSET_MINUTES: Record<AppointmentReminderKind, number> = {
  REMINDER_24H: 24 * 60,
};

/**
 * Orchestration lifecycle of the reminder row — deliberately SEPARATE from email delivery state
 * (EmailOutbox owns provider send + retry). This status only tracks "has the reminder been
 * decided/dispatched".
 *  - PENDING     — scheduled, not yet due or not yet processed. The only claimable state.
 *  - PROCESSING  — a worker holds it (via a unique claim token). Reclaimable once the claim goes
 *                  stale.
 *  - COMPLETED   — BOTH channel decisions are final (each is ENQUEUED / SUPPRESSED_BY_PREFERENCE
 *                  / one of the SKIPPED_* values). Terminal. "COMPLETED" is orchestration state,
 *                  NOT "delivered" — the outbox workers own provider delivery.
 *  - SKIPPED     — the whole reminder was never eligible to fire: created inside the 24h window
 *                  (dueAt <= now), or the appointment had already started / been cancelled /
 *                  moved BEFORE any channel enqueued. Both channel decisions = SKIPPED_INELIGIBLE.
 *                  Terminal.
 *  - CANCELLED   — retired by a booking lifecycle transition (cancel / complete / no-show), or
 *                  this schedule version was superseded by a reschedule. Retirement overrides
 *                  worker ownership (no claim-token guard). Terminal.
 *  - FAILED      — orchestration did not reach a final decision on EVERY channel within
 *                  `maxAttempts` (a recurring infra error). Terminal. FAILED means "orchestration
 *                  incomplete", NOT "nothing sent" — an already-ENQUEUED channel's message will
 *                  still be delivered by its outbox worker. Already-resolved channel decisions,
 *                  frozen recipients and outbox links are preserved on a FAILED row.
 * A terminal row is never re-claimed and never reactivated.
 */
export const appointmentReminderStatuses = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "SKIPPED",
  "CANCELLED",
  "FAILED",
] as const;
export type AppointmentReminderStatus = (typeof appointmentReminderStatuses)[number];

/**
 * Per-channel orchestration outcome recorded on the reminder row. `PENDING` = not yet resolved;
 * every other value is FINAL and immutable (a write only ever matches `<channel>Decision:
 * "PENDING"`). "resolved" is NOT "delivered" — `ENQUEUED` means an EmailOutbox / SmsOutbox row
 * exists; those outboxes + their workers own whether SendGrid / Twilio ultimately accept it.
 * Provider delivery failure is NEVER a value here — it lives in the outbox row's own `status`.
 *
 *  - ENQUEUED                        — an outbox row exists for this channel.
 *  - SUPPRESSED_BY_PREFERENCE        — the customer's toggle for this channel is off.
 *  - SKIPPED_NO_RECIPIENT           — email only: no usable account email and no snapshot.
 *  - SKIPPED_NO_VERIFIED_PHONE      — sms only: toggle on but no verified E.164.
 *  - SKIPPED_PROVIDER_NOT_CONFIGURED — sms only: toggle on + verified phone, but the Twilio
 *                                      Messaging sender is not configured (ops gap, not a
 *                                      preference and not a phone problem). Future reminders may
 *                                      send once config exists; this one is never re-sent.
 *  - SKIPPED_INELIGIBLE            — the booking became ineligible (cancelled / rescheduled /
 *                                      started / gone) before this channel enqueued.
 */
export const appointmentReminderChannelDecisions = [
  "PENDING",
  "ENQUEUED",
  "SUPPRESSED_BY_PREFERENCE",
  "SKIPPED_NO_RECIPIENT",
  "SKIPPED_NO_VERIFIED_PHONE",
  "SKIPPED_PROVIDER_NOT_CONFIGURED",
  "SKIPPED_INELIGIBLE",
] as const;
export type AppointmentReminderChannelDecision =
  (typeof appointmentReminderChannelDecisions)[number];

/** A channel decision is "final" once it has left `PENDING`. */
export const isFinalChannelDecision = (
  decision: AppointmentReminderChannelDecision | undefined,
): boolean => (decision ?? "PENDING") !== "PENDING";

/** Stable event-key prefix per offset — also the EmailOutbox `eventKey` prefix, so the outbox
 * dedupeKey (`eventKey::templateKey::recipient`) is deterministic per reminder + recipient. */
export const appointmentReminderEventKeyPrefix: Record<AppointmentReminderKind, string> = {
  REMINDER_24H: "APPOINTMENT_REMINDER_24H",
};

/**
 * Deterministic logical identity. A duplicate scheduling call re-derives the exact same string
 * (unique index → no second row); a reschedule changes `scheduleStartAt` → a different string.
 */
export const buildAppointmentReminderDedupeKey = (
  kind: AppointmentReminderKind,
  bookingId: string,
  scheduleStartAt: Date,
): string => `${appointmentReminderEventKeyPrefix[kind]}:${bookingId}:${scheduleStartAt.getTime()}`;

/** Absolute-instant arithmetic only — never a timezone label, offset string, or local clock. */
export const computeAppointmentReminderDueAt = (
  scheduleStartAt: Date,
  kind: AppointmentReminderKind,
): Date => new Date(scheduleStartAt.getTime() - APPOINTMENT_REMINDER_OFFSET_MINUTES[kind] * 60_000);
