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
  /** Only a stale pre-dispatch PROCESSING row may be reset for another claim. */
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
        providerStarted: false,
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
   * Atomically claim one due, never-issued row. Stale pre-dispatch rows are reset separately;
   * a row with a possible provider request cannot be claimed again.
   */
  public claimNext(options: ClaimSmsOptions): Promise<SmsOutboxDocument | null> {
    return SmsOutboxModel.findOneAndUpdate(
      {
        attemptCount: { $lt: options.maxAttempts },
        status: "PENDING",
        providerStarted: false,
        $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: options.now } }],
      },
      {
        $set: { status: "PROCESSING", claimedAt: options.now, claimedBy: options.workerId },
        $inc: { attemptCount: 1 },
      },
      { returnDocument: "after", sort: { nextAttemptAt: 1, createdAt: 1 } },
    ).exec();
  }

  /** Claim-fenced, durable permission consumed before calling the provider. */
  public markProviderStarted(record: SmsOutboxDocument): Promise<SmsOutboxDocument | null> {
    if (!record.claimedBy) return Promise.resolve(null);
    return SmsOutboxModel.findOneAndUpdate(
      {
        _id: record._id,
        status: "PROCESSING",
        attemptCount: record.attemptCount,
        claimedBy: record.claimedBy,
        providerStarted: false,
      },
      { $set: { providerStarted: true } },
      { returnDocument: "after" },
    ).exec();
  }

  /** SENT is terminal; exact attempt and claimant fence late acknowledgements. */
  public markSent(
    record: SmsOutboxDocument,
    input: { provider: string; providerMessageId?: string | undefined; now: Date },
  ): Promise<SmsOutboxDocument | null> {
    if (!record.claimedBy) return Promise.resolve(null);
    return SmsOutboxModel.findOneAndUpdate(
      {
        _id: record._id,
        status: "PROCESSING",
        providerStarted: true,
        attemptCount: record.attemptCount,
        claimedBy: record.claimedBy,
      },
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

  /** A provider request may still settle; this state has no automatic resend path. */
  public markUnknown(
    record: SmsOutboxDocument,
    category: string,
  ): Promise<SmsOutboxDocument | null> {
    if (!record.claimedBy) return Promise.resolve(null);
    return SmsOutboxModel.findOneAndUpdate(
      {
        _id: record._id,
        status: "PROCESSING",
        providerStarted: true,
        attemptCount: record.attemptCount,
        claimedBy: record.claimedBy,
      },
      {
        $set: {
          status: "UNKNOWN_OUTCOME",
          lastErrorCategory: category,
          lastErrorMessage: "Provider outcome requires reconciliation",
        },
        $unset: { claimedAt: "", claimedBy: "", nextAttemptAt: "" },
      },
      { returnDocument: "after" },
    ).exec();
  }

  public scheduleRetry(
    record: SmsOutboxDocument,
    input: { category: string; message: string; nextAttemptAt: Date },
  ): Promise<SmsOutboxDocument | null> {
    if (!record.claimedBy) return Promise.resolve(null);
    return SmsOutboxModel.findOneAndUpdate(
      {
        _id: record._id,
        status: "PROCESSING",
        providerStarted: false,
        attemptCount: record.attemptCount,
        claimedBy: record.claimedBy,
      },
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
    record: SmsOutboxDocument,
    input: { category: string; message: string },
  ): Promise<SmsOutboxDocument | null> {
    if (!record.claimedBy) return Promise.resolve(null);
    return SmsOutboxModel.findOneAndUpdate(
      {
        _id: record._id,
        status: "PROCESSING",
        providerStarted: false,
        attemptCount: record.attemptCount,
        claimedBy: record.claimedBy,
      },
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

  /** Only a proven pre-dispatch stale claim is reset. Unknown issued work stays quarantined. */
  public async resetStaleProcessing(staleBefore: Date): Promise<number> {
    const result = await SmsOutboxModel.updateMany(
      { status: "PROCESSING", providerStarted: false, claimedAt: { $lte: staleBefore } },
      { $set: { status: "PENDING" }, $unset: { claimedAt: "", claimedBy: "" } },
    ).exec();
    return result.modifiedCount ?? 0;
  }
}
