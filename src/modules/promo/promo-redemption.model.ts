import { model, Schema, type Types } from "mongoose";
import type { PromoFundingOwner, PromoType } from "./promo.types.js";

/**
 * Batch 13 — the immutable, permanent audit trail of one successful Promo redemption. Written
 * ONLY inside the same MongoDB transaction that persists the redeeming Booking (mirrors the
 * ledger's own append-only, transaction-scoped-write discipline) — never edited afterward, never
 * deleted on cancellation/refund (rule #13: "once redeemed, permanently consumed... a refund is
 * financial, redemption history remains historical/auditable").
 *
 * Denormalizes the Promo's code/type/value AT REDEMPTION TIME (never re-reads the live PromoCode
 * later) so this row — and every downstream usage-log/analytics read of it — stays correct even
 * if the Promo is later edited or deactivated (matches BookingServiceLine.serviceSnapshot's own
 * "a later edit/archive must never corrupt historical facts" convention).
 */
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
  /** The canonical, un-discounted online booking-time amount (== the Booking's own
   * `financials.depositCents`, snapshotted here too since immutability of THIS row must not
   * depend on the Booking document never changing it later). */
  depositBeforePromoCents: number;
  promoDiscountCents: number;
  /** What the customer actually paid online — always `depositBeforePromoCents -
   * promoDiscountCents`, clamped at 0. */
  customerChargeNowCents: number;
  fundingOwner: PromoFundingOwner;
  /** The REAL, post-activation-race-resolution first/returning outcome (never the pre-charge
   * optimistic snapshot) — see booking-creation.service.ts's promo integration comment. */
  isFirstBooking: boolean;
  redeemedAt: Date;
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
    depositBeforePromoCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    promoDiscountCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    customerChargeNowCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    fundingOwner: { type: String, required: true, default: "BOOKLY" },
    isFirstBooking: { type: Boolean, required: true },
    redeemedAt: { type: Date, required: true, default: () => new Date() },
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
