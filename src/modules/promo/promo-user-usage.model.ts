import { model, Schema, type Types } from "mongoose";

/**
 * Batch 13 — the concurrency-safe per-customer usage counter for a Promo Code. Deliberately a
 * separate one-row-per-(promo,customer) collection rather than an embedded per-user map on
 * PromoCode itself: an embedded map growing per redeeming customer would need unbounded
 * document growth and could not be CAS-incremented per-key safely at scale, whereas this mirrors
 * the same flat-unique-index primitive `booking-creation-claim.model.ts`/
 * `booking-slot-reservation-claim.model.ts` already establish for exactly-once semantics.
 *
 * Claim sequence (see PromoUserUsageRepository.claim): (1) idempotent `updateOne` with
 * `upsert: true` and `$setOnInsert` ensures the row exists (a concurrent duplicate insert is
 * caught via this collection's own unique index and safely ignored, same idiom as
 * `resolveOrCreateCustomerClient`); (2) a single atomic `findOneAndUpdate` gated on
 * `count < perUserUsageLimit` with `$inc: { count: 1 }` — this is the ONLY write that can ever
 * increment `count`, so it can never exceed the limit even under concurrent redemption attempts.
 */
export type PromoUserUsageDocument = {
  _id: Types.ObjectId;
  promoId: Types.ObjectId;
  customerUserId: Types.ObjectId;
  count: number;
  createdAt: Date;
  updatedAt: Date;
};

const promoUserUsageSchema = new Schema<PromoUserUsageDocument>(
  {
    promoId: { type: Schema.Types.ObjectId, ref: "PromoCode", required: true },
    customerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    count: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true },
);

promoUserUsageSchema.index({ promoId: 1, customerUserId: 1 }, { unique: true });

export const PromoUserUsageModel = model<PromoUserUsageDocument>(
  "PromoUserUsage",
  promoUserUsageSchema,
);
