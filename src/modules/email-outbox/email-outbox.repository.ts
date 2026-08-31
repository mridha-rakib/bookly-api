import type { Types } from "mongoose";

import { type EmailOutboxDocument, EmailOutboxModel } from "./email-outbox.model.js";
import {
  buildEmailDedupeKey,
  type EnqueueEmailInput,
  normalizeEmailRecipient,
} from "./email-outbox.types.js";

export type EnqueueEmailResult = {
  /** false when an identical (eventKey, templateKey, recipient) row already existed. */
  created: boolean;
  record: EmailOutboxDocument;
};

export type ClaimOptions = {
  workerId: string;
  now: Date;
  /** A PROCESSING row older than this is considered abandoned and may be re-claimed. */
  claimTimeoutMs: number;
  maxAttempts: number;
};

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === 11000;

export class EmailOutboxRepository {
  public async enqueue(input: EnqueueEmailInput): Promise<EnqueueEmailResult> {
    const recipient = normalizeEmailRecipient(input.recipient);
    const dedupeKey = buildEmailDedupeKey(input.eventKey, input.templateKey, recipient);

    try {
      const record = await new EmailOutboxModel({
        dedupeKey,
        eventKey: input.eventKey,
        templateKey: input.templateKey,
        recipient,
        payload: input.payload,
        status: "PENDING",
        attemptCount: 0,
      }).save();
      return { created: true, record };
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      const existing = await EmailOutboxModel.findOne({ dedupeKey }).orFail();
      return { created: false, record: existing };
    }
  }

  /**
   * Atomically moves ONE eligible row to PROCESSING and returns it (`null` when none). A row is
   * eligible when it is PENDING and due, OR PROCESSING but its claim has gone stale — in both
   * cases only while it still has attempts left. `attemptCount` is incremented as part of the
   * same atomic write.
   */
  public async claimNext(options: ClaimOptions): Promise<EmailOutboxDocument | null> {
    const staleBefore = new Date(options.now.getTime() - options.claimTimeoutMs);

    return EmailOutboxModel.findOneAndUpdate(
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
  public async markSent(
    id: Types.ObjectId,
    input: { provider: string; providerMessageId?: string | undefined; now: Date },
  ): Promise<EmailOutboxDocument | null> {
    return EmailOutboxModel.findOneAndUpdate(
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

  public async scheduleRetry(
    id: Types.ObjectId,
    input: { category: string; message: string; nextAttemptAt: Date },
  ): Promise<EmailOutboxDocument | null> {
    return EmailOutboxModel.findOneAndUpdate(
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

  public async markFailed(
    id: Types.ObjectId,
    input: { category: string; message: string },
  ): Promise<EmailOutboxDocument | null> {
    return EmailOutboxModel.findOneAndUpdate(
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

  /** Explicit sweep: any PROCESSING row whose claim is older than the timeout goes back to
   * PENDING so it becomes claimable again. `claimNext` already reclaims stale rows on its own;
   * this makes the recovery observable and lets a run start from a clean state. */
  public async resetStaleProcessing(staleBefore: Date): Promise<number> {
    const result = await EmailOutboxModel.updateMany(
      { status: "PROCESSING", claimedAt: { $lte: staleBefore } },
      { $set: { status: "PENDING" }, $unset: { claimedAt: "", claimedBy: "" } },
    ).exec();
    return result.modifiedCount ?? 0;
  }

  public findByDedupeKey(dedupeKey: string): Promise<EmailOutboxDocument | null> {
    return EmailOutboxModel.findOne({ dedupeKey }).exec();
  }
}
