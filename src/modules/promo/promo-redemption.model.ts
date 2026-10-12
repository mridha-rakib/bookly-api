import { model, Schema, type Types } from "mongoose";
import type { PromoFundingOwner, PromoType } from "./promo.types.js";

/** Immutable redemption price/identity history. P4 adds auditable usage-restoration markers;
 * business cancellation returns capacity without deleting the historical redemption. */
export type PromoRedemptionDocument = {
  _id: Types.ObjectId;
  promoId: Types.ObjectId;
  codeSnapshot: string;
  typeSnapshot: PromoType;
  valueSnapshot: number;
  /** One redemption row per Booking — enforced by the unique index below, the same "align
   * redemption commit atomically with booking creation" guarantee the spec requires. */
  bookingId: Types.ObjectId;
  businessId: Types.ObjectId;
  customerUserId: Types.ObjectId;
  /** P2 only (BUSINESS-funded rows) — the normal booking price BEFORE the promo: services +
   * add-ons − service discount, travel excluded. The discounted price is
   * `promoEligibleBaseCents − promoDiscountCents`. Absent on Batch 13 (BOOKLY-funded) rows. */
  promoEligibleBaseCents?: number | undefined;
  /** Batch 13 rows: the un-discounted online upfront the promo was taken off. P2 rows: the
   * upfront computed from the DISCOUNTED price (no separate pre-promo upfront exists), so it
   * equals `customerChargeNowCents`. Snapshotted here so THIS row's immutability never depends
   * on the Booking document. */
  depositBeforePromoCents: number;
  /** Batch 13 rows: off the upfront. P2 rows: off the booking price (`promoEligibleBaseCents`). */
  promoDiscountCents: number;
  /** What the customer actually paid online. Batch 13: `depositBeforePromoCents -
   * promoDiscountCents`, clamped at 0. P2: the full upfront on the discounted price. */
  customerChargeNowCents: number;
  /** BOOKLY (Batch 13, legacy) or BUSINESS (every P2 redemption). */
  fundingOwner: PromoFundingOwner;
  /** The REAL, post-activation-race-resolution first/returning outcome (never the pre-charge
   * optimistic snapshot) — see booking-creation.service.ts's promo integration comment. */
  isFirstBooking: boolean;
  redeemedAt: Date;
  /** P4: usage returned by a committed business cancellation; history is retained. */
  usageRestoredAt?: Date | undefined;
  /** Whether this redemption actually incremented the optional per-user cap counter. */
  userUsageCounted?: boolean | undefined;
  usageRestoredByUserId?: Types.ObjectId | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const promoRedemptionSchema = new Schema<PromoRedemptionDocument>(
  {
    promoId: { type: Schema.Types.ObjectId, ref: "PromoCode", required: true },
    codeSnapshot: { type: String, required: true },
    typeSnapshot: { type: String, required: true },
    valueSnapshot: { type: Number, required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    customerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    promoEligibleBaseCents: { type: Number, min: 0, validate: Number.isInteger },
    depositBeforePromoCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    promoDiscountCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    customerChargeNowCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    fundingOwner: { type: String, required: true, default: "BOOKLY" },
    isFirstBooking: { type: Boolean, required: true },
    redeemedAt: { type: Date, required: true, default: () => new Date() },
    usageRestoredAt: { type: Date },
    userUsageCounted: { type: Boolean },
    usageRestoredByUserId: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

promoRedemptionSchema.index({ bookingId: 1 }, { unique: true });
// Usage log (Super Admin) — newest-first per promo.
promoRedemptionSchema.index({ promoId: 1, createdAt: -1 });
// Per-user usage-log/analytics lookups.
promoRedemptionSchema.index({ promoId: 1, customerUserId: 1 });

export const PromoRedemptionModel = model<PromoRedemptionDocument>(
  "PromoRedemption",
  promoRedemptionSchema,
);
