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
  /** RETRYABLE is deliberately distinct from FAILED: a missing ledger row or Stripe's delayed
   * balance transaction must be retried, while corrupt provider correlation needs investigation
   * without an infinite delivery loop. */
  status: "RECEIVED" | "PROCESSING" | "PROCESSED" | "RETRYABLE" | "FAILED";
  payload?: Record<string, unknown> | undefined;
  processingStartedAt?: Date | undefined;
  leaseExpiresAt?: Date | undefined;
  processingLeaseToken?: string | undefined;
  attemptCount: number;
  nextAttemptAt?: Date | undefined;
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
      enum: ["RECEIVED", "PROCESSING", "PROCESSED", "RETRYABLE", "FAILED"],
      required: true,
      default: "RECEIVED",
    },
    error: { type: String, trim: true, maxlength: 2000 },
    payload: { type: Schema.Types.Mixed },
    processingStartedAt: { type: Date },
    leaseExpiresAt: { type: Date },
    processingLeaseToken: { type: String, trim: true },
    attemptCount: { type: Number, required: true, min: 0, default: 0 },
    nextAttemptAt: { type: Date },
  },
  { timestamps: true },
);

stripeWebhookEventSchema.index({ eventId: 1 }, { unique: true });
stripeWebhookEventSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });
stripeWebhookEventSchema.index({ status: 1, leaseExpiresAt: 1, createdAt: 1 });

export const StripeWebhookEventModel = model<StripeWebhookEventDocument>(
  "StripeWebhookEvent",
  stripeWebhookEventSchema,
);
