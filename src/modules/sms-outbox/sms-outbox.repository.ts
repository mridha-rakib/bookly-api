import type { Types } from "mongoose";

import { type SmsOutboxDocument, SmsOutboxModel } from "./sms-outbox.model.js";
import {
  buildSmsDedupeKey,
  type EnqueueSmsInput,
  isValidE164,
  normalizeSmsRecipient,
} from "./sms-outbox.types.js";

export type EnqueueSmsResult = {
  /** false when an identical (eventKey, recipient) row already existed. */
  created: boolean;
  record: SmsOutboxDocument;
};

export type ClaimSmsOptions = {
  workerId: string;
  now: Date;
  /** A PROCESSING row older than this is considered abandoned and may be re-claimed. */
  claimTimeoutMs: number;
  maxAttempts: number;
};

export class SmsOutboxEnqueueError extends Error {
  public constructor(public readonly reason: "INVALID_RECIPIENT" | "EMPTY_BODY") {
    super(`SmsOutbox enqueue rejected: ${reason}`);
    this.name = "SmsOutboxEnqueueError";
  }
}

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === 11000;

/**
 * SmsOutbox persistence. No Twilio logic and no retry classification here — the worker owns
 * `SmsError.retryable` branching, exactly as EmailOutboxWorker owns it for email.
 */
export class SmsOutboxRepository {
  /**
   * Idempotent enqueue. A duplicate (eventKey, recipient) returns the existing row with
   * `created: false` — never a second logical SMS. Rejects an obviously-malformed recipient or
   * an empty body at this infrastructure boundary (Stage 3B is responsible for only ever
   * passing a verified, normalized E.164 number).
   */
  public async enqueue(input: EnqueueSmsInput): Promise<EnqueueSmsResult> {
    const recipientE164 = normalizeSmsRecipient(input.recipientE164);
    if (!isValidE164(recipientE164)) {
      throw new SmsOutboxEnqueueError("INVALID_RECIPIENT");
    }
    const body = input.body.trim();
    if (body.length === 0) {
      throw new SmsOutboxEnqueueError("EMPTY_BODY");
    }

    const dedupeKey = buildSmsDedupeKey(input.eventKey, recipientE164);

    try {
      const record = await new SmsOutboxModel({
        dedupeKey,
        eventKey: input.eventKey,
        recipientE164,
        body,
        ...(input.metadata && Object.keys(input.metadata).length > 0
          ? { metadata: input.metadata }
          : {}),
        status: "PENDING",
        attemptCount: 0,
      }).save();
      return { created: true, record };
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      const existing = await SmsOutboxModel.findOne({ dedupeKey }).orFail();
      return { created: false, record: existing };
    }
  }

  public findByDedupeKey(dedupeKey: string): Promise<SmsOutboxDocument | null> {
    return SmsOutboxModel.findOne({ dedupeKey }).exec();
  }

  /**
   * Atomically move ONE eligible row to PROCESSING and return it (`null` when none). Eligible =
   * PENDING and due, OR PROCESSING with a stale claim — in both cases only while attempts
   * remain. `attemptCount` is incremented in the same write.
   */
  public claimNext(options: ClaimSmsOptions): Promise<SmsOutboxDocument | null> {
    const staleBefore = new Date(options.now.getTime() - options.claimTimeoutMs);

    return SmsOutboxModel.findOneAndUpdate(
      {
        attemptCount: { $lt: options.maxAttempts },
        $or: [
          {
            status: "PENDING",
            $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: options.now } }],
          },
          { status: "PROCESSING", claimedAt: { $lte: staleBefore } },
        ],
      },
      {
        $set: { status: "PROCESSING", claimedAt: options.now, claimedBy: options.workerId },
        $inc: { attemptCount: 1 },
      },
      { returnDocument: "after", sort: { nextAttemptAt: 1, createdAt: 1 } },
    ).exec();
  }

  /** SENT is terminal — the `status: "PROCESSING"` guard means a re-delivered row is never
   * over-written, and a crashed worker whose row was reclaimed+sent elsewhere can't clobber it. */
  public markSent(
    id: Types.ObjectId,
    input: { provider: string; providerMessageId?: string | undefined; now: Date },
  ): Promise<SmsOutboxDocument | null> {
    return SmsOutboxModel.findOneAndUpdate(
      { _id: id, status: "PROCESSING" },
      {
        $set: {
          status: "SENT",
          sentAt: input.now,
          provider: input.provider,
          ...(input.providerMessageId ? { providerMessageId: input.providerMessageId } : {}),
        },
        $unset: { claimedAt: "", claimedBy: "", nextAttemptAt: "" },
      },
      { returnDocument: "after" },
    ).exec();
  }

  public scheduleRetry(
    id: Types.ObjectId,
    input: { category: string; message: string; nextAttemptAt: Date },
  ): Promise<SmsOutboxDocument | null> {
    return SmsOutboxModel.findOneAndUpdate(
      { _id: id, status: "PROCESSING" },
      {
        $set: {
          status: "PENDING",
          nextAttemptAt: input.nextAttemptAt,
          lastErrorCategory: input.category,
          lastErrorMessage: input.message.slice(0, 500),
        },
        $unset: { claimedAt: "", claimedBy: "" },
      },
      { returnDocument: "after" },
    ).exec();
  }

  public markFailed(
    id: Types.ObjectId,
    input: { category: string; message: string },
  ): Promise<SmsOutboxDocument | null> {
    return SmsOutboxModel.findOneAndUpdate(
      { _id: id, status: "PROCESSING" },
      {
        $set: {
          status: "FAILED",
          lastErrorCategory: input.category,
          lastErrorMessage: input.message.slice(0, 500),
        },
        $unset: { claimedAt: "", claimedBy: "" },
      },
      { returnDocument: "after" },
    ).exec();
  }

  /** Explicit sweep so a run can start from a clean state (claimNext also self-reclaims). */
  public async resetStaleProcessing(staleBefore: Date): Promise<number> {
    const result = await SmsOutboxModel.updateMany(
      { status: "PROCESSING", claimedAt: { $lte: staleBefore } },
      { $set: { status: "PENDING" }, $unset: { claimedAt: "", claimedBy: "" } },
    ).exec();
    return result.modifiedCount ?? 0;
  }
}
