import { StripeWebhookEventModel } from "./stripe-webhook-event.model.js";

export class StripeWebhookEventRepository {
  /** Atomically claims one Stripe event id — the true idempotency gate (see the model's own
   * comment). Returns `false` (never throws) when the event was already seen, so the caller
   * can return a plain 200 to Stripe without reprocessing, matching Stripe's own documented
   * webhook-idempotency guidance. */
  public async claim(eventId: string, type: string): Promise<boolean> {
    try {
      await new StripeWebhookEventModel({ eventId, type, status: "RECEIVED" }).save();
      return true;
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        return false;
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

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}
