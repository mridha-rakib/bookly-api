import { Schema } from "mongoose";

import { promoTypes } from "../promo/promo.types.js";
import {
  type FinancialContract,
  type FinancialContractPromo,
  financialContractProductKinds,
  financialContractVersions,
  findFinancialContractInvariantViolation,
  relationshipClassifications,
} from "./financial-contract.js";

const cents = { type: Number, required: true, min: 0, validate: Number.isInteger } as const;

/** V3 only — the frozen promo identity (see FinancialContractPromo). */
const financialContractPromoSchema = new Schema<FinancialContractPromo>(
  {
    promoId: { type: Schema.Types.ObjectId, ref: "PromoCode", required: true },
    normalizedCode: { type: String, required: true, trim: true, maxlength: 40 },
    type: { type: String, enum: promoTypes, required: true },
    value: { type: Number, required: true, min: 0, validate: Number.isFinite },
    fundingOwner: { type: String, enum: ["BUSINESS"], required: true },
  },
  { _id: false },
);

/** Embedded, immutable Financial Contract snapshot (V2 or V3) — see financial-contract.ts.
 * Shared by BookingCreationClaim (the durable pre-charge copy) and Booking (the final
 * snapshot). */
export const financialContractSchema = new Schema<FinancialContract>(
  {
    version: { type: Number, enum: financialContractVersions, required: true },
    productKind: { type: String, enum: financialContractProductKinds, required: true },
    classification: { type: String, enum: relationshipClassifications, required: true },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 200 },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    customerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    businessClientId: { type: Schema.Types.ObjectId, ref: "BusinessClient", required: true },
    currency: { type: String, enum: ["EUR"], required: true },
    eligibleBasisCents: cents,
    promoEligibleBaseCents: { type: Number, min: 0, validate: Number.isInteger },
    requiredUpfrontCents: cents,
    promoDiscountCents: cents,
    onlineChargeCents: cents,
    travelFeeCents: cents,
    packageBundlePriceCents: { type: Number, min: 0, validate: Number.isInteger },
    bookingTotalCents: cents,
    upfrontLedgerType: { type: String, enum: ["PLATFORM_FEE", "DEPOSIT"], required: true },
    promo: { type: financialContractPromoSchema },
  },
  { _id: false },
);

financialContractSchema.pre("validate", function () {
  const violation = findFinancialContractInvariantViolation(this as unknown as FinancialContract);
  if (violation) {
    throw new Error(violation);
  }
});
