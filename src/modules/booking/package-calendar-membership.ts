import { Types } from "mongoose";
import { type BookingDocument, BookingModel } from "./booking.model.js";
import {
  type BookingCreationClaimDocument,
  BookingCreationClaimModel,
} from "./booking-creation-claim.model.js";
import { verifyPackageBatchActivation } from "./package-batch-authority.js";
import { verifyBatchCompletion } from "./package-batch-completion.js";
import type { BatchDeliveryTask } from "./package-batch-completion-contract.js";
import { batchConflict } from "./package-batch-contract.js";
import {
  type CalendarTaskReference,
  calendarTaskReferenceSchema,
} from "./package-calendar-contract.js";
import { PackageLifecycleService } from "./package-lifecycle.service.js";
import {
  type LifecycleIntent,
  type LifecycleResult,
  lifecycleIntentSchema,
  PackageLifecycleOperationModel,
  readLifecycleResult,
} from "./package-lifecycle-operation.js";

/** Reads the existing financial/completion authorities, including the complete paid-redemption
 * result verifier. Neither UPCOMING nor a Progress session alone constitutes membership. */
export async function readCalendarTaskAuthority(input: CalendarTaskReference) {
  await verifyPackageBatchActivation();
  const reference = calendarTaskReferenceSchema.parse(input);
  let claim: BookingCreationClaimDocument | null;
  let task: BatchDeliveryTask | LifecycleResult["tasks"][number] | undefined;
  let intent: LifecycleIntent | undefined;
  if (reference.kind === "BATCH") {
    claim = await BookingCreationClaimModel.findById(reference.claimId)
      .read("primary")
      .maxTimeMS(2000);
    task = claim?.packageBatchDelivery?.find((entry) => entry.key === reference.key);
  } else {
    const operation = await PackageLifecycleOperationModel.findOne({
      _id: reference.operationId,
      phase: "COMPLETE",
    })
      .read("primary")
      .maxTimeMS(2000);
    if (!operation) throw batchConflict();
    intent = lifecycleIntentSchema.parse(operation.intent);
    const result = readLifecycleResult(operation.result);
    const candidate = result.tasks[reference.index];
    if (!candidate || candidate.eventVersion === undefined || candidate.bookingStatus === undefined)
      throw batchConflict();
    task = candidate;
    claim = await BookingCreationClaimModel.findOne({
      businessId: intent.businessId,
      actorUserId: intent.customerUserId,
      "packageBatchPreparation.packageProgressId": intent.packageProgressId,
    })
      .read("primary")
      .maxTimeMS(2000);
  }
  if (!claim || !task || task.port !== "CALENDAR") throw batchConflict();
  const purchase = await verifyBatchCompletion(claim);
  const p = purchase.preparation;
  if (
    intent &&
    (!intent.businessClientId.equals(p.businessClientId) ||
      !intent.customerUserId.equals(p.customerUserId) ||
      !intent.businessId.equals(p.businessId))
  )
    throw batchConflict();
  const booking = await BookingModel.findOne({
    _id: task.bookingId,
    businessId: p.businessId,
    "customer.customerUserId": p.customerUserId,
    "customer.businessClientId": p.businessClientId,
  })
    .select("+packageCalendarDelivery")
    .read("primary")
    .maxTimeMS(2000)
    .lean<BookingDocument>();
  if (!booking) throw batchConflict();
  const original = p.members.some((member) => member.bookingId.equals(booking._id));
  if (!original) {
    const birth = await PackageLifecycleOperationModel.findOne({
      phase: "COMPLETE",
      bookingId: booking._id,
      "intent.action": "REDEEM",
      "intent.businessId": p.businessId,
      "intent.customerUserId": p.customerUserId,
      "intent.businessClientId": p.businessClientId,
      "intent.packageProgressId": p.packageProgressId,
    })
      .read("primary")
      .maxTimeMS(2000);
    if (!birth) throw batchConflict();
    const birthIntent = lifecycleIntentSchema.parse(birth.intent);
    const verified = await PackageLifecycleService.verifyCalendarResult(birth._id, birthIntent);
    const line = booking.serviceLines[0];
    if (
      !verified?.booking?._id.equals(booking._id) ||
      !birthIntent.packageItemId?.equals(
        line?.pricingInput.packageItemId ?? new Types.ObjectId(),
      ) ||
      !line?.pricingInput.packageProgressId?.equals(p.packageProgressId) ||
      line.packageContext?.role !== "REDEMPTION"
    )
      throw batchConflict();
  }
  if (reference.kind === "LIFECYCLE" && intent) {
    const verified = await PackageLifecycleService.verifyCalendarResult(
      new Types.ObjectId(reference.operationId),
      intent,
    );
    if (!verified?.booking?._id.equals(booking._id)) throw batchConflict();
  }
  const current =
    booking.rescheduleHistory.length === task.lifecycleVersion &&
    booking.schedule.startAt.getTime() === task.startAt.getTime() &&
    booking.schedule.endAt.getTime() === task.endAt.getTime() &&
    (reference.kind === "BATCH"
      ? booking.status === "UPCOMING"
      : "eventVersion" in task &&
        booking.eventHistory.length === task.eventVersion &&
        "bookingStatus" in task &&
        booking.status === task.bookingStatus);
  return { reference, task, booking, purchase, claimId: claim._id, current };
}
