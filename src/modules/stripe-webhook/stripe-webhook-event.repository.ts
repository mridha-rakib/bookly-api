import { randomUUID } from "node:crypto";

import {
  type StripeWebhookEventDocument,
  StripeWebhookEventModel,
} from "./stripe-webhook-event.model.js";

const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 8;

export class StripeWebhookEventRepository {
  /** Atomically claims a new event, or a previously retryable event. A durable PROCESSED or
   * FAILED investigation row is never re-entered by duplicate delivery. */
  public async claim(
    eventId: string,
    type: string,
    payload?: Record<string, unknown>,
  ): Promise<string | null> {
    try {
      await new StripeWebhookEventModel({ eventId, type, status: "RECEIVED", payload }).save();
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) throw error;
    }

    const now = new Date();
    const token = randomUUID();
    const claimed = await StripeWebhookEventModel.findOneAndUpdate(
      {
        eventId,
        $or: [
          { status: "RECEIVED" },
          {
            status: "RETRYABLE",
            attemptCount: { $lt: MAX_ATTEMPTS },
            $or: [{ nextAttemptAt: { $lte: now } }, { nextAttemptAt: null }],
          },
          { status: "PROCESSING", leaseExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          status: "PROCESSING",
          processingStartedAt: now,
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
          processingLeaseToken: token,
          ...(payload ? { payload } : {}),
        },
        $inc: { attemptCount: 1 },
        $unset: { error: 1, nextAttemptAt: 1 },
      },
      { returnDocument: "after" },
    ).exec();
    return claimed ? token : null;
  }

  public async claimNextDue(): Promise<StripeWebhookEventDocument | null> {
    const now = new Date();
    const token = randomUUID();
    return StripeWebhookEventModel.findOneAndUpdate(
      {
        payload: { $exists: true },
        $or: [
          { status: "RECEIVED" },
          {
            status: "RETRYABLE",
            attemptCount: { $lt: MAX_ATTEMPTS },
            $or: [{ nextAttemptAt: { $lte: now } }, { nextAttemptAt: null }],
          },
          { status: "PROCESSING", leaseExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          status: "PROCESSING",
          processingStartedAt: now,
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
          processingLeaseToken: token,
        },
        $inc: { attemptCount: 1 },
        $unset: { error: 1, nextAttemptAt: 1 },
      },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    ).exec();
  }

  public async markProcessed(eventId: string, token: string): Promise<boolean> {
    const result = await StripeWebhookEventModel.updateOne(
      { eventId, status: "PROCESSING", processingLeaseToken: token },
      {
        $set: { status: "PROCESSED" },
        $unset: {
          leaseExpiresAt: 1,
          processingStartedAt: 1,
          processingLeaseToken: 1,
          nextAttemptAt: 1,
          error: 1,
        },
      },
    ).exec();
    return result.modifiedCount === 1;
  }

  public async markFailed(eventId: string, token: string, error: string): Promise<boolean> {
    const result = await StripeWebhookEventModel.updateOne(
      { eventId, status: "PROCESSING", processingLeaseToken: token },
      {
        $set: { status: "FAILED", error: error.slice(0, 2000) },
        $unset: {
          leaseExpiresAt: 1,
          processingStartedAt: 1,
          processingLeaseToken: 1,
          nextAttemptAt: 1,
        },
      },
    ).exec();
    return result.modifiedCount === 1;
  }

  public async markRetryable(eventId: string, token: string, error: string): Promise<boolean> {
    const current = await StripeWebhookEventModel.findOne({
      eventId,
      status: "PROCESSING",
      processingLeaseToken: token,
    }).exec();
    if (!current) return false;
    if (current.attemptCount >= MAX_ATTEMPTS) {
      return this.markFailed(eventId, token, `Retry limit reached: ${error}`);
    }
    const delayMs = Math.min(30_000 * 2 ** Math.max(0, current.attemptCount - 1), 15 * 60_000);
    const result = await StripeWebhookEventModel.updateOne(
      { eventId, status: "PROCESSING", processingLeaseToken: token },
      {
        $set: {
          status: "RETRYABLE",
          error: error.slice(0, 2000),
          nextAttemptAt: new Date(Date.now() + delayMs),
        },
        $unset: { leaseExpiresAt: 1, processingStartedAt: 1, processingLeaseToken: 1 },
      },
    ).exec();
    return result.modifiedCount === 1;
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}
