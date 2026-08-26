import { model, Schema, type Types } from "mongoose";

import { type BookingCurrency, bookingCurrencies } from "../booking/booking.types.js";
import {
  type BookingFinancialTransactionDirection,
  type BookingFinancialTransactionStatus,
  type BookingFinancialTransactionType,
  bookingFinancialTransactionDirections,
  bookingFinancialTransactionStatuses,
  bookingFinancialTransactionTypes,
} from "./booking-financial-transaction.types.js";

/**
 * The immutable financial ledger for a Booking — every DEPOSIT/PAYMENT/PLATFORM_FEE/
 * CANCELLATION_FEE/NO_SHOW_FEE/REFUND/BUSINESS_PAYOUT/ADJUSTMENT event as its own append-only
 * row. Booking.financials is unaffected by this module and remains the fast current-state
 * summary a UI reads directly; this collection is the auditable source of how that summary
 * was reached, and the source future payout aggregation reads from.
 *
 * No route/controller exists for this module in this phase, deliberately — nothing calls
 * `record()` yet (no payment provider, no cancellation/no-show charging, no payouts), and
 * this collection must never accept a client-authoritative amount. Only later, internal,
 * server-side modules are expected to construct entries here, exactly like
 * BookingService/BookingRepository are exercised directly by tests today rather than through
 * a public creation endpoint (see booking.service.ts's equivalent phase-boundary note).
 */
export type BookingFinancialTransactionDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  bookingId: Types.ObjectId;
  /** Always present — mirrors Booking.customer.businessClientId, which every Booking has
   * regardless of whether the client is linked to a real Customer account. */
  businessClientId: Types.ObjectId;
  /** Denormalized snapshot of Booking.customer.customerUserId — only set when the
   * BusinessClient is linked to a real Customer account, same optionality as on Booking. */
  customerUserId?: Types.ObjectId | undefined;
  type: BookingFinancialTransactionType;
  direction: BookingFinancialTransactionDirection;
  /** Integer cents, always positive — the sign/meaning of the movement is carried by
   * `direction` and `type`, never by a negative amount. */
  amountCents: number;
  currency: BookingCurrency;
  status: BookingFinancialTransactionStatus;
  /** External payment-provider transaction/charge id (e.g. a Stripe PaymentIntent id) — unset
   * until a provider is integrated. */
  providerReference?: string | undefined;
  /** Set by the caller when the underlying operation must be safe to retry (e.g. a no-show
   * auto-charge worker) — enforced unique below whenever present. Absent for entries that are
   * inherently one-shot and never retried (e.g. a manually-recorded ADJUSTMENT). */
  idempotencyKey?: string | undefined;
  /** Free-form contextual reference — primitives only, deliberately not an arbitrary nested/
   * Mixed bag. Batch 8 convention (see BookingFinancialTransactionService's own doc comment):
   * `sourceType` and `sourceTransactionId` are written on PROCESSING_FEE and REFUND entries to
   * record which underlying payment/transaction they belong to — the sole mechanism this ledger
   * uses to answer "who bears this cost/reversal," since ownership cannot be inferred from
   * `type` alone for these two types the way it can for DEPOSIT/PLATFORM_FEE/CANCELLATION_FEE/
   * NO_SHOW_FEE. */
  metadata?: Record<string, string | number | boolean> | undefined;
  /**
   * Batch 8 — the SECOND, narrower allowed post-creation mutation (alongside `status`; see
   * updateStatus/settleFailedAsWaived's own comments and the model's collection-level doc
   * comment on immutability). Set EXACTLY ONCE, only by BusinessPayoutService's payout-execution
   * transaction, marking "this entry's value was included in payout X, and must never be
   * included in a second one." Never set at creation time. A row with `payoutId` unset is
   * "still pending payable"; a row with it set is "already settled" — this is the sole
   * mechanism preventing a Business-owned transaction from being paid out twice (see rule #13),
   * deliberately NOT inferred from dates or from a payout's own settledTransactionIds array
   * alone (both directions are recorded — see BusinessPayout.settledTransactionIds — purely for
   * cheap bidirectional auditability, never as the sole source of truth on either side).
   */
  payoutId?: Types.ObjectId | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const metadataValidator = (value: unknown): boolean => {
  if (value === undefined) {
    return true;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value as Record<string, unknown>).every(
    (entry) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
  );
};

const bookingFinancialTransactionSchema = new Schema<BookingFinancialTransactionDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    businessClientId: { type: Schema.Types.ObjectId, ref: "BusinessClient", required: true },
    customerUserId: { type: Schema.Types.ObjectId, ref: "User" },
    type: { type: String, enum: bookingFinancialTransactionTypes, required: true },
    direction: { type: String, enum: bookingFinancialTransactionDirections, required: true },
    amountCents: { type: Number, required: true, min: 1, validate: Number.isInteger },
    currency: { type: String, enum: bookingCurrencies, required: true, default: "EUR" },
    status: {
      type: String,
      enum: bookingFinancialTransactionStatuses,
      required: true,
      default: "PENDING",
    },
    providerReference: { type: String, trim: true },
    idempotencyKey: { type: String, trim: true },
    metadata: {
      type: Schema.Types.Mixed,
      validate: {
        validator: metadataValidator,
        message: "metadata must be a flat object of primitives",
      },
    },
    payoutId: { type: Schema.Types.ObjectId, ref: "BusinessPayout" },
  },
  { timestamps: true },
);

// A Booking's full financial history in order — the primary read pattern (a ledger view on a
// Booking detail screen, and the input to reconciling Booking.financials).
bookingFinancialTransactionSchema.index({ bookingId: 1, createdAt: 1 });
// Payout aggregation: a Business's entries of a given type within a date range (e.g. summing
// BUSINESS_PAYOUT, or every fee type, for a settlement period).
bookingFinancialTransactionSchema.index({ businessId: 1, type: 1, createdAt: 1 });
// Whenever an idempotencyKey is supplied, it must be unique — the mechanism a future retryable
// charge (e.g. the no-show auto-charge worker) relies on to be safe under retry/redelivery.
// Partial so the far more common entries with no idempotencyKey never collide with each other.
bookingFinancialTransactionSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $exists: true } } },
);
// Batch 8 — the pending-Business-payable read path: "this Business's SUCCEEDED entries of a
// given type not yet swept into a payout" (businessId+type equality, status/payoutId filtered
// from the same compound key so the scan never touches already-settled or non-SUCCEEDED rows).
// Used by both BusinessPayoutService's own claim query and BusinessFinanceService's read-only
// "what do I currently owe this Business" computation — see those services' own comments.
bookingFinancialTransactionSchema.index({ businessId: 1, type: 1, status: 1, payoutId: 1 });
// Batch 8 — Super Admin's platform-wide (cross-business) period aggregation: no businessId in
// this query at all, so the businessId-prefixed index above cannot serve it — this is the
// dedicated index for that shape (type+status equality, createdAt range).
bookingFinancialTransactionSchema.index({ type: 1, status: 1, createdAt: 1 });
// Dashboard Overview's "Recent activity" feed: a Business's own most-recent ledger entries of
// ANY type, newest first — the existing `{businessId, type, createdAt}` index cannot serve this
// (it leads with `type`, which this query never filters on). See
// BookingFinancialTransactionRepository.listRecentForBusiness.
bookingFinancialTransactionSchema.index({ businessId: 1, createdAt: -1 });

export const BookingFinancialTransactionModel = model<BookingFinancialTransactionDocument>(
  "BookingFinancialTransaction",
  bookingFinancialTransactionSchema,
);
