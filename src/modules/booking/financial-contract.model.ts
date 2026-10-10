import { Schema } from "mongoose";

import {
  FINANCIAL_CONTRACT_VERSION,
  type FinancialContractV2,
  financialContractProductKinds,
  relationshipClassifications,
} from "./financial-contract.js";

const cents = { type: Number, required: true, min: 0, validate: Number.isInteger } as const;

/** Embedded, immutable Financial Contract V2 snapshot — see financial-contract.ts. Shared by
 * BookingCreationClaim (the durable pre-charge copy) and Booking (the final snapshot). */
export const financialContractSchema = new Schema<FinancialContractV2>(
  {
    version: { type: Number, enum: [FINANCIAL_CONTRACT_VERSION], required: true },
    productKind: { type: String, enum: financialContractProductKinds, required: true },
    classification: { type: String, enum: relationshipClassifications, required: true },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 200 },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    customerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    businessClientId: { type: Schema.Types.ObjectId, ref: "BusinessClient", required: true },
    currency: { type: String, enum: ["EUR"], required: true },
    eligibleBasisCents: cents,
    requiredUpfrontCents: cents,
    promoDiscountCents: cents,
    onlineChargeCents: cents,
    travelFeeCents: cents,
    packageBundlePriceCents: { type: Number, min: 0, validate: Number.isInteger },
    bookingTotalCents: cents,
    upfrontLedgerType: { type: String, enum: ["PLATFORM_FEE", "DEPOSIT"], required: true },
  },
  { _id: false },
);

financialContractSchema.pre("validate", function () {
  const contract = this as unknown as FinancialContractV2;
  if (contract.requiredUpfrontCents > contract.bookingTotalCents) {
    throw new Error("requiredUpfrontCents cannot exceed bookingTotalCents");
  }
  if (contract.onlineChargeCents > contract.requiredUpfrontCents) {
    throw new Error("onlineChargeCents cannot exceed requiredUpfrontCents");
  }
  if (contract.onlineChargeCents + contract.promoDiscountCents !== contract.requiredUpfrontCents) {
    throw new Error("onlineChargeCents + promoDiscountCents must equal requiredUpfrontCents");
  }
  if ((contract.classification === "FIRST") !== (contract.upfrontLedgerType === "PLATFORM_FEE")) {
    throw new Error("A FIRST contract is always PLATFORM_FEE-owned; RETURNING is DEPOSIT-owned");
  }
  if (
    contract.classification === "FIRST" &&
    contract.requiredUpfrontCents > contract.eligibleBasisCents
  ) {
    throw new Error("A FIRST upfront can never exceed its eligible basis");
  }
  if (
    (contract.productKind === "PACKAGE_PURCHASE") !==
    (contract.packageBundlePriceCents !== undefined)
  ) {
    throw new Error("packageBundlePriceCents is required exactly for a PACKAGE_PURCHASE contract");
  }
});
