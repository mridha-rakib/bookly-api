import { model, Schema, type Types } from "mongoose";

import { type EmailOutboxStatus, emailOutboxStatuses } from "./email-outbox.types.js";

/**
 * Durable transactional-email outbox (Phase N). A successful non-auth domain operation inserts
 * one row here and returns; the email worker (scripts/run-email-worker.ts) claims, renders, and
 * sends it out of band. OTP is never written here (it stays synchronous).
 *
 * Correctness rests on the DB, not process memory:
 *  - unique `dedupeKey` index  -> a duplicate domain event cannot create a second send.
 *  - atomic `findOneAndUpdate` claim (see repository) -> two workers can't process one row.
 *  - `attemptCount` incremented ON claim -> a worker that crashes mid-send still burns an
 *    attempt, so a poisoned row can't be re-claimed forever.
 */
export type EmailOutboxDocument = {
  _id: Types.ObjectId;
  dedupeKey: string;
  eventKey: string;
  templateKey: string;
  /** Normalised (trimmed, lower-cased) recipient address. */
  recipient: string;
  /** Typed, JSON-safe template payload. Never contains secrets (no OTPs, tokens, card data). */
  payload: Record<string, unknown>;
  status: EmailOutboxStatus;
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

const emailOutboxSchema = new Schema<EmailOutboxDocument>(
  {
    dedupeKey: { type: String, required: true, trim: true, maxlength: 400 },
    eventKey: { type: String, required: true, trim: true, maxlength: 300 },
    templateKey: { type: String, required: true, trim: true, maxlength: 100 },
    recipient: { type: String, required: true, trim: true, lowercase: true, maxlength: 320 },
    payload: { type: Schema.Types.Mixed, required: true, default: {} },
    status: {
      type: String,
      enum: emailOutboxStatuses,
      required: true,
      default: "PENDING",
    },
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

// Idempotency — one send per (event, template, recipient), enforced by the database.
emailOutboxSchema.index({ dedupeKey: 1 }, { unique: true });
// The worker's claim query: eligible PENDING rows ordered by when they're due.
emailOutboxSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });
// Stale-claim recovery: PROCESSING rows ordered by how long they've been held.
emailOutboxSchema.index({ status: 1, claimedAt: 1 });

export const EmailOutboxModel = model<EmailOutboxDocument>("EmailOutbox", emailOutboxSchema);
