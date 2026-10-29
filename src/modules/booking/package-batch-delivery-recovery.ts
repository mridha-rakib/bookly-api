import { BookingModel } from "./booking.model.js";
import {
  claimBatchDeliveryTask,
  type PackageBatchScope,
  settleBatchDeliveryTask,
} from "./booking-creation-claim.model.js";
import { verifyPackageBatchActivation } from "./package-batch-authority.js";
import { readOwnedPackageBatchCompletion } from "./package-batch-completion.js";
import { batchConflict } from "./package-batch-contract.js";
import {
  type PackageCalendarDeliveryPort,
  PackageCalendarWriteAuthorityUnavailableError,
  packageCalendarEventFor,
  reconcilePackageCalendarEvent,
} from "./package-calendar-delivery.js";

export type ExistingCalendarReconciliationPort = {
  /** Read/reconcile only. No create POST is authorized by this preparation infrastructure. */
  reconcileExisting(input: {
    lifecycleVersion: 0;
    eventId: string;
    bookingId: string;
    startAt: Date;
    endAt: Date;
  }): Promise<
    | { outcome: "NOT_FOUND" | "UNAVAILABLE" }
    | {
        outcome: "MATCHED";
        lifecycleVersion: 0;
        eventId: string;
        bookingId: string;
        startAt: Date;
        endAt: Date;
      }
  >;
};

/** Callable offline infrastructure only: no route/worker/container registration. Without a
 * delivery port a missing existing event remains durably BLOCKED, never blindly recreated.
 * P2C: with an explicitly injected `delivery` port (e.g. IntegrationService.packageCalendarPort)
 * the consumer reconciles the desired event with a deterministic id and read-back verification
 * (package-calendar-delivery.ts). Still activation-gated and never auto-registered. */
export class PackageBatchDeliveryRecovery {
  public constructor(
    private readonly calendar: ExistingCalendarReconciliationPort,
    private readonly clock: () => Date = () => new Date(),
    private readonly delivery?: PackageCalendarDeliveryPort,
  ) {}

  public async runOnce(scope: PackageBatchScope, limit = 20) {
    await verifyPackageBatchActivation();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw batchConflict();
    const complete = await readOwnedPackageBatchCompletion(scope);
    if (!complete) throw batchConflict();
    let processed = 0;
    for (const expected of complete.completion.tasks.filter((t) => t.port === "CALENDAR")) {
      if (processed >= limit) break;
      // A delivery port is not task-release authority. Preserve the older read-only
      // recovery contract, but never dispatch a blocked task through the P2C port.
      const task = await claimBatchDeliveryTask(scope, expected.key, this.clock(), !this.delivery);
      if (!task?.token) continue;
      const current = async () =>
        BookingModel.findOne({
          _id: task.bookingId,
          businessId: scope.businessId,
          "customer.customerUserId": complete.preparation.customerUserId,
          "customer.businessClientId": complete.preparation.businessClientId,
        })
          .read("primary")
          .maxTimeMS(2000);
      const matches = (booking: Awaited<ReturnType<typeof current>>) =>
        booking?.status === "UPCOMING" &&
        booking.rescheduleHistory.length === task.lifecycleVersion &&
        booking.schedule.startAt.getTime() === task.startAt.getTime() &&
        booking.schedule.endAt.getTime() === task.endAt.getTime();
      let state: "DONE" | "SKIPPED" | "RETRY" | "BLOCKED_UNVERIFIED" = "RETRY";
      try {
        const booking = await current();
        if (!matches(booking)) state = "SKIPPED";
        else if (this.delivery?.deliver) {
          state = await this.delivery.deliver({
            kind: "BATCH",
            claimId: String(complete.preparation.claimId),
            key: task.key,
          });
        } else if (this.delivery && booking) {
          state = await reconcilePackageCalendarEvent(this.delivery, {
            businessId: String(scope.businessId),
            bookingId: task.bookingId,
            recordedEventId: booking.googleCalendarEventId ?? undefined,
            allowInsert: task.attempts === 1,
            desired: { kind: "PRESENT", ...packageCalendarEventFor(booking) },
          });
          // Changed while delivering: the newer lifecycle task owns the final state.
          if (!matches(await current())) state = "SKIPPED";
        } else {
          const eventId = `b${task.bookingId.toHexString()}`;
          const result = await this.calendar.reconcileExisting({
            lifecycleVersion: task.lifecycleVersion,
            eventId,
            bookingId: String(task.bookingId),
            startAt: task.startAt,
            endAt: task.endAt,
          });
          if (!matches(await current())) state = "SKIPPED";
          else if (result.outcome === "NOT_FOUND") state = "BLOCKED_UNVERIFIED";
          else if (
            result.outcome === "MATCHED" &&
            result.eventId === eventId &&
            result.lifecycleVersion === task.lifecycleVersion &&
            result.bookingId === String(task.bookingId) &&
            result.startAt.getTime() === task.startAt.getTime() &&
            result.endAt.getTime() === task.endAt.getTime()
          )
            state = "DONE";
        }
      } catch (error) {
        if (error instanceof PackageCalendarWriteAuthorityUnavailableError)
          state = "BLOCKED_UNVERIFIED";
        /* Failed/lost reconciliation response is retriable, never proof of a send. */
      }
      await settleBatchDeliveryTask(scope, task.key, task.token, state, this.clock());
      processed += 1;
    }
    return { processed };
  }
}
