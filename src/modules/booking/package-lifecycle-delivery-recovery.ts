import type { Types } from "mongoose";
import { BookingModel } from "./booking.model.js";
import { BookingCreationClaimModel } from "./booking-creation-claim.model.js";
import { verifyPackageBatchActivation } from "./package-batch-authority.js";
import { verifyBatchCompletion } from "./package-batch-completion.js";
import { batchConflict } from "./package-batch-contract.js";
import {
  CANCELLED_BOOKING_STATUSES,
  type PackageCalendarDeliveryPort,
  PackageCalendarWriteAuthorityUnavailableError,
  packageCalendarEventFor,
  reconcilePackageCalendarEvent,
} from "./package-calendar-delivery.js";
import {
  type PackageCheckoutCustomer,
  readPackageCheckoutCustomer,
} from "./package-checkout-customer-authority.js";
import {
  lifecycleIntentSchema,
  PackageLifecycleOperationModel,
  PackageLifecycleOperations,
  readLifecycleResult,
} from "./package-lifecycle-operation.js";

export type LifecycleExistingCalendarPort = {
  /** Read or reconcile a specifically persisted event. Never create or search by time. */
  reconcileExisting(input: {
    eventId: string;
    bookingId: string;
    businessId: string;
    lifecycleVersion: number;
    eventVersion: number;
    bookingStatus: string;
    startAt: Date;
    endAt: Date;
  }): Promise<
    | { outcome: "UNAVAILABLE" | "NOT_FOUND" }
    | {
        outcome: "MATCHED";
        eventId: string;
        bookingId: string;
        businessId: string;
        lifecycleVersion: number;
        eventVersion: number;
        bookingStatus: string;
        startAt: Date;
        endAt: Date;
      }
  >;
};
/** Unregistered, bounded offline consumer. Without a delivery port it only reconciles.
 * P2C: with an explicitly injected `delivery` port it applies the Booking's committed state:
 * UPCOMING → existing event at the task's times (never inserts: a missing id cannot prove
 * initial delivery never happened); cancellation statuses → event removed; other statuses → unchanged
 * (SKIPPED), matching ordinary Booking sync. Still activation-gated and never auto-registered. */
export class PackageLifecycleDeliveryRecovery {
  constructor(
    private readonly calendar: LifecycleExistingCalendarPort,
    private readonly clock: () => Date = () => new Date(),
    private readonly delivery?: PackageCalendarDeliveryPort,
  ) {}
  async runOnce(customer: PackageCheckoutCustomer, operationId: Types.ObjectId, limit = 20) {
    await verifyPackageBatchActivation();
    const actor = readPackageCheckoutCustomer(customer);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw batchConflict();
    const row = await PackageLifecycleOperationModel.findOne({
      _id: operationId,
      phase: "COMPLETE",
      "intent.customerUserId": actor.userId,
    })
      .read("primary")
      .maxTimeMS(2000);
    if (!row) throw batchConflict();
    const intent = lifecycleIntentSchema.parse(row.intent);
    const claim = await BookingCreationClaimModel.findOne({
      businessId: intent.businessId,
      actorUserId: actor.userId,
      "packageBatchPreparation.packageProgressId": intent.packageProgressId,
    })
      .read("primary")
      .maxTimeMS(2000);
    if (!claim) throw batchConflict();
    const purchase = await verifyBatchCompletion(claim);
    if (!purchase.preparation.businessClientId.equals(intent.businessClientId))
      throw batchConflict();
    const result = readLifecycleResult(row.result);
    const ops = new PackageLifecycleOperations();
    let processed = 0;
    for (let index = 0; index < result.tasks.length && processed < limit; index++) {
      const lease = await ops.claimDelivery(row._id, intent, index, this.clock());
      if (!lease) continue;
      const task = lease.task;
      const originalMember = purchase.preparation.members.some((m) =>
        m.bookingId.equals(task.bookingId),
      );
      const current = () =>
        BookingModel.findOne({
          _id: task.bookingId,
          businessId: intent.businessId,
          "customer.customerUserId": actor.userId,
          "customer.businessClientId": intent.businessClientId,
        })
          .read("primary")
          .maxTimeMS(2000);
      const matches = (booking: Awaited<ReturnType<typeof current>>) =>
        !!booking &&
        booking.eventHistory.length === task.eventVersion &&
        booking.status === task.bookingStatus &&
        booking.rescheduleHistory.length === task.lifecycleVersion &&
        booking.schedule.startAt.getTime() === task.startAt.getTime() &&
        booking.schedule.endAt.getTime() === task.endAt.getTime() &&
        booking.googleCalendarEventId === task.existingEventId;
      let state: "DONE" | "SKIPPED" | "RETRY" | "BLOCKED_UNVERIFIED" = "RETRY";
      try {
        const booking = await current();
        // REDEEM can create later members that are not in the original batch proof. Delivery
        // for those requires its own verified membership contract; do not infer it from status.
        if (this.delivery && !this.delivery.deliver && !originalMember)
          state = "BLOCKED_UNVERIFIED";
        else if (!matches(booking)) state = "SKIPPED";
        else if (this.delivery?.deliver && task.port === "CALENDAR") {
          state = await this.delivery.deliver({
            kind: "LIFECYCLE",
            operationId: String(row._id),
            index,
          });
        } else if (
          this.delivery &&
          booking &&
          task.port === "CALENDAR" &&
          task.eventVersion &&
          task.bookingStatus
        ) {
          const status = task.bookingStatus;
          if (status === "UPCOMING" || CANCELLED_BOOKING_STATUSES.has(status))
            state = await reconcilePackageCalendarEvent(this.delivery, {
              businessId: String(intent.businessId),
              bookingId: task.bookingId,
              recordedEventId: task.existingEventId,
              desired:
                status === "UPCOMING"
                  ? { kind: "PRESENT", ...packageCalendarEventFor(booking) }
                  : { kind: "ABSENT" },
            });
          else state = "SKIPPED";
          if (!matches(await current())) state = "SKIPPED";
        } else if (
          task.port !== "CALENDAR" ||
          !task.existingEventId ||
          !task.eventVersion ||
          !task.bookingStatus
        )
          state = "BLOCKED_UNVERIFIED";
        else {
          const expected = {
            eventId: task.existingEventId,
            bookingId: String(task.bookingId),
            businessId: String(intent.businessId),
            lifecycleVersion: task.lifecycleVersion,
            eventVersion: task.eventVersion,
            bookingStatus: task.bookingStatus,
            startAt: task.startAt,
            endAt: task.endAt,
          };
          const observed = await this.calendar.reconcileExisting(expected);
          if (!matches(await current())) state = "SKIPPED";
          else if (observed.outcome === "NOT_FOUND") state = "BLOCKED_UNVERIFIED";
          else if (
            observed.outcome === "MATCHED" &&
            observed.eventId === expected.eventId &&
            observed.bookingId === expected.bookingId &&
            observed.businessId === expected.businessId &&
            observed.lifecycleVersion === expected.lifecycleVersion &&
            observed.eventVersion === expected.eventVersion &&
            observed.bookingStatus === expected.bookingStatus &&
            observed.startAt.getTime() === expected.startAt.getTime() &&
            observed.endAt.getTime() === expected.endAt.getTime()
          )
            state = "DONE";
        }
      } catch (error) {
        if (error instanceof PackageCalendarWriteAuthorityUnavailableError)
          state = "BLOCKED_UNVERIFIED";
        /* Ambiguous read/reconciliation stays retriable; no purchase or refund effect. */
      }
      await ops.settleDelivery(row._id, index, lease.token, state, this.clock());
      processed++;
    }
    return { processed };
  }
}
