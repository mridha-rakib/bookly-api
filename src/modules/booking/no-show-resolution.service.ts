import type { Types } from "mongoose";

import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { PaymentService } from "../payment/payment.service.js";
import type { BookingDocument, BookingEventHistoryEntry } from "./booking.model.js";
import type { BookingRepository } from "./booking.repository.js";

export type NoShowResolutionOutcome =
  | "charged"
  | "waived_no_policy"
  | "waived_no_charge_possible"
  | "skipped_already_resolved";

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
export class NoShowResolutionService {
  public constructor(
    private readonly bookingRepository: BookingRepository,
    private readonly businessRepository: BusinessRepository,
    private readonly paymentService: PaymentService,
    private readonly financialTransactionService: BookingFinancialTransactionService,
  ) {}

  /**
   * Processes one overdue Booking. Concurrency-safe across multiple worker instances via TWO
   * independent gates, matching whichever branch is taken:
   *  - The "nothing to charge" branches (no policy / no possible charge) use
   *    `BookingRepository.casUpdate`'s own CAS-on-status guarantee — only one concurrent caller
   *    can ever win the `PENDING -> NO_SHOW_WAIVED` transition.
   *  - The "attempt a real charge" branch claims FIRST via the ledger's existing unique
   *    `idempotencyKey` index (`booking-financial-transaction.model.ts`) — the exact same
   *    proven primitive this codebase already uses for retry-safe charges — before ever calling
   *    Stripe, so two workers racing the same overdue Booking can never both attempt the charge;
   *    the loser's `record()` call throws a duplicate-key-mapped error and this method returns
   *    `skipped_already_resolved`.
   * Never scans the full Booking collection — the caller (`runOnce`) already selected candidate
   * ids via the index-backed `findManyOverdueNoShows`; this method re-fetches and re-verifies
   * the SINGLE document fresh, so a stale batch read never drives an action.
   */
  public async autoResolve(bookingId: Types.ObjectId): Promise<NoShowResolutionOutcome> {
    const booking = await this.bookingRepository.findByIdOnly(bookingId);
    if (
      !booking ||
      booking.status !== "PENDING" ||
      !booking.noShowDeadlineAt ||
      booking.noShowDeadlineAt.getTime() > Date.now()
    ) {
      return "skipped_already_resolved";
    }

    const noShowPercentage = booking.cancellationPolicySnapshot?.noShowPercentage;
    const grossFeeCents = noShowPercentage
      ? Math.round((booking.financials.eligiblePlatformFeeBasisCents * noShowPercentage) / 100)
      : 0;
    // Nets against the deposit already collected at booking time — ledgered as PLATFORM_FEE
    // (first booking) OR DEPOSIT (returning booking, Batch 6.5 correction: this customer still
    // paid a real deposit online even though Bookly didn't keep it as platform revenue — the
    // no-show charge must still net against it, or a returning customer would be double-charged
    // for the portion their deposit already covers). See
    // BookingFinancialTransactionService.findSucceededUpfrontPayment and
    // BookingCancellationOutcome's own doc comment in booking.model.ts for the exact formula.
    // Only the shortfall beyond the already-held deposit is ever newly charged here.
    const upfrontPayment = noShowPercentage
      ? await this.financialTransactionService.findSucceededUpfrontPayment(booking._id)
      : undefined;
    const amountCents = Math.max(0, grossFeeCents - (upfrontPayment?.amountCents ?? 0));

    // Nothing chargeable: no policy was ever snapshotted for this Business at booking time, no
    // possible charge amount, a MANUAL Booking (no Stripe integration by design — rule #8), or
    // no linked Customer identity to charge (should not happen for BOOKLY_MANAGED, defensive).
    if (
      !noShowPercentage ||
      amountCents <= 0 ||
      booking.source === "MANUAL" ||
      !booking.customer.customerUserId
    ) {
      const waived = await this.transitionViaOwner(booking, "NO_SHOW_WAIVED", {
        note: !noShowPercentage
          ? "Auto-resolved: no cancellation/no-show policy was configured for this business at booking time"
          : "Auto-resolved: no chargeable amount or payment method available",
      });
      return waived
        ? noShowPercentage
          ? "waived_no_charge_possible"
          : "waived_no_policy"
        : "skipped_already_resolved";
    }

    const idempotencyKey = `no-show:${String(booking._id)}`;
    let claim: { _id: Types.ObjectId };
    try {
      claim = await this.financialTransactionService.record({
        businessId: booking.businessId,
        bookingId: booking._id,
        businessClientId: booking.customer.businessClientId,
        customerUserId: booking.customer.customerUserId,
        type: "NO_SHOW_FEE",
        direction: "DEBIT",
        amountCents,
        currency: booking.financials.currency,
        status: "PENDING",
        idempotencyKey,
      });
    } catch {
      // Another worker instance already claimed this Booking's resolution.
      return "skipped_already_resolved";
    }

    let succeeded = false;
    let providerReference: string | undefined;
    try {
      const result = await this.paymentService.chargeOffSession({
        userId: booking.customer.customerUserId,
        amountCents,
        idempotencyKey,
        metadata: { bookingId: String(booking._id), purpose: "NO_SHOW_FEE" },
      });
      providerReference = result.paymentIntentId;
      succeeded = result.status === "succeeded";
    } catch {
      succeeded = false;
    }

    // Settle the PENDING ledger row this claim created — the one narrow allowed mutation (see
    // BookingFinancialTransactionRepository.updateStatus's own comment).
    await this.financialTransactionService.settleStatus(
      claim._id,
      succeeded ? "SUCCEEDED" : "FAILED",
    );

    if (!succeeded) {
      // The charge genuinely failed (declined, no valid card, etc.) — the Booking stays PENDING
      // (never falsely marked NO_SHOW_CHARGED — see this module's own doc comment and
      // BookingLifecycleService's parallel cancellation-fee discipline). A human must waive or
      // cancel it manually; no automatic retry/dunning is built this batch.
      return "skipped_already_resolved";
    }

    await this.transitionViaOwner(booking, "NO_SHOW_CHARGED", {
      note: providerReference ? `Charged via ${providerReference}` : undefined,
    });
    return "charged";
  }

  /** Bounded, index-backed batch entry point — see BookingRepository.findManyOverdueNoShows's
   * own comment for why this never scans the full collection. */
  public async runOnce(batchSize: number): Promise<Record<NoShowResolutionOutcome, number>> {
    const now = new Date();
    const candidates = await this.bookingRepository.findManyOverdueNoShows(now, batchSize);

    const counts: Record<NoShowResolutionOutcome, number> = {
      charged: 0,
      waived_no_policy: 0,
      waived_no_charge_possible: 0,
      skipped_already_resolved: 0,
    };

    for (const candidate of candidates) {
      const outcome = await this.autoResolve(candidate._id);
      counts[outcome] += 1;
    }

    return counts;
  }

  private async transitionViaOwner(
    booking: BookingDocument,
    nextStatus: "NO_SHOW_WAIVED" | "NO_SHOW_CHARGED",
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

    return this.bookingRepository.casUpdate(booking.businessId, booking._id, ["PENDING"], {
      set: { status: nextStatus },
      pushEvent: event,
    });
  }
}
