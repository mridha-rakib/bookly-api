import { BookingModel } from "./booking.model.js";
import {
  claimBatchDeliveryTask,
  type PackageBatchScope,
  settleBatchDeliveryTask,
} from "./booking-creation-claim.model.js";
import { verifyPackageBatchActivation } from "./package-batch-authority.js";
import { readOwnedPackageBatchCompletion } from "./package-batch-completion.js";
import { batchConflict } from "./package-batch-contract.js";

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

/** Callable offline infrastructure only: no route/worker/container registration or Google
 * adapter. A missing existing event remains durably BLOCKED, never blindly recreated. */
export class PackageBatchDeliveryRecovery {
  public constructor(
    private readonly calendar: ExistingCalendarReconciliationPort,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async runOnce(scope: PackageBatchScope, limit = 20) {
    await verifyPackageBatchActivation();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw batchConflict();
    const complete = await readOwnedPackageBatchCompletion(scope);
    if (!complete) throw batchConflict();
    let processed = 0;
    for (const expected of complete.completion.tasks.filter((t) => t.port === "CALENDAR")) {
      if (processed >= limit) break;
      const task = await claimBatchDeliveryTask(scope, expected.key, this.clock());
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
        if (!matches(await current())) state = "SKIPPED";
        else {
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
      } catch {
        /* Failed/lost reconciliation response is retriable, never proof of a send. */
      }
      await settleBatchDeliveryTask(scope, task.key, task.token, state, this.clock());
      processed += 1;
    }
    return { processed };
  }
}
