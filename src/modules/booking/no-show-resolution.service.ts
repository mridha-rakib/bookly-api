import type { ClientSession, Types } from "mongoose";
import { logger } from "../../config/logger.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { PackageProgressRepository } from "../package-progress/package-progress.repository.js";
import {
  isPackageLinkedBooking,
  packageSessionOutcomeForBookingStatus,
} from "../package-progress/package-progress.rules.js";
import type { PaymentService } from "../payment/payment.service.js";
import type { BookingDocument, BookingEventHistoryEntry } from "./booking.model.js";
import type { BookingRepository } from "./booking.repository.js";
import { verifyPackageBatchActivation } from "./package-batch-authority.js";
import {
  computeNoShowPenalty,
  isPenaltyCollectible,
  PenaltyCollectionService,
} from "./penalty-collection.service.js";

/** `charge_failed` — the one durable attempt definitively failed (or no usable card): the
 * booking stays PENDING, claimed, for manual resolution. `charge_pending` — the provider outcome
 * is not confirmed yet; recovery reconciles the same attempt. `error` — the item threw and was
 * isolated so the rest of the batch still ran. */
export type NoShowResolutionOutcome =
  | "charged"
  | "charge_failed"
  | "charge_pending"
  | "waived_no_policy"
  | "waived_no_charge_possible"
  | "skipped_already_resolved"
  | "error";

/**
 * The no-show AUTO-resolution processor (Batch 4, Phase 8) — deliberately separate from
 * `BookingLifecycleService` (which owns the human-triggered markNoShow/waiveFee/
 * cancelNoShowByBusiness actions): this class is exercised by the worker entry point
 * (scripts/run-no-show-worker.ts), never by an HTTP controller, and has a different concurrency
 * story (see `autoResolve`'s own comment) than a single-actor CAS transition.
 *
 * Batch 1's own rule stands: "No-show never starts automatically... only by an explicit
 * business-side 'mark as no-show' action." This class only ever RESOLVES a timer a human
 * already started (`noShowStartedAt`/`noShowDeadlineAt` are read-only here, never written).
 *
 * ATTRIBUTION: every automated resolution still needs a real `actorUserId` for the required
 * `BookingEventHistoryEntry.actorUserId` field — there is no "system" pseudo-user anywhere in
 * this codebase to reuse, and inventing one is a bigger schema change than this batch's own
 * no-show scope calls for. The Business's own `ownerUserId` is used instead, with
 * `actorRole: "BUSINESS_OWNER"` and an explicit `note` making clear the action was automated —
 * a reasonable, documented convention ("the system acts on the Business's behalf"), not a
 * silent misattribution; flagged in the Batch 4 final report as worth reconsidering once/if a
 * genuine system-actor concept is ever introduced.
 */
/**
 * Stage D mailing observer (optional + trailing, never throws). Fed the domain's OWN computed
 * no-show amounts — this service never asks the notifier to recompute anything.
 */
export type NoShowResolutionNotificationPort = {
  notifyNoShowCharged(
    booking: BookingDocument,
    context: {
      businessName: string;
      amounts: {
        noShowPercentage: number;
        eligibleBasisCents: number;
        grossFeeCents: number;
        upfrontAppliedCents: number;
        additionalChargeCents: number;
      };
    },
    session?: ClientSession,
  ): Promise<void>;
  notifyNoShowWaived(booking: BookingDocument, context: { businessName: string }): Promise<void>;
};

export class NoShowResolutionService {
  public constructor(
    private readonly bookingRepository: BookingRepository,
    private readonly businessRepository: BusinessRepository,
    paymentService: PaymentService,
    private readonly financialTransactionService: BookingFinancialTransactionService,
    // Stage D mailing — same optional-trailing pattern as elsewhere. Absent in the integration
    // suites that construct this service directly.
    private readonly noShowNotifier?: NoShowResolutionNotificationPort,
    // Package Deal no-show resolution hook (optional + trailing, same rationale as
    // BookingLifecycleService's identical dependency) — a genuinely resolved no-show
    // (NO_SHOW_CHARGED or NO_SHOW_WAIVED) forfeits the Package session; see
    // package-progress.rules.ts for the single source of truth this decision comes from.
    private readonly packageProgressRepository?: Pick<
      PackageProgressRepository,
      "resolveSessionOnTerminalStatus"
    >,
    // P5 — durable penalty collection (claim, single attempt, shared convergence). Defaults to
    // one built from the dependencies above; production passes the fully wired instance.
    private readonly penaltyCollection: PenaltyCollectionService = new PenaltyCollectionService({
      paymentService,
      financialTransactionService,
      bookingRepository,
      businessRepository,
      noShowNotifier,
      packageProgressRepository,
    }),
  ) {}

  /** Best-effort, non-transactional (matching this worker's own existing write style — see
   * transitionViaOwner's own bare casUpdate) — no-op for a Booking with no Package-linked line. */
  private async syncPackageSessionOnResolvedNoShow(booking: BookingDocument): Promise<void> {
    if (!this.packageProgressRepository || !isPackageLinkedBooking(booking)) {
      return;
    }
    const outcome = packageSessionOutcomeForBookingStatus(booking.status);
    if (outcome === "NONE") {
      return;
    }
    await this.packageProgressRepository.resolveSessionOnTerminalStatus(booking._id, outcome);
  }

  /**
   * Processes one overdue Booking. Concurrency-safe across multiple worker instances via TWO
   * independent gates, matching whichever branch is taken:
   *  - The "nothing to charge" branches (no policy / no possible charge) use
   *    `BookingRepository.casUpdate`'s own CAS-on-status guarantee — only one concurrent caller
   *    can ever win the `PENDING -> NO_SHOW_WAIVED` transition.
   *  - The "attempt a real charge" branch (P5) claims FIRST in one transaction: a CAS on the
   *    booking (still PENDING, `noShowChargeClaimedAt` absent) plus the obligation's unique
   *    ledger `idempotencyKey`, before ever calling Stripe — so two workers racing the same
   *    overdue Booking can never both attempt the charge, and a reversal/waiver that committed
   *    first always wins. The loser returns `skipped_already_resolved`.
   * Never scans the full Booking collection — the caller (`runOnce`) already selected candidate
   * ids via the index-backed `findManyOverdueNoShows`; this method re-fetches and re-verifies
   * the SINGLE document fresh, so a stale batch read never drives an action.
   */
  public async autoResolve(bookingId: Types.ObjectId): Promise<NoShowResolutionOutcome> {
    const booking = await this.bookingRepository.findByIdOnly(bookingId);
    if (booking?.serviceLines.some((line) => line.pricingInput.packageItemId))
      await verifyPackageBatchActivation();
    if (
      !booking ||
      booking.status !== "PENDING" ||
      !booking.noShowDeadlineAt ||
      booking.noShowDeadlineAt.getTime() > Date.now() ||
      booking.noShowChargeClaimedAt
    ) {
      return "skipped_already_resolved";
    }

    // Package rule (confirmed): "the lost session IS the penalty" — a Package-linked no-show
    // (the purchase session OR a redeemed session) never carries an additional base-service
    // percentage fee (computeNoShowPenalty forces no percentage), which reuses the EXISTING
    // "nothing chargeable" branch below verbatim (no Stripe call ever attempted).
    //
    // Nets against the deposit already collected at booking time — ledgered as PLATFORM_FEE
    // (first booking) OR DEPOSIT (returning booking, Batch 6.5 correction: this customer still
    // paid a real deposit online even though Bookly didn't keep it as platform revenue — the
    // no-show charge must still net against it, or a returning customer would be double-charged
    // for the portion their deposit already covers). See
    // BookingFinancialTransactionService.findSucceededUpfrontPayment and
    // BookingCancellationOutcome's own doc comment in booking.model.ts for the exact formula.
    // Only the shortfall beyond the already-held deposit is ever newly charged here.
    const noShowPercentage = computeNoShowPenalty(booking, 0).noShowPercentage;
    const upfrontPayment = noShowPercentage
      ? await this.financialTransactionService.findSucceededUpfrontPayment(booking._id)
      : undefined;
    const penalty = computeNoShowPenalty(booking, upfrontPayment?.amountCents ?? 0);

    // Nothing chargeable: no policy was ever snapshotted for this Business at booking time, no
    // possible charge amount, a MANUAL Booking (no Stripe integration by design — rule #8), or
    // no linked Customer identity to charge (should not happen for BOOKLY_MANAGED, defensive).
    if (!noShowPercentage || penalty.amountCents <= 0 || !isPenaltyCollectible(booking)) {
      const waived = await this.transitionViaOwner(booking, "NO_SHOW_WAIVED", {
        note: isPackageLinkedBooking(booking)
          ? "Auto-resolved: Package base-service no-show — the forfeited session is the only penalty, no additional fee applies"
          : !noShowPercentage
            ? "Auto-resolved: no cancellation/no-show policy was configured for this business at booking time"
            : "Auto-resolved: no chargeable amount or payment method available",
      });
      if (waived) {
        await this.syncPackageSessionOnResolvedNoShow(waived);
      }
      // Only notify the customer of a "fee waived" outcome when there genuinely WAS a no-show
      // fee to waive: a policy existed, it is a real online customer, and it is not a MANUAL
      // booking (i.e. the ONLY reason we reached this branch is amountCents <= 0 — the deposit
      // already covered the fee). No email for "no policy was ever configured" / MANUAL / a
      // Package (which never had a real fee at stake in the first place).
      const feeCoveredByDeposit =
        Boolean(noShowPercentage) &&
        booking.source !== "MANUAL" &&
        Boolean(booking.customer.customerUserId);
      if (waived && feeCoveredByDeposit) {
        await this.dispatchNoShowWaived(waived);
      }
      return waived
        ? noShowPercentage
          ? "waived_no_charge_possible"
          : "waived_no_policy"
        : "skipped_already_resolved";
    }

    // P5 — the claim is ONE transaction: the booking must still be PENDING and unclaimed while
    // `noShowChargeClaimedAt`, the PENDING NO_SHOW_FEE obligation and its single PaymentAttempt
    // are written. A concurrent worker, waiver or reversal either commits first (no charge) or
    // loses to this claim. The provider call happens only after commit.
    const claim = await this.penaltyCollection.claimNoShowPenalty(booking, penalty);
    if (!claim) {
      return "skipped_already_resolved";
    }
    if (!claim.attempt) {
      // No usable saved card: the obligation is definitively FAILED (nothing was ever sent);
      // the booking stays PENDING, claimed, awaiting the Business's waive/reversal.
      return "charge_failed";
    }

    // One durable off-session attempt, converged through the shared penalty logic: SUCCEEDED
    // moves the booking to NO_SHOW_CHARGED (and sends the CHARGED email) atomically with the
    // ledger settlement; a definitive failure leaves it PENDING for manual resolution and is
    // never charged again; an ambiguous outcome stays recoverable and is never re-dispatched.
    const outcome = await this.penaltyCollection.collect(claim.obligation._id);
    if (outcome === "SUCCEEDED") return "charged";
    if (outcome === "FAILED") return "charge_failed";
    return "charge_pending";
  }

  private async dispatchNoShowWaived(booking: BookingDocument): Promise<void> {
    if (!this.noShowNotifier) {
      return;
    }
    const business = await this.businessRepository.findById(booking.businessId);
    await this.noShowNotifier.notifyNoShowWaived(booking, {
      businessName: business?.name ?? "the business",
    });
  }

  /** Bounded, index-backed batch entry point — see BookingRepository.findManyOverdueNoShows's
   * own comment for why this never scans the full collection. */
  public async runOnce(batchSize: number): Promise<Record<NoShowResolutionOutcome, number>> {
    const now = new Date();
    const candidates = await this.bookingRepository.findManyOverdueNoShows(now, batchSize);

    const counts: Record<NoShowResolutionOutcome, number> = {
      charged: 0,
      charge_failed: 0,
      charge_pending: 0,
      waived_no_policy: 0,
      waived_no_charge_possible: 0,
      skipped_already_resolved: 0,
      error: 0,
    };

    // P5 — per-item isolation: one booking that throws (provider, database or data problem) is
    // reported and skipped; every other eligible overdue no-show in the batch is still processed.
    for (const candidate of candidates) {
      try {
        const outcome = await this.autoResolve(candidate._id);
        counts[outcome] += 1;
      } catch (error) {
        counts.error += 1;
        logger.error(
          { err: error, bookingId: String(candidate._id) },
          "No-show worker item failed — continuing with the rest of the batch",
        );
      }
    }

    return counts;
  }

  private async transitionViaOwner(
    booking: BookingDocument,
    nextStatus: "NO_SHOW_WAIVED",
    extra: { note?: string | undefined },
  ): Promise<BookingDocument | null> {
    const business = await this.businessRepository.findById(booking.businessId);
    if (!business) {
      return null;
    }

    const event: BookingEventHistoryEntry = {
      type: "STATUS_CHANGED",
      previousStatus: "PENDING",
      nextStatus,
      actorUserId: business.ownerUserId,
      actorRole: "BUSINESS_OWNER",
      ...(extra.note ? { note: extra.note } : {}),
      createdAt: new Date(),
    };

    // Never on a claimed booking: once a charge obligation exists only the penalty gate may
    // resolve it (P5).
    return this.bookingRepository.casUpdate(booking.businessId, booking._id, ["PENDING"], {
      set: { status: nextStatus },
      pushEvent: event,
      extraFilter: { noShowChargeClaimedAt: { $exists: false } },
    });
  }
}
