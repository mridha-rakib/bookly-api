import { model, Schema, type Types } from "mongoose";

import type { FinancialContract } from "./financial-contract.js";
import { financialContractSchema } from "./financial-contract.model.js";
import {
  assertPackageAccepted,
  assertPackagePresentation,
  type PackageCheckoutAccepted,
  type PackageCheckoutPresentation,
} from "./package-checkout-acceptance.js";
import {
  type PackageCheckoutClaimGrant,
  readPackageCheckoutClaimGrant,
} from "./package-checkout-customer-authority.js";
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
  packageCheckoutPresentation?: PackageCheckoutPresentation | undefined;
  packageCheckoutAcceptance?: PackageCheckoutAccepted | undefined;
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
    packageCheckoutPresentation: { type: Schema.Types.Mixed },
    packageCheckoutAcceptance: { type: Schema.Types.Mixed },
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
const checkoutTransitions = new WeakSet<object>();
// Save guards also run when a caller disables Mongoose validation.
bookingCreationClaimSchema.pre("save", function () {
  if (
    (this.isNew && (this.packageCheckoutPresentation || this.packageCheckoutAcceptance)) ||
    (!this.isNew &&
      [
        "packageCheckoutRetention",
        "packageCheckoutPresentation",
        "packageCheckoutAcceptance",
        "idempotencyKey",
        "businessId",
        "actorUserId",
        "bookingId",
      ].some((key) => this.isModified(key))) ||
    (this.packageCheckoutRetention && (this.financialContract || this.packageRequestBinding))
  )
    throw new Error(
      "Checkout claim identity/evidence is immutable; use verified canonical transition",
    );
});
bookingCreationClaimSchema.pre("validate", function () {
  if (
    (this.isNew && (this.packageCheckoutPresentation || this.packageCheckoutAcceptance)) ||
    (!this.isNew &&
      ["packageCheckoutPresentation", "packageCheckoutAcceptance"].some((key) =>
        this.isModified(key),
      ))
  )
    this.invalidate("packageCheckoutAcceptance", "Use verified canonical checkout transition");
  if (this.packageCheckoutPresentation || this.packageCheckoutAcceptance) {
    try {
      assertPackagePresentation(this.packageCheckoutRetention, this.packageCheckoutPresentation);
      if (this.packageCheckoutAcceptance)
        assertPackageAccepted(
          this.packageCheckoutRetention,
          this.packageCheckoutPresentation,
          this.packageCheckoutAcceptance,
        );
    } catch (error) {
      this.invalidate("packageCheckoutAcceptance", String(error));
    }
  }
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
  if (checkoutTransitions.has(this)) return;
  const update = this.getUpdate();
  const protectedRoots = [
    "packageCheckoutPresentation",
    "packageCheckoutAcceptance",
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

bookingCreationClaimSchema.pre("bulkWrite", () => {
  throw new Error("Use canonical single-claim operations");
});
bookingCreationClaimSchema.pre("insertMany", () => {
  throw new Error("Use validated canonical claim creation");
});
bookingCreationClaimSchema.pre(["deleteOne", "deleteMany", "findOneAndDelete"], function () {
  this.and([
    {
      packageCheckoutPresentation: { $exists: false },
      packageCheckoutAcceptance: { $exists: false },
    },
  ]);
});
bookingCreationClaimSchema.pre("deleteOne", { document: true, query: false }, function () {
  if (this.packageCheckoutPresentation || this.packageCheckoutAcceptance)
    throw new Error("Checkout evidence is immutable");
});

export const BookingCreationClaimModel = model<BookingCreationClaimDocument>(
  "BookingCreationClaim",
  bookingCreationClaimSchema,
);

/** The only query capability for appending presentation/acceptance. No caller-supplied
 * mutation/options can bypass the hook. The grant is issued by verified Customer authority.
 * The original retention remains intact, so all existing financial exclusions still apply.
 */
export const commitPackageCheckoutClaimGrant = async (
  grant: PackageCheckoutClaimGrant,
): Promise<boolean> => {
  const authorized = readPackageCheckoutClaimGrant(grant);
  const { retention, presentation } = authorized;
  assertPackagePresentation(retention, presentation);
  if (authorized.kind === "ACCEPT")
    assertPackageAccepted(retention, presentation, authorized.accepted);
  const q = retention.quote.payload;
  const filter = {
    idempotencyKey: q.idempotencyKey,
    businessId: q.businessId,
    actorUserId: q.actorUserId,
    bookingId: q.originBookingId,
    "packageCheckoutRetention.quote.termsHash": retention.quote.termsHash,
    financialContract: { $exists: false },
    packageRequestBinding: { $exists: false },
    packageCheckoutAcceptance: { $exists: false },
    ...(authorized.kind === "PRESENT"
      ? { packageCheckoutPresentation: { $exists: false } }
      : {
          "packageCheckoutPresentation.presentationId": presentation.presentationId,
          "packageCheckoutPresentation.challenge": presentation.challenge,
          "packageCheckoutPresentation.sessionFamilyId": presentation.sessionFamilyId,
          "packageCheckoutPresentation.disclosure.contentHash": presentation.disclosure.contentHash,
        }),
  };
  const query = BookingCreationClaimModel.updateOne(
    filter,
    {
      $set:
        authorized.kind === "PRESENT"
          ? { packageCheckoutPresentation: presentation }
          : { packageCheckoutAcceptance: authorized.accepted },
    },
    { runValidators: true },
  );
  checkoutTransitions.add(query);
  return (await query).matchedCount === 1;
};
