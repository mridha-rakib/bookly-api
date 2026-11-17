import { createHash } from "node:crypto";
import type { Types } from "mongoose";
import { BookingModel } from "../booking/booking.model.js";
import { type BookingStatus, bookingCurrencies } from "../booking/booking.types.js";
import { BookingFinancialTransactionModel } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import type { OwnershipAggregateBucket } from "../booking-financial-transaction/booking-financial-transaction.repository.js";
import { BusinessPayoutModel } from "../finance/business-payout.model.js";
import {
  ALL_OWNERSHIP_RELEVANT_TYPES,
  combineBooklyOwnedBuckets,
  combineBusinessOwnedBuckets,
} from "../finance/finance-ownership.js";
import { PackageProgressModel } from "../package-progress/package-progress.model.js";
import {
  RefundOperationModel,
  type RefundOperationStatus,
} from "../payment/refund-operation.model.js";
import { PaymentDisputeModel } from "../provider-reversal/payment-dispute.model.js";
import type {
  CentralBalance,
  CentralStripeMode,
  ProviderPayoutStatus,
} from "./central-payout.types.js";
import { CentralPayoutOperationModel } from "./central-payout-operation.model.js";
import type { ReconciliationReadiness } from "./payout-reconciliation.js";
import { StripePayoutObservationModel } from "./stripe-payout-observation.model.js";

/**
 * Central withdrawal eligibility — policy CW-1 (Owner-confirmed rules, see
 * docs/CENTRAL-WITHDRAWAL-ELIGIBILITY.md).
 *
 * Ownership (finance-ownership.ts, unchanged): Bookly earns only PLATFORM_FEE (net of its own
 * processing fees, refunds, disputes and promo subsidies); DEPOSIT / CANCELLATION_FEE /
 * NO_SHOW_FEE / PROMO_SUBSIDY are Business-owned. Business-owned money may be moved to the
 * company bank (the approved manual-settlement workflow); it never becomes Bookly revenue and the
 * Business liability stays recorded until a BusinessPayout is recorded. A withdrawal therefore
 * never changes either owner's figures: it moves cash location only.
 *
 * What must STAY in Stripe is what Stripe itself will pay out of the balance: customer refunds
 * that can still arise under the booking/package rules, refunds already in progress, and disputes
 * not yet debited. Eligibility per currency:
 *
 *   ledgerHeld = Stripe-charged ledger inflows − ledger outflows (refunds, Stripe fees, dispute
 *                debits) − every Stripe payout out of this account (complete payout history)
 *   eligible   = min(Stripe available, ledgerHeld) − protected
 *
 * `ledgerHeld` keeps unattributed provider cash out of eligibility; `Stripe available` keeps
 * eligibility within real cash. Anything unknown, stale or contradictory makes the currency
 * UNAVAILABLE (amount 0) instead of an estimate. No percentage, buffer or time window is used.
 */
export const ELIGIBILITY_POLICY_VERSION = "CW-1";

/** Stripe-charged principal (counted only with a Stripe PaymentIntent/charge reference). */
const STRIPE_INFLOW_TYPES = [
  "PLATFORM_FEE",
  "DEPOSIT",
  "CANCELLATION_FEE",
  "NO_SHOW_FEE",
  "TAX_LIABILITY",
] as const;
/** Provider-confirmed money returned to the balance (dispute reinstatements). */
const PROVIDER_RETURN_TYPES = ["DISPUTE_REINSTATEMENT", "DISPUTE_FEE_REVERSAL"] as const;
/** Money that left the balance. Counted whatever its reference (conservative). */
const OUTFLOW_TYPES = [
  "REFUND",
  "TAX_REVERSAL",
  "PROCESSING_FEE",
  "DISPUTE_WITHDRAWAL",
  "DISPUTE_FEE",
] as const;
const STRIPE_CHARGE_REFERENCE = /^(pi|ch|py)_/;

/** Readiness blockers that make provider payout evidence untrustworthy for eligibility. External
 * (unverified) and in-flight payouts are NOT blockers: they are counted as cash already out. */
const BLOCKING_EVIDENCE_CODES = new Set([
  "STRIPE_NOT_CONFIGURED",
  "PROVIDER_ACCOUNT_UNVERIFIED",
  "PROVIDER_ACCOUNT_CHANGED",
  "HISTORY_NEVER_SYNCED",
  "HISTORY_INCOMPLETE",
  "HISTORY_SYNC_FAILED",
  "STATUS_VERIFICATION_STALE",
  "PAYOUTS_NOT_RECONFIRMED",
  "PROVIDER_STATUS_CONFLICT",
  "OBSERVATIONS_STALE",
  "UNRESOLVED_LINKAGE_PRESENT",
  "WITHDRAWALS_AWAITING_CONFIRMATION",
]);

/** Booking states in which the customer's upfront payment can still be refunded under the
 * booking rules (customer/Business cancellation, no-show reversal). */
const REFUNDABLE_BOOKING_STATES: BookingStatus[] = ["UPCOMING", "PENDING"];
const CANCELLED_STATES: BookingStatus[] = [
  "CANCELLED_BY_CUSTOMER",
  "CANCELLED_BY_BUSINESS",
  "LATE_CANCELLATION",
  "NO_SHOW_CANCELLED",
];
const UNRESOLVED_REFUND_STATES: RefundOperationStatus[] = [
  "CREATED",
  "PROVIDER_PENDING",
  "RECONCILIATION_REQUIRED",
];
const ENDED_PAYOUT_STATUSES: ProviderPayoutStatus[] = ["failed", "canceled"];

export type EligibilityBlocker = { code: string; message: string };

export type CurrencyEligibility = {
  currency: string;
  status: "AVAILABLE" | "UNAVAILABLE";
  /** The most that may be withdrawn now (0 when UNAVAILABLE). */
  eligibleCents: number;
  stripeAvailableCents: number;
  /** Cash the ledger attributes to this Stripe account (null when not computable). */
  ledgerHeldCents: number | null;
  /** Must remain in Stripe for refunds/disputes Stripe will pay out of the balance. */
  protected: {
    refundsInProgressCents: number;
    refundableBookingsCents: number;
    refundablePackagesCents: number;
    disputesCents: number;
    totalCents: number;
  };
  /** Informational ledger breakdown (lifetime, recorded). Never changed by a withdrawal. */
  ledger: {
    stripeChargedCents: number;
    stripeOutflowsCents: number;
    stripePayoutsOutCents: number;
    booklyNetRevenueCents: number;
    businessOwnedNetCents: number;
    businessSettledCents: number;
    businessOutstandingCents: number | null;
    taxLiabilityCents: number;
  };
  blockers: EligibilityBlocker[];
  /** Binds a confirmation to exactly this evaluation; any changed input changes it. */
  digest: string;
};

export type WithdrawalEligibility = {
  policyVersion: string;
  mode: CentralStripeMode | null;
  evaluatedAt: Date;
  currencies: CurrencyEligibility[];
  /** Blockers that apply to every currency. */
  blockers: EligibilityBlocker[];
};

type Sums = Map<string, number>;
const add = (map: Sums, currency: string, cents: number) =>
  map.set(currency, (map.get(currency) ?? 0) + cents);
const lc = (currency: string | undefined) => (currency ?? "").toLowerCase();

type LedgerCashRow = {
  _id: { currency: string; type: string; sourceType: string | null; stripe: boolean };
  totalCents: number;
};

async function readLedger() {
  const rows = await BookingFinancialTransactionModel.aggregate<LedgerCashRow>([
    {
      $match: {
        status: "SUCCEEDED",
        type: {
          $in: [
            ...new Set([
              ...STRIPE_INFLOW_TYPES,
              ...PROVIDER_RETURN_TYPES,
              ...OUTFLOW_TYPES,
              ...ALL_OWNERSHIP_RELEVANT_TYPES,
            ]),
          ],
        },
      },
    },
    {
      $group: {
        _id: {
          currency: "$currency",
          type: "$type",
          sourceType: { $ifNull: ["$metadata.sourceType", null] },
          stripe: {
            $regexMatch: {
              input: { $ifNull: ["$providerReference", ""] },
              regex: STRIPE_CHARGE_REFERENCE.source,
            },
          },
        },
        totalCents: { $sum: "$amountCents" },
      },
    },
  ]).exec();
  const charged: Sums = new Map();
  const outflows: Sums = new Map();
  const tax: Sums = new Map();
  const buckets = new Map<string, OwnershipAggregateBucket[]>();
  for (const row of rows) {
    const currency = lc(row._id.currency);
    const { type } = row._id;
    if ((STRIPE_INFLOW_TYPES as readonly string[]).includes(type) && row._id.stripe)
      add(charged, currency, row.totalCents);
    if ((PROVIDER_RETURN_TYPES as readonly string[]).includes(type))
      add(charged, currency, row.totalCents);
    if ((OUTFLOW_TYPES as readonly string[]).includes(type))
      add(outflows, currency, row.totalCents);
    if (type === "TAX_LIABILITY") add(tax, currency, row.totalCents);
    if (type === "TAX_REVERSAL") add(tax, currency, -row.totalCents);
    if ((ALL_OWNERSHIP_RELEVANT_TYPES as readonly string[]).includes(type)) {
      const list = buckets.get(currency) ?? [];
      list.push({
        type: type as OwnershipAggregateBucket["type"],
        sourceType: row._id.sourceType,
        totalCents: row.totalCents,
        count: 0,
      } as OwnershipAggregateBucket);
      buckets.set(currency, list);
    }
  }
  const pendingFees = await BookingFinancialTransactionModel.aggregate<{
    _id: string;
    count: number;
  }>([
    { $match: { type: "PROCESSING_FEE", status: "PENDING" } },
    { $group: { _id: "$currency", count: { $sum: 1 } } },
  ]).exec();
  return {
    charged,
    outflows,
    tax,
    buckets,
    pendingFees: new Map(pendingFees.map((r) => [lc(r._id), r.count])),
  };
}

/** Every Stripe payout out of this account+mode that has not failed/been canceled: observed
 * payouts (any origin) plus Bookly operations Stripe accepted but not yet observed (each once). */
async function readPayoutsOut(
  accountId: string,
  mode: CentralStripeMode,
  excludeOperationId?: Types.ObjectId,
): Promise<Sums> {
  const out: Sums = new Map();
  const observed = await StripePayoutObservationModel.find(
    { accountId, mode, status: { $nin: ENDED_PAYOUT_STATUSES } },
    { providerPayoutId: 1, currency: 1, amountCents: 1 },
  )
    .lean<{ providerPayoutId: string; currency: string; amountCents: number }[]>()
    .exec();
  const seen = new Set(observed.map((o) => o.providerPayoutId));
  for (const o of observed) add(out, lc(o.currency), o.amountCents);
  const endedObserved = new Set(
    (
      await StripePayoutObservationModel.find(
        { accountId, mode, status: { $in: ENDED_PAYOUT_STATUSES } },
        { providerPayoutId: 1 },
      )
        .lean<{ providerPayoutId: string }[]>()
        .exec()
    ).map((o) => o.providerPayoutId),
  );
  const ops = await CentralPayoutOperationModel.find(
    {
      mode,
      state: "SUBMITTED",
      providerStatus: { $nin: ENDED_PAYOUT_STATUSES },
      ...(excludeOperationId ? { _id: { $ne: excludeOperationId } } : {}),
    },
    { providerPayoutId: 1, currency: 1, amountCents: 1 },
  )
    .lean<{ providerPayoutId?: string; currency: string; amountCents: number }[]>()
    .exec();
  for (const op of ops)
    if (
      !op.providerPayoutId ||
      (!seen.has(op.providerPayoutId) && !endedObserved.has(op.providerPayoutId))
    )
      add(out, lc(op.currency), op.amountCents);
  return out;
}

const chunk = <T>(items: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
};

/** Net Stripe-charged upfront per booking (principal + tax − refunds), never below 0. */
async function netUpfrontByBooking(
  bookingIds: Types.ObjectId[],
): Promise<Map<string, { currency: string; cents: number }>> {
  const net = new Map<string, { currency: string; cents: number }>();
  for (const ids of chunk(bookingIds, 1000)) {
    const rows = await BookingFinancialTransactionModel.aggregate<{
      _id: { bookingId: Types.ObjectId; currency: string };
      charged: number;
      refunded: number;
    }>([
      {
        $match: {
          bookingId: { $in: ids },
          status: "SUCCEEDED",
          type: { $in: ["PLATFORM_FEE", "DEPOSIT", "TAX_LIABILITY", "REFUND", "TAX_REVERSAL"] },
        },
      },
      {
        $group: {
          _id: { bookingId: "$bookingId", currency: "$currency" },
          charged: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $in: ["$type", ["PLATFORM_FEE", "DEPOSIT", "TAX_LIABILITY"]] },
                    {
                      $regexMatch: {
                        input: { $ifNull: ["$providerReference", ""] },
                        regex: STRIPE_CHARGE_REFERENCE.source,
                      },
                    },
                  ],
                },
                "$amountCents",
                0,
              ],
            },
          },
          refunded: {
            $sum: { $cond: [{ $in: ["$type", ["REFUND", "TAX_REVERSAL"]] }, "$amountCents", 0] },
          },
        },
      },
    ]).exec();
    for (const row of rows)
      net.set(String(row._id.bookingId), {
        currency: lc(row._id.currency),
        cents: Math.max(0, row.charged - row.refunded),
      });
  }
  return net;
}

async function readProtected() {
  const refundsInProgress: Sums = new Map();
  const refundableBookings: Sums = new Map();
  const refundablePackages: Sums = new Map();
  const disputes: Sums = new Map();

  // 1. Refunds already started but not confirmed: Stripe may still pay them from the balance.
  const refundOps = await RefundOperationModel.find(
    { providerStatus: { $in: UNRESOLVED_REFUND_STATES } },
    { _id: 1, bookingId: 1, currency: 1, expectedRefundAmountCents: 1 },
  )
    .lean<
      {
        _id: Types.ObjectId;
        bookingId?: Types.ObjectId;
        currency: string;
        expectedRefundAmountCents: number;
      }[]
    >()
    .exec();
  const coveredBookings = new Set<string>();
  const coveredRefundOps = new Set<string>();
  for (const op of refundOps) {
    add(refundsInProgress, lc(op.currency), op.expectedRefundAmountCents);
    if (op.bookingId) coveredBookings.add(String(op.bookingId));
    coveredRefundOps.add(String(op._id));
  }

  // 2. Bookings whose upfront payment can still be refunded under the booking rules: the full
  //    remaining net upfront (the contractual maximum), and refunds owed by a cancellation.
  const open = await BookingModel.find({ status: { $in: REFUNDABLE_BOOKING_STATES } }, { _id: 1 })
    .lean<{ _id: Types.ObjectId }[]>()
    .exec();
  const owed = await BookingModel.find(
    {
      status: { $in: CANCELLED_STATES },
      "cancellationOutcome.refundOwedCents": { $gt: 0 },
      "cancellationOutcome.settlementStatus": { $in: ["PENDING", "FAILED"] },
    },
    { _id: 1, "cancellationOutcome.refundOwedCents": 1 },
  )
    .lean<{ _id: Types.ObjectId; cancellationOutcome?: { refundOwedCents?: number } }[]>()
    .exec();
  // 3. Active packages: unused sessions can be refunded; the charge sits on the origin booking.
  const activePackages = await PackageProgressModel.find(
    { voidedAt: { $exists: false }, remainingSessions: { $gt: 0 } },
    { originBookingId: 1 },
  )
    .lean<{ originBookingId: Types.ObjectId }[]>()
    .exec();
  const voidRefunds = await PackageProgressModel.find(
    { "voidRefundSettlement.status": { $in: ["PENDING", "FAILED"] } },
    { originBookingId: 1, voidRefundSettlement: 1 },
  )
    .lean<
      {
        originBookingId: Types.ObjectId;
        voidRefundSettlement?: { amountCents: number; refundOperationId?: Types.ObjectId };
      }[]
    >()
    .exec();

  const packageOrigins = new Set(activePackages.map((p) => String(p.originBookingId)));
  const bookingIds = new Map<string, Types.ObjectId>();
  for (const b of [...open, ...owed]) bookingIds.set(String(b._id), b._id);
  for (const p of activePackages) bookingIds.set(String(p.originBookingId), p.originBookingId);
  for (const p of voidRefunds) bookingIds.set(String(p.originBookingId), p.originBookingId);
  const net = await netUpfrontByBooking([...bookingIds.values()]);

  const counted = new Set<string>();
  for (const b of open) {
    const id = String(b._id);
    const n = net.get(id);
    if (!n || coveredBookings.has(id) || counted.has(id)) continue;
    counted.add(id);
    add(packageOrigins.has(id) ? refundablePackages : refundableBookings, n.currency, n.cents);
  }
  for (const b of owed) {
    const id = String(b._id);
    const n = net.get(id);
    if (!n || coveredBookings.has(id) || counted.has(id)) continue;
    counted.add(id);
    add(
      refundableBookings,
      n.currency,
      Math.min(n.cents, b.cancellationOutcome?.refundOwedCents ?? 0),
    );
  }
  for (const p of activePackages) {
    const id = String(p.originBookingId);
    const n = net.get(id);
    if (!n || coveredBookings.has(id) || counted.has(id)) continue;
    counted.add(id);
    add(refundablePackages, n.currency, n.cents);
  }
  for (const p of voidRefunds) {
    const id = String(p.originBookingId);
    const n = net.get(id);
    const opId = p.voidRefundSettlement?.refundOperationId;
    if (
      !n ||
      counted.has(id) ||
      coveredBookings.has(id) ||
      (opId && coveredRefundOps.has(String(opId)))
    )
      continue;
    counted.add(id);
    add(
      refundablePackages,
      n.currency,
      Math.min(n.cents, p.voidRefundSettlement?.amountCents ?? 0),
    );
  }

  // 4. Disputes Stripe has not debited yet, or whose debit is not ledgered (uncorrelated).
  const disputeRows = await PaymentDisputeModel.find(
    { $or: [{ final: false }, { correlation: { $ne: "CORRELATED" } }] },
    { amountCents: 1, currency: 1, final: 1, outcome: 1, correlation: 1, fundsWithdrawnAt: 1 },
  )
    .lean<
      {
        amountCents: number;
        currency: string;
        final: boolean;
        outcome?: string;
        correlation: string;
        fundsWithdrawnAt?: Date;
      }[]
    >()
    .exec();
  for (const d of disputeRows) {
    const returned = d.final && d.outcome !== "LOST";
    if (returned) continue;
    if (d.correlation !== "CORRELATED" || (!d.final && !d.fundsWithdrawnAt))
      add(disputes, lc(d.currency), d.amountCents);
  }
  return { refundsInProgress, refundableBookings, refundablePackages, disputes };
}

async function businessSettledByCurrency(): Promise<Sums> {
  const rows = await BusinessPayoutModel.aggregate<{ _id: string; total: number }>([
    { $match: { status: "PAID" } },
    { $group: { _id: "$currency", total: { $sum: "$netPayoutCents" } } },
  ]).exec();
  return new Map(rows.map((r) => [lc(r._id), r.total]));
}

export type EligibilityInput = {
  mode: CentralStripeMode | null;
  accountId: string | undefined;
  balance: CentralBalance;
  readiness: ReconciliationReadiness;
  businessOutstanding: { currency: string; amountCents: number } | null;
  /** Pre-dispatch revalidation: the operation being dispatched is not "another" withdrawal. */
  excludeOperationId?: Types.ObjectId;
  now?: Date;
};

export async function evaluateWithdrawalEligibility(
  input: EligibilityInput,
): Promise<WithdrawalEligibility> {
  const evaluatedAt = input.now ?? new Date();
  const global: EligibilityBlocker[] = [];
  if (!input.mode)
    global.push({
      code: "STRIPE_NOT_CONFIGURED",
      message: "Stripe is not configured; no withdrawal amount can be established.",
    });
  if (input.mode && input.balance.livemode !== (input.mode === "LIVE"))
    global.push({
      code: "PROVIDER_MODE_MISMATCH",
      message: "Stripe returned a balance for a different mode than the configured key.",
    });
  if (!input.accountId)
    global.push({
      code: "PROVIDER_ACCOUNT_UNIDENTIFIED",
      message: "The Stripe account could not be identified, so payout history cannot be matched.",
    });
  for (const b of input.readiness.blockers)
    if (
      BLOCKING_EVIDENCE_CODES.has(b.code) &&
      // Counted below with the operation under pre-dispatch revalidation excluded.
      b.code !== "WITHDRAWALS_AWAITING_CONFIRMATION" &&
      !global.some((g) => g.code === b.code)
    )
      global.push({ code: b.code, message: b.message });
  const unresolvedOps = await CentralPayoutOperationModel.countDocuments({
    state: { $in: ["PREPARED", "UNKNOWN"] },
    ...(input.excludeOperationId ? { _id: { $ne: input.excludeOperationId } } : {}),
  }).exec();
  if (unresolvedOps > 0 && !global.some((g) => g.code === "WITHDRAWALS_AWAITING_CONFIRMATION"))
    global.push({
      code: "WITHDRAWALS_AWAITING_CONFIRMATION",
      message: "A previous withdrawal is still awaiting Stripe confirmation. Refresh it first.",
    });

  const [ledger, protectedSums, settled, payoutsOut] = await Promise.all([
    readLedger(),
    readProtected(),
    businessSettledByCurrency(),
    input.mode && input.accountId
      ? readPayoutsOut(input.accountId, input.mode, input.excludeOperationId)
      : Promise.resolve(new Map<string, number>() as Sums),
  ]);

  const supported = new Set<string>(bookingCurrencies.map((c) => c.toLowerCase()));
  const currencies = [
    ...new Set([...input.balance.available.map((b) => lc(b.currency)), ...supported]),
  ].sort();

  const result: CurrencyEligibility[] = currencies.map((currency) => {
    const blockers: EligibilityBlocker[] = [...global];
    const stripeAvailableCents =
      input.balance.available.find((b) => lc(b.currency) === currency)?.amountCents ?? 0;
    const stripeChargedCents = ledger.charged.get(currency) ?? 0;
    const stripeOutflowsCents = ledger.outflows.get(currency) ?? 0;
    const stripePayoutsOutCents = payoutsOut.get(currency) ?? 0;
    const buckets = ledger.buckets.get(currency) ?? [];
    const prot = {
      refundsInProgressCents: protectedSums.refundsInProgress.get(currency) ?? 0,
      refundableBookingsCents: protectedSums.refundableBookings.get(currency) ?? 0,
      refundablePackagesCents: protectedSums.refundablePackages.get(currency) ?? 0,
      disputesCents: protectedSums.disputes.get(currency) ?? 0,
      totalCents: 0,
    };
    prot.totalCents =
      prot.refundsInProgressCents +
      prot.refundableBookingsCents +
      prot.refundablePackagesCents +
      prot.disputesCents;

    if (!supported.has(currency))
      blockers.push({
        code: "CURRENCY_NOT_IN_LEDGER",
        message: `Bookly records no ${currency.toUpperCase()} bookings, so no ${currency.toUpperCase()} funds can be attributed.`,
      });
    const pendingFees = ledger.pendingFees.get(currency) ?? 0;
    if (pendingFees > 0)
      blockers.push({
        code: "PROCESSING_FEES_UNRESOLVED",
        message: `${pendingFees} Stripe processing fee(s) are not yet confirmed, so the cash held cannot be established.`,
      });
    const ledgerHeldCents = stripeChargedCents - stripeOutflowsCents - stripePayoutsOutCents;
    if (supported.has(currency) && ledgerHeldCents < 0)
      blockers.push({
        code: "LEDGER_PROVIDER_MISMATCH",
        message:
          "Stripe payouts exceed the funds Bookly's ledger attributes to this account. Reconcile before withdrawing.",
      });

    const unavailable = blockers.length > 0;
    const eligibleCents = unavailable
      ? 0
      : Math.max(0, Math.min(stripeAvailableCents, ledgerHeldCents) - prot.totalCents);
    const outstanding =
      input.businessOutstanding && lc(input.businessOutstanding.currency) === currency
        ? input.businessOutstanding.amountCents
        : null;
    const ledgerView = {
      stripeChargedCents,
      stripeOutflowsCents,
      stripePayoutsOutCents,
      booklyNetRevenueCents: combineBooklyOwnedBuckets(buckets).netCents,
      businessOwnedNetCents: combineBusinessOwnedBuckets(buckets).netCents,
      businessSettledCents: settled.get(currency) ?? 0,
      businessOutstandingCents: outstanding,
      taxLiabilityCents: ledger.tax.get(currency) ?? 0,
    };
    const status = unavailable ? ("UNAVAILABLE" as const) : ("AVAILABLE" as const);
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          policy: ELIGIBILITY_POLICY_VERSION,
          mode: input.mode,
          accountId: input.accountId ?? null,
          currency,
          status,
          eligibleCents,
          stripeAvailableCents,
          ledgerHeldCents,
          protected: prot,
          payoutsOut: stripePayoutsOutCents,
          blockers: blockers.map((b) => b.code),
        }),
      )
      .digest("hex");
    return {
      currency,
      status,
      eligibleCents,
      stripeAvailableCents,
      ledgerHeldCents: supported.has(currency) ? ledgerHeldCents : null,
      protected: prot,
      ledger: ledgerView,
      blockers,
      digest,
    };
  });

  return {
    policyVersion: ELIGIBILITY_POLICY_VERSION,
    mode: input.mode,
    evaluatedAt,
    currencies: result,
    blockers: global,
  };
}
