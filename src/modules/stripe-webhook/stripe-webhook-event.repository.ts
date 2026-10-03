import { StripeWebhookEventModel } from "./stripe-webhook-event.model.js";

export class StripeWebhookEventRepository {
  /** Atomically claims a new event, or a previously retryable event. A durable PROCESSED or
   * FAILED investigation row is never re-entered by duplicate delivery. */
  public async claim(eventId: string, type: string): Promise<boolean> {
    try {
      await new StripeWebhookEventModel({ eventId, type, status: "RECEIVED" }).save();
      return true;
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        const retried = await StripeWebhookEventModel.findOneAndUpdate(
          { eventId, status: "RETRYABLE" },
          { $set: { status: "RECEIVED" }, $unset: { error: 1 } },
          { returnDocument: "after" },
        ).exec();
        return retried !== null;
      }
      throw error;
    }
  }

  public async markProcessed(eventId: string): Promise<void> {
    await StripeWebhookEventModel.updateOne({ eventId }, { $set: { status: "PROCESSED" } }).exec();
  }

  public async markFailed(eventId: string, error: string): Promise<void> {
    await StripeWebhookEventModel.updateOne(
      { eventId },
      { $set: { status: "FAILED", error: error.slice(0, 2000) } },
    ).exec();
  }

  public async markRetryable(eventId: string, error: string): Promise<void> {
    await StripeWebhookEventModel.updateOne(
      { eventId },
      { $set: { status: "RETRYABLE", error: error.slice(0, 2000) } },
    ).exec();
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
