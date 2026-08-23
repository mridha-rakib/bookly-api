import mongoose, { Types } from "mongoose";

import type { BookingFinancialTransactionDocument } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { BusinessPayoutDocument } from "./business-payout.model.js";
import type {
  BusinessPayoutRepository,
  CreateBusinessPayoutInput,
} from "./business-payout.repository.js";
import { FinanceError } from "./finance.errors.js";
import { classifySourceOwner } from "./finance-ownership.js";

const BUSINESS_PAYABLE_TYPES = [
  "DEPOSIT",
  "CANCELLATION_FEE",
  "NO_SHOW_FEE",
  "PROCESSING_FEE",
  "REFUND",
] as const;

const BUSINESS_OWNED_GROSS_TYPES = new Set(["DEPOSIT", "CANCELLATION_FEE", "NO_SHOW_FEE"]);

/**
 * Batch 8 — the ONLY write path that ever creates a real payout. Manual, Super-Admin-triggered,
 * one-step self-attestation (confirmed product decision — see business-payout.model.ts's own
 * doc comment): there is no automatic daily/weekly/monthly schedule (rule #9), and no real
 * SEPA/Stripe Connect transfer execution exists in this codebase, so a payout is created
 * DIRECTLY as `status: "PAID"` the moment a Super Admin confirms — never a fabricated
 * "processing" limbo state waiting on an external system that does not exist.
 *
 * Concurrency/idempotency (rule #13): the read (which transactions are still unclaimed) and the
 * write (claiming them + inserting the payout row) happen INSIDE ONE Mongo transaction,
 * matching this codebase's existing transactional pattern (see BookingLifecycleService's own
 * `withTransaction` usage) — MongoDB's snapshot isolation plus `withTransaction`'s automatic
 * retry-on-TransientTransactionError together guarantee two concurrent "Send SEPA" clicks for
 * the same Business can never both claim the same transaction: whichever commits first wins,
 * and the loser's retry re-reads the (now-claimed) rows and finds nothing left, failing cleanly
 * with FINANCE_NO_ELIGIBLE_PAYABLE rather than creating a duplicate/partial payout.
 */
export class BusinessPayoutService {
  public constructor(
    private readonly businessRepository: BusinessRepository,
    private readonly financialTransactionService: BookingFinancialTransactionService,
    private readonly businessPayoutRepository: BusinessPayoutRepository,
  ) {}

  public async executePayout(
    superAdminUserId: string,
    businessId: string,
    options: { providerReference?: string | undefined } = {},
  ): Promise<BusinessPayoutDocument> {
    if (!/^[a-f\d]{24}$/i.test(businessId)) {
      throw new FinanceError("FINANCE_BUSINESS_NOT_FOUND", 404);
    }
    const business = await this.businessRepository.findById(businessId);
    if (!business) {
      throw new FinanceError("FINANCE_BUSINESS_NOT_FOUND", 404);
    }

    const dbSession = await mongoose.startSession();
    let payout: BusinessPayoutDocument | undefined;

    try {
      await dbSession.withTransaction(async () => {
        const candidates = await this.financialTransactionService.findUnclaimedForPayout(
          business._id,
          [...BUSINESS_PAYABLE_TYPES],
          dbSession,
        );
        // CRITICAL: `candidates` includes every unclaimed PROCESSING_FEE/REFUND row regardless
        // of ownership (the query can't filter on `metadata.sourceType` cheaply) — a
        // first-booking PLATFORM_FEE's own processing fee would otherwise be silently claimed
        // (and thus permanently excluded from future reads) by a payout it has nothing to do
        // with, even though `computeBusinessOwnedTotals` already correctly excludes its AMOUNT.
        // Filter to the entries that are ACTUALLY Business-owned before claiming ANY of them.
        const entries = this.filterBusinessOwned(candidates);

        const totals = this.computeBusinessOwnedTotals(entries);

        if (entries.length === 0 || totals.netCents <= 0) {
          throw new FinanceError("FINANCE_NO_ELIGIBLE_PAYABLE", 409);
        }

        const ids = entries.map((entry) => entry._id);
        const timestamps = entries.map((entry) => entry.createdAt.getTime());

        const input: CreateBusinessPayoutInput = {
          businessId: business._id,
          periodStart: new Date(Math.min(...timestamps)),
          periodEnd: new Date(Math.max(...timestamps)),
          grossBusinessOwnedCents: totals.grossCents,
          processingFeesCents: totals.processingFeesCents,
          refundsCents: totals.refundsCents,
          netPayoutCents: totals.netCents,
          currency: "EUR",
          status: "PAID",
          settledTransactionIds: ids,
          initiatedByUserId: new Types.ObjectId(superAdminUserId),
          ...(options.providerReference ? { providerReference: options.providerReference } : {}),
          paidAt: new Date(),
        };

        payout = await this.businessPayoutRepository.create(input, dbSession);

        const claimed = await this.financialTransactionService.claimForPayout(
          ids,
          payout._id,
          dbSession,
        );
        if (claimed !== ids.length) {
          // A concurrent claim won part of this set between our read and our write — abort the
          // whole transaction rather than settle a partial/incorrect total. withTransaction's
          // own retry will re-read the (now smaller, or empty) unclaimed set on the next pass.
          throw new FinanceError("FINANCE_PAYOUT_CONFLICT", 409);
        }
      });
    } finally {
      await dbSession.endSession();
    }

    if (!payout) {
      throw new Error("Payout transaction completed without producing a payout document");
    }
    return payout;
  }

  /** The one place that decides "is this specific ledger entry actually Business-owned" —
   * shared by `executePayout` (deciding what to CLAIM) and `computeBusinessOwnedTotals`
   * (deciding what to SUM), so the two can never drift (rule #17). */
  private filterBusinessOwned(
    entries: BookingFinancialTransactionDocument[],
  ): BookingFinancialTransactionDocument[] {
    return entries.filter((entry) => {
      if (BUSINESS_OWNED_GROSS_TYPES.has(entry.type)) {
        return true;
      }
      if (entry.type === "PROCESSING_FEE" || entry.type === "REFUND") {
        const sourceType = (entry.metadata?.["sourceType"] as string | undefined) ?? null;
        return classifySourceOwner(sourceType) === "BUSINESS";
      }
      return false;
    });
  }

  /** Read-only preview of the exact same formula `executePayout` claims against — used by
   * BusinessFinanceService for "what would a payout settle right now" displays (Super Admin's
   * per-business pending list, Business Detail's PayoutBreakdownCard) without actually claiming
   * anything. Deliberately NOT run inside a transaction (a preview has no write to protect). */
  public computeBusinessOwnedTotals(entries: BookingFinancialTransactionDocument[]): {
    grossCents: number;
    processingFeesCents: number;
    refundsCents: number;
    netCents: number;
  } {
    let grossCents = 0;
    let processingFeesCents = 0;
    let refundsCents = 0;

    for (const entry of entries) {
      if (BUSINESS_OWNED_GROSS_TYPES.has(entry.type)) {
        grossCents += entry.amountCents;
      } else if (entry.type === "PROCESSING_FEE") {
        const sourceType = (entry.metadata?.["sourceType"] as string | undefined) ?? null;
        if (classifySourceOwner(sourceType) === "BUSINESS") {
          processingFeesCents += entry.amountCents;
        }
      } else if (entry.type === "REFUND") {
        const sourceType = (entry.metadata?.["sourceType"] as string | undefined) ?? null;
        if (classifySourceOwner(sourceType) === "BUSINESS") {
          refundsCents += entry.amountCents;
        }
      }
    }

    return {
      grossCents,
      processingFeesCents,
      refundsCents,
      netCents: grossCents - processingFeesCents - refundsCents,
    };
  }
}
