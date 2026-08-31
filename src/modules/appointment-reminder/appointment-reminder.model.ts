import { model, Schema, type Types } from "mongoose";

import {
  type AppointmentReminderChannelDecision,
  type AppointmentReminderKind,
  type AppointmentReminderStatus,
  appointmentReminderChannelDecisions,
  appointmentReminderKinds,
  appointmentReminderStatuses,
} from "./appointment-reminder.types.js";

/**
 * One logical appointment reminder. Correctness rests on the DB, mirroring EmailOutbox:
 *  - unique `dedupeKey` → a duplicate scheduling call cannot create a second row.
 *  - atomic `findOneAndUpdate` claim (see repository) → two workers can't process one row.
 *  - `attemptCount` incremented ON claim → a worker that crashes mid-process still burns an
 *    attempt, so a poisoned row can't be re-claimed forever.
 *
 * The row does NOT store a frozen email payload (unlike EmailOutbox): the worker rebuilds it
 * from the CURRENT Booking at send time, and re-checks `scheduleStartAt` against the live
 * booking, so a reschedule-in-flight can never send a stale-time reminder.
 */
export type AppointmentReminderDocument = {
  _id: Types.ObjectId;
  /** `APPOINTMENT_REMINDER_24H:<bookingId>:<scheduleStartAtEpochMs>` — logical identity. */
  dedupeKey: string;
  kind: AppointmentReminderKind;
  bookingId: Types.ObjectId;
  businessId: Types.ObjectId;
  /** BookingCustomer.customerUserId snapshot. A reminder is only ever scheduled when the booking
   * is for a linked Customer account (so a preference exists and a current email is resolvable);
   * always present on a persisted row. */
  customerUserId: Types.ObjectId;
  offsetMinutes: number;
  /** The absolute appointment instant this reminder corresponds to — the "schedule version". */
  scheduleStartAt: Date;
  /** `scheduleStartAt - offsetMinutes`. The worker claims on `{ status, dueAt }`. */
  dueAt: Date;
  status: AppointmentReminderStatus;
  attemptCount: number;
  claimedAt?: Date | undefined;
  /** Per-claim UNIQUE ownership token (`"<workerId>:<ObjectId>"`), not a bare worker id — every
   * worker-owned processing write guards on this exact value, so a stalled worker whose claim
   * was reclaimed by another worker can no longer mutate the row. */
  claimedBy?: string | undefined;
  /** Email-channel outcome. `PENDING` until resolved; then FINAL + immutable. */
  emailDecision: AppointmentReminderChannelDecision;
  /** SMS-channel outcome, independent of email. `PENDING` until resolved; then FINAL + immutable.
   * Absent on pre-Stage-3B rows → read as `"PENDING"`. */
  smsDecision: AppointmentReminderChannelDecision;
  /** The EmailOutbox row's dedupeKey once enqueued — an audit link, never the source of truth. */
  emailOutboxDedupeKey?: string | undefined;
  /** The SmsOutbox row's dedupeKey once enqueued — an audit link, never the source of truth. */
  smsOutboxDedupeKey?: string | undefined;
  /** Resolved email recipient, FROZEN set-once before the first EmailOutbox enqueue. Every retry
   * reuses this exact value (never re-resolves) so a mid-flight account-email change cannot
   * create a second logical EmailOutbox row. */
  emailRecipient?: string | undefined;
  /** Resolved verified E.164, FROZEN set-once before the first SmsOutbox enqueue. Same rationale
   * as `emailRecipient` — SmsOutbox dedupe includes the recipient, so freezing it is what makes
   * retry idempotent across a phone change. */
  smsRecipientE164?: string | undefined;
  /** When the worker reached a terminal state for this row. */
  processedAt?: Date | undefined;
  /** Safe, category-only strings (never a provider body / secret). */
  lastErrorCategory?: string | undefined;
  lastErrorMessage?: string | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const appointmentReminderSchema = new Schema<AppointmentReminderDocument>(
  {
    dedupeKey: { type: String, required: true, trim: true, maxlength: 300 },
    kind: { type: String, enum: appointmentReminderKinds, required: true, default: "REMINDER_24H" },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    customerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    offsetMinutes: { type: Number, required: true, min: 1, validate: Number.isInteger },
    scheduleStartAt: { type: Date, required: true },
    dueAt: { type: Date, required: true },
    status: {
      type: String,
      enum: appointmentReminderStatuses,
      required: true,
      default: "PENDING",
    },
    attemptCount: { type: Number, required: true, default: 0, min: 0, validate: Number.isInteger },
    claimedAt: { type: Date },
    claimedBy: { type: String, trim: true, maxlength: 200 },
    emailDecision: {
      type: String,
      enum: appointmentReminderChannelDecisions,
      required: true,
      default: "PENDING",
    },
    smsDecision: {
      type: String,
      enum: appointmentReminderChannelDecisions,
      required: true,
      default: "PENDING",
    },
    emailOutboxDedupeKey: { type: String, trim: true, maxlength: 400 },
    smsOutboxDedupeKey: { type: String, trim: true, maxlength: 400 },
    emailRecipient: { type: String, trim: true, maxlength: 320 },
    smsRecipientE164: { type: String, trim: true, maxlength: 20 },
    processedAt: { type: Date },
    lastErrorCategory: { type: String, trim: true, maxlength: 80 },
    lastErrorMessage: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

// (1) Logical identity — one reminder per (booking, offset, schedule version). Backs the
//     idempotent `create` (duplicate-key → return the existing row) and `findByDedupeKey`.
appointmentReminderSchema.index({ dedupeKey: 1 }, { unique: true });
// (2) Worker claim query: `findOneAndUpdate({ status: "PENDING", dueAt: { $lte: now } }, …,
//     { sort: { dueAt: 1 } })` — the exact due-reminder scan, ordered oldest-due first.
appointmentReminderSchema.index({ status: 1, dueAt: 1 });
// (3) Stale-claim recovery: `updateMany({ status: "PROCESSING", claimedAt: { $lte: staleBefore } },
//     …)` — mirrors EmailOutbox's own `{status, claimedAt}` recovery index.
appointmentReminderSchema.index({ status: 1, claimedAt: 1 });
// (4) Lifecycle retire hooks: `updateMany({ bookingId, status: { $in: ["PENDING","PROCESSING"] } },
//     …)` on reschedule / cancel / complete / no-show. Also the "does an active reminder exist
//     for this booking" read. Without it every retire hook would collection-scan.
appointmentReminderSchema.index({ bookingId: 1, status: 1 });

export const AppointmentReminderModel = model<AppointmentReminderDocument>(
  "AppointmentReminder",
  appointmentReminderSchema,
);
