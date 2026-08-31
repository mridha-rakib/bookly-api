import { model, Schema, type Types } from "mongoose";

import { type SmsOutboxStatus, smsOutboxStatuses } from "./sms-outbox.types.js";

/**
 * Durable transactional-SMS outbox — a dedicated collection, NOT a generalisation of
 * EmailOutbox (EmailOutbox is only an architectural reference here). Correctness rests on the
 * DB, mirroring EmailOutbox:
 *  - unique `dedupeKey` index  → a duplicate enqueue cannot create a second row.
 *  - atomic `findOneAndUpdate` claim (see repository) → two workers can't process one row.
 *  - `attemptCount` incremented ON claim → a worker that crashes mid-send still burns an
 *    attempt, so a poisoned row can't be re-claimed forever.
 *
 * The row stores the FINAL `body` (not a rendering payload): the worker sends it verbatim and
 * never reads Booking/User data, so a retry always sends the same logical content. Never stores
 * provider credentials.
 */
export type SmsOutboxDocument = {
  _id: Types.ObjectId;
  dedupeKey: string;
  eventKey: string;
  /** Normalised E.164 recipient. */
  recipientE164: string;
  /** The frozen, ready-to-send message text. */
  body: string;
  /** Non-secret provider-side tags. */
  metadata?: Record<string, string> | undefined;
  status: SmsOutboxStatus;
  attemptCount: number;
  /** Earliest time a PENDING row may be claimed (set by retry backoff). */
  nextAttemptAt?: Date | undefined;
  claimedAt?: Date | undefined;
  claimedBy?: string | undefined;
  provider?: string | undefined;
  providerMessageId?: string | undefined;
  lastErrorCategory?: string | undefined;
  lastErrorMessage?: string | undefined;
  sentAt?: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const smsOutboxSchema = new Schema<SmsOutboxDocument>(
  {
    dedupeKey: { type: String, required: true, trim: true, maxlength: 400 },
    eventKey: { type: String, required: true, trim: true, maxlength: 300 },
    recipientE164: { type: String, required: true, trim: true, maxlength: 20 },
    body: { type: String, required: true, trim: true, maxlength: 1600 },
    metadata: { type: Schema.Types.Mixed },
    status: { type: String, enum: smsOutboxStatuses, required: true, default: "PENDING" },
    attemptCount: { type: Number, required: true, default: 0, min: 0, validate: Number.isInteger },
    nextAttemptAt: { type: Date },
    claimedAt: { type: Date },
    claimedBy: { type: String, trim: true, maxlength: 200 },
    provider: { type: String, trim: true, maxlength: 40 },
    providerMessageId: { type: String, trim: true, maxlength: 200 },
    lastErrorCategory: { type: String, trim: true, maxlength: 80 },
    lastErrorMessage: { type: String, trim: true, maxlength: 500 },
    sentAt: { type: Date },
  },
  { timestamps: true },
);

// (1) Idempotency — one send per (eventKey, recipient), enforced by the database. Backs the
//     idempotent `enqueue` (duplicate-key → return the existing row) and `findByDedupeKey`.
smsOutboxSchema.index({ dedupeKey: 1 }, { unique: true });
// (2) Worker claim query: eligible PENDING rows ordered by when they're due —
//     `findOneAndUpdate({ status: "PENDING", $or:[{nextAttemptAt exists:false},{nextAttemptAt <= now}] },
//     …, { sort: { nextAttemptAt: 1, createdAt: 1 } })`.
smsOutboxSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });
// (3) Stale-claim recovery: `updateMany({ status: "PROCESSING", claimedAt: { $lte: staleBefore } }, …)`
//     and the PROCESSING branch of `claimNext`.
smsOutboxSchema.index({ status: 1, claimedAt: 1 });

export const SmsOutboxModel = model<SmsOutboxDocument>("SmsOutbox", smsOutboxSchema);
