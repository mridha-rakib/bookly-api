import mongoose, { type ClientSession, Types } from "mongoose";

import { BookingFinancialTransactionModel } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import { PackageProgressError } from "../package-progress/package-progress.errors.js";
import {
  type PackageProgressDocument,
  PackageProgressModel,
} from "../package-progress/package-progress.model.js";
import { RefundOperationModel } from "../payment/refund-operation.model.js";
import type { UserRole } from "../user/user.types.js";
import { type BookingDocument, BookingModel } from "./booking.model.js";
import type { BookingService } from "./booking.service.js";
import type { BookingStatus } from "./booking.types.js";
import { bookingPaymentSummary } from "./booking-payment-summary.js";

/**
 * Fix #3 — Legacy Package purchase balance recorder.
 *
 * Approved contract this applies (package-progress.rules.ts computePackageBalanceSettlement):
 * sessions 2..N unlock only once the ORIGIN purchase Booking's `financials.balanceDueCents` is
 * recorded as fully paid in `Booking.completionPayment`. Before this fix the only Legacy writer
 * of that record was `completeBooking`, which requires the origin to still be UPCOMING — so an
 * origin cancelled, forfeited or no-showed before the venue balance was recorded (or completed
 * with a PARTIAL/NOT_PAID attestation) left the package permanently AWAITING_BALANCE.
 *
 * This recorder attests real money the Business received off-platform, independently of the
 * origin appointment's lifecycle: the appointment status is never changed, no provider call is
 * made, no provider evidence is manufactured, and nothing is ever marked paid automatically.
 * It reuses the existing representation exactly — cumulative `completionPayment` (the shape the
 * First-Class VENUE_SETTLEMENT writer already uses) plus one SUCCEEDED `PAYMENT` ledger row with
 * `collectedAtVenue` per recorded amount — so finance, invoices and package views need no change.
 *
 * Deliberately refused (never guessed):
 *  - origin still UPCOMING/PENDING: the ordinary completion flow owns that attestation;
 *  - any refund (owed, operation or ledger row) or dispute on the origin: the recorded
 *    `balanceDueCents` was computed net of an upfront that is no longer retained, so what the
 *    customer now owes is an unresolved Owner policy decision;
 *  - a voided package, a First-Class (v2) package, a non-owner actor.
 */

const RECORDABLE_ORIGIN_STATUSES: readonly BookingStatus[] = [
  "COMPLETED",
  "CANCELLED_BY_CUSTOMER",
  "CANCELLED_BY_BUSINESS",
  "LATE_CANCELLATION",
  "NO_SHOW_CHARGED",
  "NO_SHOW_WAIVED",
  "NO_SHOW_CANCELLED",
];

const REVERSAL_LEDGER_TYPES = ["REFUND", "DISPUTE_WITHDRAWAL"] as const;

export type LegacyPackageBalanceBlockedReason =
  | "SETTLED"
  | "PACKAGE_VOIDED"
  | "ORIGIN_NOT_FINAL"
  | "UPFRONT_REVERSED";

export type LegacyPackageBalancePayment = {
  amountCents: number;
  recordedAt: string;
  source: "COMPLETION" | "BALANCE_RECORDING";
};

export type LegacyPackageBalanceView = {
  packageProgressId: string;
  originBookingId: string;
  originBookingStatus: BookingStatus;
  currency: string;
  originalBalanceCents: number;
  paidCents: number;
  outstandingCents: number;
  settlementStatus: ReturnType<typeof bookingPaymentSummary>["venueSettlementStatus"];
  balanceSettled: boolean;
  recordable: boolean;
  blockedReason?: LegacyPackageBalanceBlockedReason | undefined;
  payments: LegacyPackageBalancePayment[];
};

export type RecordLegacyPackageBalanceInput = {
  settlement: "FULL" | "PARTIAL";
  amountCents?: number | undefined;
  expectedOutstandingCents: number;
  idempotencyKey: string;
  note?: string | undefined;
};

type LoadedState = {
  progress: PackageProgressDocument;
  origin: BookingDocument;
  blockedReason?: LegacyPackageBalanceBlockedReason | undefined;
};

export class LegacyPackageBalanceService {
  public constructor(
    private readonly bookingService: Pick<BookingService, "requireBookingManagementAccess">,
    private readonly financialTransactionService: Pick<
      BookingFinancialTransactionService,
      "record"
    >,
  ) {}

  public async getBalance(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    packageProgressId: string,
  ): Promise<LegacyPackageBalanceView> {
    const business = await this.requireOwner(actorUserId, actorRole, businessId);
    const state = await this.load(business._id, packageProgressId);
    return this.toView(state);
  }

  public async recordPayment(
    actorUserId: string,
    actorRole: UserRole,
    businessId: string,
    packageProgressId: string,
    input: RecordLegacyPackageBalanceInput,
  ): Promise<LegacyPackageBalanceView> {
    const business = await this.requireOwner(actorUserId, actorRole, businessId);
    const ledgerKey = `legacy-package-balance:${packageProgressId}:${input.idempotencyKey}`;
    const dbSession = await mongoose.startSession();
    try {
      await dbSession.withTransaction(async () => {
        const state = await this.load(business._id, packageProgressId, dbSession);
        const replay = await BookingFinancialTransactionModel.findOne({
          idempotencyKey: ledgerKey,
        })
          .session(dbSession)
          .exec();
        if (replay) {
          // Same key already committed: return the current truth, never a second payment. A key
          // reused for a different package/request is a client error, not a silent success.
          if (
            !replay.bookingId.equals(state.origin._id) ||
            replay.metadata?.["requestedSettlement"] !== input.settlement ||
            (input.settlement === "PARTIAL" && replay.amountCents !== input.amountCents)
          )
            throw new PackageProgressError("PACKAGE_BALANCE_IDEMPOTENCY_CONFLICT", 409);
          return;
        }
        if (state.blockedReason === "SETTLED")
          throw new PackageProgressError("PACKAGE_BALANCE_ALREADY_SETTLED", 409);
        if (state.blockedReason === "PACKAGE_VOIDED")
          throw new PackageProgressError("PACKAGE_PROGRESS_VOIDED", 409);
        if (state.blockedReason === "ORIGIN_NOT_FINAL")
          throw new PackageProgressError("PACKAGE_BALANCE_ORIGIN_NOT_FINAL", 409);
        if (state.blockedReason === "UPFRONT_REVERSED")
          throw new PackageProgressError("PACKAGE_BALANCE_DECISION_REQUIRED", 409);

        const { origin } = state;
        const summary = bookingPaymentSummary(origin);
        const outstanding = summary.outstandingVenueBalanceCents;
        if (input.expectedOutstandingCents !== outstanding)
          throw new PackageProgressError("PACKAGE_BALANCE_CHANGED", 409);
        const amount = input.settlement === "FULL" ? outstanding : input.amountCents;
        if (
          amount === undefined ||
          !Number.isSafeInteger(amount) ||
          amount <= 0 ||
          (input.settlement === "PARTIAL" && amount >= outstanding) ||
          amount > outstanding
        )
          throw new PackageProgressError("PACKAGE_BALANCE_INVALID_AMOUNT", 400);

        const now = new Date();
        const cumulative = summary.venuePaidCents + amount;
        const previous = origin.completionPayment;
        const updated = await BookingModel.updateOne(
          {
            _id: origin._id,
            businessId: business._id,
            status: origin.status,
            "financials.balanceDueCents": origin.financials.balanceDueCents,
            ...(previous
              ? { "completionPayment.recordedAt": previous.recordedAt }
              : { completionPayment: null }),
          },
          {
            $set: {
              completionPayment: {
                paid: true,
                amountCents: cumulative,
                ...(input.note ? { note: input.note } : {}),
                recordedAt: now,
                recordedBy: new Types.ObjectId(actorUserId),
              },
            },
            $push: {
              eventHistory: {
                type: "VENUE_PAYMENT_RECORDED",
                actorUserId: new Types.ObjectId(actorUserId),
                actorRole: "BUSINESS_OWNER",
                reason: `Package balance payment ${amount} cents (${input.settlement})`,
                ...(input.note ? { note: input.note } : {}),
                createdAt: now,
              },
            },
          },
          { session: dbSession, runValidators: true },
        ).exec();
        if (updated.modifiedCount !== 1)
          throw new PackageProgressError("PACKAGE_BALANCE_CHANGED", 409);
        // Touch the entitlement inside the same transaction so a concurrent void (which writes
        // this document) and this recording can never both commit on a stale read.
        const touched = await PackageProgressModel.updateOne(
          { _id: state.progress._id, voidedAt: { $exists: false } },
          { $set: { updatedAt: now } },
          { session: dbSession, timestamps: false },
        ).exec();
        if (touched.matchedCount !== 1)
          throw new PackageProgressError("PACKAGE_PROGRESS_VOIDED", 409);
        await this.financialTransactionService.record(
          {
            businessId: business._id,
            bookingId: origin._id,
            businessClientId: origin.customer.businessClientId,
            customerUserId: origin.customer.customerUserId,
            type: "PAYMENT",
            direction: "DEBIT",
            amountCents: amount,
            currency: origin.financials.currency,
            status: "SUCCEEDED",
            idempotencyKey: ledgerKey,
            metadata: {
              collectedAtVenue: true,
              legacyPackageBalance: true,
              packageProgressId: String(state.progress._id),
              requestedSettlement: input.settlement,
              recordedBy: actorUserId,
              cumulativePaidCents: cumulative,
            },
          },
          dbSession,
        );
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /transaction numbers are only allowed|replica set member/i.test(error.message)
      )
        throw new PackageProgressError("PACKAGE_BALANCE_UNAVAILABLE", 503);
      throw error;
    } finally {
      await dbSession.endSession();
    }
    return this.toView(await this.load(business._id, packageProgressId));
  }

  /** Package balances are Owner-only: Supervisors are deliberately denied package financials
   * (booking.controller getPackageForBusiness redaction), so they get the same not-found as any
   * unrelated caller rather than a role-specific answer. */
  private async requireOwner(actorUserId: string, actorRole: UserRole, businessId: string) {
    if (actorRole !== "BUSINESS_OWNER")
      throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    try {
      return await this.bookingService.requireBookingManagementAccess(
        actorUserId,
        actorRole,
        businessId,
      );
    } catch {
      throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    }
  }

  private async load(
    businessId: Types.ObjectId,
    packageProgressId: string,
    session?: ClientSession,
  ): Promise<LoadedState> {
    if (!Types.ObjectId.isValid(packageProgressId))
      throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    // PackageProgressModel's own query middleware restricts every read to legacy (v1) rows, so a
    // First-Class (v2) entitlement id is indistinguishable from an unknown one here.
    const progress = await PackageProgressModel.findOne({ _id: packageProgressId, businessId })
      .session(session ?? null)
      .exec();
    if (!progress) throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);
    const origin = await BookingModel.findOne({
      _id: progress.originBookingId,
      businessId,
      "customer.customerUserId": progress.customerUserId,
      "serviceLines.pricingInput.packageProgressId": progress._id,
    })
      .session(session ?? null)
      .exec();
    if (!origin || origin.serviceLines.some((line) => line.pricingInput.packageItemId))
      throw new PackageProgressError("PACKAGE_PROGRESS_NOT_FOUND", 404);

    const summary = bookingPaymentSummary(origin);
    let blockedReason: LegacyPackageBalanceBlockedReason | undefined;
    if (summary.outstandingVenueBalanceCents <= 0) blockedReason = "SETTLED";
    else if (progress.voidedAt) blockedReason = "PACKAGE_VOIDED";
    else if (!RECORDABLE_ORIGIN_STATUSES.includes(origin.status))
      blockedReason = "ORIGIN_NOT_FINAL";
    else if (await this.upfrontReversed(origin, session)) blockedReason = "UPFRONT_REVERSED";
    return { progress, origin, blockedReason };
  }

  private async upfrontReversed(origin: BookingDocument, session?: ClientSession) {
    if ((origin.cancellationOutcome?.refundOwedCents ?? 0) > 0) return true;
    const [ledger, refund] = await Promise.all([
      BookingFinancialTransactionModel.exists({
        bookingId: origin._id,
        type: { $in: REVERSAL_LEDGER_TYPES },
      }).session(session ?? null),
      RefundOperationModel.exists({ bookingId: origin._id }).session(session ?? null),
    ]);
    return Boolean(ledger || refund);
  }

  private async toView(state: LoadedState): Promise<LegacyPackageBalanceView> {
    const { origin, progress } = state;
    const summary = bookingPaymentSummary(origin);
    const rows = await BookingFinancialTransactionModel.find({
      bookingId: origin._id,
      type: "PAYMENT",
      status: "SUCCEEDED",
      "metadata.collectedAtVenue": true,
    })
      .sort({ createdAt: 1, _id: 1 })
      .exec();
    return {
      packageProgressId: String(progress._id),
      originBookingId: String(origin._id),
      originBookingStatus: origin.status,
      currency: origin.financials.currency,
      originalBalanceCents: summary.originalVenueBalanceCents,
      paidCents: summary.venuePaidCents,
      outstandingCents: summary.outstandingVenueBalanceCents,
      settlementStatus: summary.venueSettlementStatus,
      balanceSettled: summary.outstandingVenueBalanceCents <= 0,
      recordable: state.blockedReason === undefined,
      ...(state.blockedReason ? { blockedReason: state.blockedReason } : {}),
      payments: rows.map((row) => ({
        amountCents: row.amountCents,
        recordedAt: row.createdAt.toISOString(),
        source:
          row.metadata?.["legacyPackageBalance"] === true ? "BALANCE_RECORDING" : "COMPLETION",
      })),
    };
  }
}
