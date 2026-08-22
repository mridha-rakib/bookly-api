import { model, Schema, type Types } from "mongoose";

/**
 * Idempotent webhook-processing log (Batch 4, Phase 10). Stripe redelivers webhooks on any
 * non-2xx response, and can also occasionally deliver the same event more than once even on a
 * successful delivery — this collection's unique index on `eventId` is what makes "process this
 * event" itself an idempotent, replay-safe operation, independent of whatever the event's own
 * handler does (which typically ALSO has its own idempotency via the ledger's own
 * idempotencyKey — see booking-financial-transaction.model.ts). Two independent layers of
 * idempotency here is deliberate defense in depth, not redundancy: this layer guards "did we
 * already see this exact Stripe event," the ledger layer guards "did we already charge/refund
 * for this exact logical operation" — a single event could in principle map to work that
 * ALSO needs its own idempotency key if it were ever split across retries.
 */
export type StripeWebhookEventDocument = {
  _id: Types.ObjectId;
  eventId: string;
  type: string;
  status: "RECEIVED" | "PROCESSED" | "FAILED";
  error?: string | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const stripeWebhookEventSchema = new Schema<StripeWebhookEventDocument>(
  {
    eventId: { type: String, required: true, trim: true },
    type: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["RECEIVED", "PROCESSED", "FAILED"],
      required: true,
      default: "RECEIVED",
    },
    error: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true },
);

stripeWebhookEventSchema.index({ eventId: 1 }, { unique: true });

export const StripeWebhookEventModel = model<StripeWebhookEventDocument>(
  "StripeWebhookEvent",
  stripeWebhookEventSchema,
);
