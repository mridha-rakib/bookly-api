import { model, Schema, type Types } from "mongoose";

import type { FinancialContract } from "./financial-contract.js";
import { financialContractSchema } from "./financial-contract.model.js";
import {
  type PackageCheckoutRetention,
  packageCheckoutRetentionSchema,
} from "./package-checkout-retention.js";
import {
  type PackageRequestBinding,
  packageRequestBindingMongooseSchema,
  packageRequestBindingSchema,
} from "./package-request-binding.js";

/**
 * Booking-creation idempotency contract (Batch 3) — mirrors
 * booking-slot-reservation-claim.model.ts's proven design exactly: a flat, single-level unique
 * index is the only reliably-enforced form of MongoDB uniqueness (see that model's own doc
 * comment for the empirical finding this is based on), so idempotency for the much larger
 * Booking-creation operation reuses the same primitive rather than inventing a second scheme.
 *
 * `bookingId` is populated with a client-generated (`new Types.ObjectId()`) id BEFORE the
 * Booking document itself is written — the claim is inserted first, outside the creation
 * transaction (see BookingCreationService.createManualBooking), so a losing concurrent request
 * with the same key can immediately resolve to the winner's `bookingId` without waiting on or
 * inspecting the transaction. If the subsequent transactional creation fails for any reason
 * (a genuine validation error, a reservation conflict, a transient transaction error), a
 * no-payment flow deletes the claim. A charge-bearing flow deliberately retains it and links
 * the same logical key/booking id through PaymentAttempt so an ambiguous retry cannot create a
 * second provider operation.
 */
export type BookingCreationClaimDocument = {
  /** P3-B1: durable unaccepted offer only; excluded from ordinary release/payment paths. */
  packageCheckoutRetention?: PackageCheckoutRetention | undefined;
  packageRequestBinding?: PackageRequestBinding | undefined;
  _id: Types.ObjectId;
  idempotencyKey: string;
  businessId: Types.ObjectId;
  actorUserId: Types.ObjectId;
  bookingId: Types.ObjectId;
  /** P1 — the immutable Financial Contract V2 for a customer booking/package purchase, recorded
   * once (set-if-absent) BEFORE any provider charge. Absent for manual bookings, package
   * Session 2+ redemptions, and claims created before P1. */
  financialContract?: FinancialContract | undefined;
  createdAt: Date;
};

const bookingCreationClaimSchema = new Schema<BookingCreationClaimDocument>(
  {
    packageCheckoutRetention: { type: Schema.Types.Mixed },
    packageRequestBinding: { type: packageRequestBindingMongooseSchema },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 200 },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    financialContract: { type: financialContractSchema },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

bookingCreationClaimSchema.index({ idempotencyKey: 1 }, { unique: true });
bookingCreationClaimSchema.pre("validate", function () {
  if (
    !this.isNew &&
    ["packageCheckoutRetention", "idempotencyKey", "businessId", "actorUserId", "bookingId"].some(
      (key) => this.isModified(key),
    )
  )
    this.invalidate("packageCheckoutRetention", "Creation claim identity/retention is immutable");
  if (this.packageCheckoutRetention) {
    const result = packageCheckoutRetentionSchema.safeParse(
      this.toObject().packageCheckoutRetention,
    );
    if (!result.success) this.invalidate("packageCheckoutRetention", result.error.message);
    else {
      const quote = result.data.quote.payload;
      if (
        this.packageRequestBinding ||
        this.financialContract ||
        this.idempotencyKey !== quote.idempotencyKey ||
        !this.businessId.equals(quote.businessId) ||
        !this.actorUserId.equals(quote.actorUserId) ||
        !this.bookingId.equals(quote.originBookingId)
      )
        this.invalidate(
          "packageCheckoutRetention",
          "Unaccepted checkout claim scope/authority mismatch",
        );
    }
  }
  if (!this.isNew && this.isModified("packageRequestBinding"))
    this.invalidate("packageRequestBinding", "Accepted request binding is immutable");
  if (this.packageRequestBinding) {
    const result = packageRequestBindingSchema.safeParse(this.toObject().packageRequestBinding);
    if (!result.success) {
      this.invalidate("packageRequestBinding", result.error.message);
      return;
    }
    const binding = result.data;
    if (
      binding.operation === "PURCHASE" &&
      binding.acceptedPurchaseSnapshot &&
      (!binding.acceptedPurchaseSnapshot.businessId.equals(this.businessId) ||
        !binding.acceptedPurchaseSnapshot.customerUserId.equals(this.actorUserId) ||
        !binding.acceptedPurchaseSnapshot.originBookingId.equals(this.bookingId))
    ) {
      this.invalidate("packageRequestBinding", "Accepted snapshot does not belong to this claim");
    }
  }
});
bookingCreationClaimSchema.pre(["replaceOne", "findOneAndReplace"], () => {
  throw new Error("Creation claim identity/retention is immutable");
});
bookingCreationClaimSchema.pre(["updateOne", "updateMany", "findOneAndUpdate"], function () {
  const update = this.getUpdate();
  const protectedRoots = [
    "packageCheckoutRetention",
    "idempotencyKey",
    "businessId",
    "actorUserId",
    "bookingId",
  ];
  const touchesIdentity = (fields: object) =>
    Object.keys(fields).some((key) =>
      protectedRoots.some((root) => key === root || key.startsWith(`${root}.`)),
    );
  if (
    update &&
    (Array.isArray(update) ||
      touchesIdentity(update) ||
      Object.entries(update).some(
        ([operator, fields]) =>
          operator.startsWith("$") &&
          fields &&
          typeof fields === "object" &&
          (touchesIdentity(fields) ||
            Object.values(fields).some(
              (target) =>
                typeof target === "string" &&
                protectedRoots.some((root) => target === root || target.startsWith(`${root}.`)),
            )),
      ))
  )
    throw new Error("Creation claim identity/retention is immutable");
  // An unaccepted retained checkout must never acquire money authority through a generic writer.
  const touchesFinancialContract = (fields: object) =>
    Object.keys(fields).some(
      (key) => key === "financialContract" || key.startsWith("financialContract."),
    ) ||
    Object.values(fields).some(
      (target) =>
        typeof target === "string" &&
        (target === "financialContract" || target.startsWith("financialContract.")),
    );
  if (
    update &&
    (touchesFinancialContract(update) ||
      Object.values(update).some(
        (fields) => fields && typeof fields === "object" && touchesFinancialContract(fields),
      ))
  )
    this.where({ packageCheckoutRetention: { $exists: false } });
  if (
    update &&
    (Array.isArray(update) ||
      Object.hasOwn(update, "packageRequestBinding") ||
      Object.values(update).some(
        (fields) =>
          (fields &&
            typeof fields === "object" &&
            Object.keys(fields).some(
              (key) => key === "packageRequestBinding" || key.startsWith("packageRequestBinding."),
            )) ||
          (fields &&
            typeof fields === "object" &&
            Object.values(fields).some(
              (target) =>
                typeof target === "string" &&
                (target === "packageRequestBinding" || target.startsWith("packageRequestBinding.")),
            )),
      ))
  ) {
    throw new Error("Accepted request binding is immutable");
  }
});

export const BookingCreationClaimModel = model<BookingCreationClaimDocument>(
  "BookingCreationClaim",
  bookingCreationClaimSchema,
);
