import { model, Schema, type Types } from "mongoose";

import { type BookingCurrency, bookingCurrencies } from "../booking/booking.types.js";

/**
 * Batch 7 (Finance/Payouts) — a real bank-transfer batch to a Business, e.g. one monthly SEPA
 * transfer. Deliberately a SEPARATE entity from BookingFinancialTransaction rather than reusing
 * its `BUSINESS_PAYOUT` type: that ledger type is scoped to one `bookingId` (required on the
 * schema), which cannot represent "one payout covering many bookings/transactions over a
 * period" without either faking a bookingId or loosening the ledger's own required field —
 * neither acceptable (see booking-financial-transaction.model.ts's own "never Mongoose
 * directly"/immutability doc comments). This collection is the period-level aggregate; the
 * ledger remains the line-item source of truth those totals are computed from.
 *
 * No write path exists yet in this phase — no real SEPA/Stripe Connect payout EXECUTION
 * infrastructure exists in this codebase (confirmed during Batch 7 investigation), so nothing
 * ever inserts a row here today. This is deliberately honest: FinanceService.listPayoutHistory
 * reads whatever rows genuinely exist (none, for every Business, until a real payout-execution
 * process is built) rather than fabricating "Paid" history from collected transactions. The
 * schema/repository exist now so that future payout-execution work has a stable, already-tested
 * target, matching this codebase's existing "storage shape before the write path" convention
 * (see BookingSchedule/BookingRescheduleEntry's own doc comments in booking.model.ts).
 */
export type BusinessPayoutStatus = "PENDING" | "PAID";
export const businessPayoutStatuses = ["PENDING", "PAID"] as const;

export type BusinessPayoutDocument = {
  _id: Types.ObjectId;
  businessId: Types.ObjectId;
  /** [periodStart, periodEnd) — the settlement window this payout covers. */
  periodStart: Date;
  periodEnd: Date;
  /** The Business-owned amount collected in this period, before processing-fee deduction. */
  grossBusinessOwnedCents: number;
  processingFeesCents: number;
  /** grossBusinessOwnedCents - processingFeesCents — the amount actually transferred. */
  netPayoutCents: number;
  currency: BookingCurrency;
  status: BusinessPayoutStatus;
  /** External transfer reference (e.g. a SEPA/Stripe Connect payout id) — unset until a real
   * payout provider is integrated. */
  providerReference?: string | undefined;
  paidAt?: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
};

const businessPayoutSchema = new Schema<BusinessPayoutDocument>(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    grossBusinessOwnedCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    processingFeesCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    netPayoutCents: { type: Number, required: true, min: 0, validate: Number.isInteger },
    currency: { type: String, enum: bookingCurrencies, required: true, default: "EUR" },
    status: { type: String, enum: businessPayoutStatuses, required: true, default: "PENDING" },
    providerReference: { type: String, trim: true },
    paidAt: { type: Date },
  },
  { timestamps: true },
);

// Payout history for a Business, most recent period first — the one read pattern this
// collection serves.
businessPayoutSchema.index({ businessId: 1, periodStart: -1 });

export const BusinessPayoutModel = model<BusinessPayoutDocument>(
  "BusinessPayout",
  businessPayoutSchema,
);
