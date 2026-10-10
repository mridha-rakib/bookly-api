import { model, Schema, type Types } from "mongoose";

import type { BusinessCity } from "../business/business.types.js";
import { businessCities } from "../business/business.types.js";
import { genders } from "../user/user.types.js";
import {
  type ClientLinkState,
  type ClientPropertyType,
  type ClientTag,
  clientLinkStates,
  clientPropertyTypes,
  clientTags,
} from "./client.types.js";

export type BusinessClientAddress = {
  city: BusinessCity;
  propertyType: ClientPropertyType;
  area: string;
  streetName: string;
  streetNumber: string;
  floorUnit?: string | undefined;
  aptRoom?: string | undefined;
  additionalDirections?: string | undefined;
};

/**
 * P1 relationship state machine (one per customer+business — BusinessClient is unique per
 * `{businessId, linkedUserId}`):
 *
 *   ELIGIBLE --(atomic first claim, BEFORE any provider charge)--> FIRST_PENDING
 *   FIRST_PENDING --(booking + required upfront committed in ONE transaction)--> CONSUMED
 *   FIRST_PENDING --(proven pre-money failure of the SAME operation)--> ELIGIBLE
 *   FIRST_PENDING --(provider charge succeeded, booking persistence failed)--> RESTORATION_PENDING
 *   RESTORATION_PENDING --(exact full compensation refund durably confirmed)--> ELIGIBLE
 *
 * Every transition is a compare-and-set on `state` + the pending operation identity (and
 * `revision` for recovery), so a stale worker can never release a claim another operation now
 * owns, never turn CONSUMED back into ELIGIBLE, and never restore on the wrong refund. CONSUMED
 * is terminal in P1 (successful-booking cancellation/void restoration is P4).
 */
export const financialRelationshipStates = [
  "ELIGIBLE",
  "FIRST_PENDING",
  "CONSUMED",
  "RESTORATION_PENDING",
] as const;
export type FinancialRelationshipState = (typeof financialRelationshipStates)[number];

export type BusinessClientFinancialRelationship = {
  version: 2;
  state: FinancialRelationshipState;
  /** Monotonic CAS counter — incremented by every state transition. */
  revision: number;
  /** How a pre-P1 row was interpreted on lazy initialization (audit only). */
  initializedFrom: "LEGACY_ACTIVATED" | "LEGACY_UNACTIVATED";
  stateChangedAt: Date;
  /** Present exactly while FIRST_PENDING / RESTORATION_PENDING: the logical operation that
   * owns the first claim. `idempotencyKey`/`bookingId` are the BookingCreationClaim identity. */
  pending?:
    | {
        idempotencyKey: string;
        bookingId: Types.ObjectId;
        customerUserId: Types.ObjectId;
        productKind: "NORMAL_BOOKING" | "PACKAGE_PURCHASE";
        claimedAt: Date;
        /** Bounds ONLY the pre-dispatch window: once a PaymentAttempt is bound below, durable
         * money state (never time) decides every transition. An unbound claim whose lease
         * expired can be released because the owner must bind before any provider dispatch
         * (see FinancialRelationshipRepository.bindPaymentAttempt) — so it provably moved no
         * money and can no longer move any. */
        claimLeaseExpiresAt: Date;
        paymentAttemptId?: Types.ObjectId | undefined;
        restorationRequiredAt?: Date | undefined;
        restorationRefundOperationId?: Types.ObjectId | undefined;
        /** Recovery round-robin cursor only (never a state input): unresolvable claims rotate
         * to the back of the scan so they cannot starve newer ones. */
        lastReconciledAt?: Date | undefined;
      }
    | undefined;
  /** Set on FIRST_PENDING -> CONSUMED. Absent for a LEGACY_ACTIVATED row (see
   * `activatedByBookingId` for that history). */
  consumed?:
    | {
        idempotencyKey: string;
        bookingId: Types.ObjectId;
        productKind: "NORMAL_BOOKING" | "PACKAGE_PURCHASE";
        financialTransactionId?: Types.ObjectId | undefined;
        consumedAt: Date;
      }
    | undefined;
  /** Audit trail of the most recent return to ELIGIBLE. */
  lastRelease?:
    | {
        idempotencyKey: string;
        reason: "PRE_MONEY_FAILURE" | "PRE_DISPATCH_ABANDONED" | "COMPENSATION_REFUNDED";
        paymentAttemptId?: Types.ObjectId | undefined;
        refundOperationId?: Types.ObjectId | undefined;
        releasedAt: Date;
      }
    | undefined;
};

export type BusinessClientDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  createdByUserId: Types.ObjectId;

  // Locally captured contact/profile snapshot. Authoritative for an UNLINKED or
  // IDENTITY_CONFLICT Client; once LINKED, the service layer overlays live User/UserProfile
  // data for firstName/lastName/normalizedEmail/phone/gender in API responses instead — these
  // stored values are left untouched as a historical record and stay available if the Client
  // is later unlinked/relinked to a different identity.
  firstName: string;
  lastName?: string | undefined;
  normalizedEmail: string;
  phone: {
    countryCode: string;
    nationalNumber: string;
    e164: string;
  };
  // Not a global identity field (Bookly's registration flow never collects DOB), so this stays
  // Business-specific and editable even when LINKED.
  dateOfBirth?: string | undefined;
  gender?: "male" | "female" | "other" | undefined;

  // Business-specific metadata — always locally authoritative, editable regardless of link state.
  /** Required when a Business Owner manually creates a Client (enforced at the schema/body-
   * validation layer, not here). Batch 9 — optional at the MODEL level only so
   * BookingCreationService.resolveOrCreateCustomerClient can auto-create a Client for a
   * Customer's first AT_BUSINESS_LOCATION booking without a structured address to source it
   * from (no travel address exists for that fulfilment mode, and CustomerProfile.address is
   * free-text — see that method's own doc comment). Confirmed product decision: an at-location
   * Client's address may be filled in later by the Business if they choose to manage it. */
  address?: BusinessClientAddress | undefined;
  notes?: string | undefined;
  tag?: ClientTag | undefined;

  linkState: ClientLinkState;
  linkedUserId?: Types.ObjectId | undefined;

  /**
   * Batch 4 — canonical Business-Customer activation state (confirmed product rule: the
   * platform/activation fee applies only to "the FIRST ELIGIBLE BOOKLY BOOKING for that
   * customer with that business"; every later booking for the SAME Business+Customer pair is
   * "returning", regardless of how many other Businesses this same Customer has separately
   * activated at). Set exactly once, the moment the first BOOKLY_MANAGED Booking's activation
   * charge actually succeeds (never merely attempted) — see BookingCreationService's
   * finalizeCustomerBooking. `activatedByBookingId` is the audit trail: which Booking triggered
   * activation, so a later investigation never has to guess.
   *
   * Deliberately NOT derived from "does this Client have any past Booking" — a MANUAL Booking
   * (rule E, no Bookly payment) or a Booking that was created but never actually paid must never
   * count as activation; only a genuinely succeeded activation charge does. Archiving/soft-
   * deleting a Client never touches this field — activation history is permanent (confirmed:
   * "Historical booking deletion/soft deletion must not accidentally reset legitimate
   * activation history").
   */
  activatedAt?: Date | undefined;
  activatedByBookingId?: Types.ObjectId | undefined;

  /**
   * P1 — the ONE authoritative, versioned customer↔business financial relationship (see
   * BusinessClientFinancialRelationship). Once present it is the only source of first/returning
   * classification; `activatedAt` above is then a legacy/analytics marker only (still written on
   * first consumption for compatibility, never cleared on restoration, never read for money).
   * Absent on pre-P1 rows: lazily initialized from `activatedAt` on the first qualifying
   * operation (see FinancialRelationshipRepository.ensureInitialized).
   */
  financialRelationship?: BusinessClientFinancialRelationship | undefined;

  archivedAt?: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const addressSchema = new Schema<BusinessClientAddress>(
  {
    city: { type: String, enum: businessCities, required: true },
    propertyType: { type: String, enum: clientPropertyTypes, required: true },
    area: { type: String, required: true, trim: true },
    streetName: { type: String, required: true, trim: true },
    streetNumber: { type: String, required: true, trim: true },
    floorUnit: { type: String, trim: true },
    aptRoom: { type: String, trim: true },
    additionalDirections: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false },
);

const productKinds = ["NORMAL_BOOKING", "PACKAGE_PURCHASE"] as const;

const financialRelationshipSchema = new Schema<BusinessClientFinancialRelationship>(
  {
    version: { type: Number, enum: [2], required: true },
    state: { type: String, enum: financialRelationshipStates, required: true },
    revision: { type: Number, required: true, min: 0, validate: Number.isInteger },
    initializedFrom: {
      type: String,
      enum: ["LEGACY_ACTIVATED", "LEGACY_UNACTIVATED"],
      required: true,
    },
    stateChangedAt: { type: Date, required: true },
    pending: {
      type: new Schema(
        {
          idempotencyKey: { type: String, required: true, trim: true, maxlength: 200 },
          bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
          customerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
          productKind: { type: String, enum: productKinds, required: true },
          claimedAt: { type: Date, required: true },
          claimLeaseExpiresAt: { type: Date, required: true },
          paymentAttemptId: { type: Schema.Types.ObjectId, ref: "PaymentAttempt" },
          restorationRequiredAt: { type: Date },
          restorationRefundOperationId: { type: Schema.Types.ObjectId, ref: "RefundOperation" },
          lastReconciledAt: { type: Date },
        },
        { _id: false },
      ),
    },
    consumed: {
      type: new Schema(
        {
          idempotencyKey: { type: String, required: true, trim: true, maxlength: 200 },
          bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
          productKind: { type: String, enum: productKinds, required: true },
          financialTransactionId: {
            type: Schema.Types.ObjectId,
            ref: "BookingFinancialTransaction",
          },
          consumedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
    },
    lastRelease: {
      type: new Schema(
        {
          idempotencyKey: { type: String, required: true, trim: true, maxlength: 200 },
          reason: {
            type: String,
            enum: ["PRE_MONEY_FAILURE", "PRE_DISPATCH_ABANDONED", "COMPENSATION_REFUNDED"],
            required: true,
          },
          paymentAttemptId: { type: Schema.Types.ObjectId, ref: "PaymentAttempt" },
          refundOperationId: { type: Schema.Types.ObjectId, ref: "RefundOperation" },
          releasedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
    },
  },
  { _id: false },
);

const businessClientSchema = new Schema<BusinessClientDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    firstName: { type: String, required: true, trim: true, maxlength: 200 },
    lastName: { type: String, trim: true, maxlength: 200 },
    normalizedEmail: { type: String, required: true, lowercase: true, trim: true },
    phone: {
      countryCode: { type: String, required: true },
      nationalNumber: { type: String, required: true },
      e164: { type: String, required: true },
    },
    dateOfBirth: { type: String },
    gender: { type: String, enum: genders },

    address: { type: addressSchema },
    notes: { type: String, trim: true, maxlength: 2000 },
    tag: { type: String, enum: clientTags },

    linkState: { type: String, enum: clientLinkStates, required: true, default: "UNLINKED" },
    linkedUserId: { type: Schema.Types.ObjectId, ref: "User" },

    activatedAt: { type: Date },
    activatedByBookingId: { type: Schema.Types.ObjectId, ref: "Booking" },

    financialRelationship: { type: financialRelationshipSchema },

    archivedAt: { type: Date },
  },
  { timestamps: true },
);

// Same-business duplicate prevention (the DB-level concurrency backstop) — matching either
// signal is treated as "the same person" for creation-blocking purposes. Deliberately NOT
// partial/scoped to non-archived docs: an archived Client with the same contact info must be
// restored, never shadowed by a second, fragmented record for the same person.
businessClientSchema.index({ businessId: 1, normalizedEmail: 1 }, { unique: true });
businessClientSchema.index({ businessId: 1, "phone.e164": 1 }, { unique: true });
// One Client row per Business per linked Customer identity.
businessClientSchema.index(
  { businessId: 1, linkedUserId: 1 },
  { unique: true, partialFilterExpression: { linkedUserId: { $exists: true } } },
);
// Cross-business identity-matching scans (post customer-registration linking) — never scoped
// to one business, so these are separate from the compound indexes above.
businessClientSchema.index({ normalizedEmail: 1 });
businessClientSchema.index({ "phone.e164": 1 });
// Clients list / Archived Clients list — the one paginated list query in the whole API.
// Trailing createdAt matches listByBusinessId's actual sort (client.repository.ts
// `.sort({ createdAt: -1 })`) so the base (no tag/search) case never falls back to an
// in-memory sort; the businessId+archivedAt prefix still narrows the tag/search-filtered
// cases even though those two extra filters are not themselves part of this index.
businessClientSchema.index({ businessId: 1, archivedAt: 1, createdAt: -1 });
// Batch 12 — Super Admin Business Analytics "new customers per business": a period-bounded range
// scan on activatedAt, platform-wide (not scoped to one business ahead of the $group). Sparse
// since most Clients never activate.
businessClientSchema.index({ activatedAt: -1 }, { sparse: true });
// P1 — money-recovery scan for unresolved first claims (FIRST_PENDING / RESTORATION_PENDING).
// Partial: only rows with a pending first operation are indexed, which is a tiny, transient set.
// Atomic claim/consume transitions are single-document CAS writes by `_id` and need no index;
// one-relationship-per-pair reuses the existing `{businessId, linkedUserId}` unique index.
businessClientSchema.index(
  { "financialRelationship.pending.lastReconciledAt": 1 },
  {
    name: "financialRelationship_pending_recovery",
    partialFilterExpression: { "financialRelationship.pending.idempotencyKey": { $exists: true } },
  },
);

export const BusinessClientModel = model<BusinessClientDocument>(
  "BusinessClient",
  businessClientSchema,
);
