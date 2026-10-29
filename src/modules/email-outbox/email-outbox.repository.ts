import type { ClientSession, Types } from "mongoose";

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

/**
 * Identifies ONE claim of a row. `attemptCount` is incremented by every claim, so together with
 * `claimedBy` it distinguishes this claim from any later reclaim of the same row — without a
 * schema change. Optional only for compatibility; the worker always passes it.
 */
export type EmailOutboxClaimFence = { claimedBy?: string | undefined; attemptCount: number };

const ownedBy = (fence: EmailOutboxClaimFence | undefined): Record<string, unknown> =>
  fence
    ? {
        attemptCount: fence.attemptCount,
        ...(fence.claimedBy === undefined ? {} : { claimedBy: fence.claimedBy }),
      }
    : {};

/** Recorded on a row whose final attempt's claim expired without a recorded outcome. */
export const EMAIL_OUTBOX_CLAIM_ABANDONED = "CLAIM_ABANDONED_OUTCOME_UNKNOWN" as const;

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === 11000;

export class EmailOutboxRepository {
  public async enqueue(
    input: EnqueueEmailInput,
    session?: ClientSession,
  ): Promise<EnqueueEmailResult> {
    if (session && !session.inTransaction())
      throw new Error("Email scheduling requires an active caller transaction");
    const recipient = normalizeEmailRecipient(input.recipient);
    const dedupeKey = buildEmailDedupeKey(input.eventKey, input.templateKey, recipient);

    if (session) {
      const existing = await EmailOutboxModel.findOne({ dedupeKey }).session(session).exec();
      if (existing) return { created: false, record: existing };
    }
    try {
      const record = await new EmailOutboxModel({
        dedupeKey,
        eventKey: input.eventKey,
        templateKey: input.templateKey,
        recipient,
        payload: input.payload,
        status: "PENDING",
        attemptCount: 0,
      }).save(session ? { session } : undefined);
      return { created: true, record };
    } catch (error) {
      // A failed transactional insert can invalidate the entire session. Only its owner may
      // retry; an out-of-session lookup could otherwise turn an aborted write into success.
      if (session) throw error;
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

  /** SENT is terminal and records PROVIDER ACCEPTANCE only — never recipient delivery.
   *
   * Deliberately NOT owner-fenced: an acceptance the provider really returned is a fact, so a
   * worker whose claim went stale (reset to PENDING, or reclaimed and still in flight) may still
   * record it. That stops a later, avoidable resend of a PENDING row. It cannot recall a send
   * another worker already started. SENT and FAILED rows are never overwritten; `null` means
   * the acceptance was not recorded and the caller must surface that. */
  public async markSent(
    id: Types.ObjectId,
    input: { provider: string; providerMessageId?: string | undefined; now: Date },
  ): Promise<EmailOutboxDocument | null> {
    return EmailOutboxModel.findOneAndUpdate(
      { _id: id, status: { $in: ["PROCESSING", "PENDING"] } },
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

  /** Owner-fenced: only the claim that made the attempt may reschedule it. A stale worker
   * cannot pull a row back from a newer claim. */
  public async scheduleRetry(
    id: Types.ObjectId,
    input: {
      category: string;
      message: string;
      nextAttemptAt: Date;
      claim?: EmailOutboxClaimFence | undefined;
    },
  ): Promise<EmailOutboxDocument | null> {
    return EmailOutboxModel.findOneAndUpdate(
      { _id: id, status: "PROCESSING", ...ownedBy(input.claim) },
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

  /** Owner-fenced: a stale worker's failure cannot overwrite a newer claim that may succeed. */
  public async markFailed(
    id: Types.ObjectId,
    input: { category: string; message: string; claim?: EmailOutboxClaimFence | undefined },
  ): Promise<EmailOutboxDocument | null> {
    return EmailOutboxModel.findOneAndUpdate(
      { _id: id, status: "PROCESSING", ...ownedBy(input.claim) },
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
   * this makes the recovery observable and lets a run start from a clean state.
   *
   * With `maxAttempts`, a stale row that has no attempts left (and a PENDING row left in that
   * state by an earlier sweep) can never be claimed again, so it is moved to FAILED with
   * {@link EMAIL_OUTBOX_CLAIM_ABANDONED} instead of sitting PENDING forever. Its provider outcome
   * is UNKNOWN: the abandoned attempt may or may not have been accepted. */
  public async resetStaleProcessing(staleBefore: Date, maxAttempts?: number): Promise<number> {
    let abandoned = 0;
    if (maxAttempts !== undefined) {
      const exhausted = await EmailOutboxModel.updateMany(
        {
          attemptCount: { $gte: maxAttempts },
          $or: [{ status: "PROCESSING", claimedAt: { $lte: staleBefore } }, { status: "PENDING" }],
        },
        {
          $set: {
            status: "FAILED",
            lastErrorCategory: EMAIL_OUTBOX_CLAIM_ABANDONED,
            lastErrorMessage:
              "Final attempt's claim expired without a recorded outcome; provider acceptance unknown",
          },
          $unset: { claimedAt: "", claimedBy: "", nextAttemptAt: "" },
        },
      ).exec();
      abandoned = exhausted.modifiedCount ?? 0;
    }
    const result = await EmailOutboxModel.updateMany(
      { status: "PROCESSING", claimedAt: { $lte: staleBefore } },
      { $set: { status: "PENDING" }, $unset: { claimedAt: "", claimedBy: "" } },
    ).exec();
    return (result.modifiedCount ?? 0) + abandoned;
  }

  public findByDedupeKey(dedupeKey: string): Promise<EmailOutboxDocument | null> {
    return EmailOutboxModel.findOne({ dedupeKey }).exec();
  }
}
