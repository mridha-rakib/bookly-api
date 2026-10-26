import { type ClientSession, Types } from "mongoose";
import { acquirePackageEligibilityFence } from "../package-progress/package-eligibility.js";
import { PackageProgressV2Model } from "../package-progress/package-progress-v2.model.js";
import { BookingModel } from "./booking.model.js";
import { buildCancellationOutcome } from "./booking-cancellation-classification.js";
import { BookingCreationClaimModel } from "./booking-creation-claim.model.js";
import { verifyPackageBatchActivation } from "./package-batch-authority.js";
import { verifyBatchCompletion } from "./package-batch-completion.js";
import { batchConflict, canonicalPackageBatch } from "./package-batch-contract.js";
import { hashCanonicalPackageCheckoutContent as digest } from "./package-checkout-binding.js";
import {
  type LifecycleAssessment,
  type LifecycleIntent,
  lifecycleAssessmentSchema,
  PackageLifecycleOperationModel,
} from "./package-lifecycle-operation.js";
/** Derives immutable assessment facts in the caller transaction. Only the receipt owner
 * appends them; no caller-supplied transition or authorization callback is accepted. */
export async function deriveLifecyclePenalty(
  id: Types.ObjectId,
  intent: LifecycleIntent,
  now: Date,
  session: ClientSession,
): Promise<{ assessment: LifecycleAssessment; existing: boolean }> {
  await verifyPackageBatchActivation();
  if (
    !session.inTransaction() ||
    !intent.bookingId ||
    !(
      intent.action === "NO_SHOW" ||
      (intent.action === "CANCEL" && intent.actorRole === "CUSTOMER")
    ) ||
    !Number.isFinite(now.getTime())
  )
    throw batchConflict();
  const bookingId = intent.bookingId;
  await acquirePackageEligibilityFence(intent.businessId, session);
  const op = await PackageLifecycleOperationModel.findById(id).session(session).orFail();
  if (digest(op.intent) !== digest(intent)) throw batchConflict();
  if (op.assessment) {
    return { assessment: lifecycleAssessmentSchema.parse(op.assessment), existing: true };
  }
  if (op.phase !== "PREPARED") throw batchConflict();
  const progress = await PackageProgressV2Model.findOne({
    _id: intent.packageProgressId,
    businessId: intent.businessId,
    customerUserId: intent.customerUserId,
    businessClientId: intent.businessClientId,
  })
    .session(session)
    .orFail();
  if (progress.creditAccountingVersion !== 2) throw batchConflict();
  const claim = await BookingCreationClaimModel.findOne({
    businessId: intent.businessId,
    actorUserId: intent.customerUserId,
    "packageBatchPreparation.packageProgressId": progress._id,
  })
    .session(session)
    .orFail();
  await verifyBatchCompletion(claim, session);
  const quote = canonicalPackageBatch(claim.toObject()).quote;
  const loadedBooking = await BookingModel.findOne({
    _id: bookingId,
    businessId: intent.businessId,
    "customer.customerUserId": intent.customerUserId,
    "customer.businessClientId": intent.businessClientId,
  })
    .session(session)
    .orFail();
  const booking = loadedBooking.toObject();
  const line = booking.serviceLines[0];
  const item = progress.items.find((i) =>
    i.packageItemId.equals(line?.pricingInput.packageItemId ?? new Types.ObjectId()),
  );
  if (
    !line ||
    !item ||
    booking.serviceLines.length !== 1 ||
    !line.pricingInput.packageProgressId?.equals(progress._id) ||
    !progress.sessions.some(
      (a) =>
        a.bookingId.equals(booking._id) &&
        a.packageItemId.equals(item.packageItemId) &&
        a.status === "SCHEDULED",
    ) ||
    digest(booking.cancellationPolicySnapshot ?? null) !== digest(quote.policy.cancellation ?? null)
  )
    throw batchConflict();
  let requested = 0;
  let status: "UPCOMING" | "PENDING";
  if (intent.action === "CANCEL") {
    if (booking.status !== "UPCOMING") throw batchConflict();
    status = "UPCOMING";
    const classified = buildCancellationOutcome({
      scheduledStartAt: booking.schedule.startAt,
      now,
      policySnapshot: booking.cancellationPolicySnapshot,
      eligiblePlatformFeeBasisCents: item.penaltyBasisCents,
      depositAlreadyPaidCents: 0,
    });
    requested = classified.feeMode === "PERCENTAGE" ? classified.cancellationFeeCents : 0;
  } else {
    if (
      booking.status !== "PENDING" ||
      !booking.noShowDeadlineAt ||
      now < booking.noShowDeadlineAt ||
      intent.actorRole === "CUSTOMER"
    )
      throw batchConflict();
    status = "PENDING";
    const pct = booking.cancellationPolicySnapshot?.noShowPercentage ?? 0;
    requested = Number((BigInt(item.penaltyBasisCents) * BigInt(pct) + 50n) / 100n);
  }
  const all = await PackageLifecycleOperationModel.find({
    "intent.businessId": intent.businessId,
    "intent.packageProgressId": progress._id,
    "assessment.kind": { $in: ["CANCELLATION_FEE", "NO_SHOW_FEE"] },
  })
    .session(session)
    .maxTimeMS(2000);
  let spent = 0n;
  for (const other of all) {
    const a = lifecycleAssessmentSchema.parse(other.assessment);
    if (String(other.intent.bookingId) === String(booking._id) && a.state !== "RELEASED")
      throw batchConflict();
    if (a.state !== "RELEASED") spent += BigInt(a.amountCents);
  }
  const contract = progress.purchasedContract.penalty;
  const remaining = BigInt(contract.lifetimeCapCents) - spent;
  if (remaining < 0n) throw batchConflict();
  const amount = Number(
    [BigInt(requested), BigInt(contract.appointmentCapCents), remaining].reduce((a, b) =>
      a < b ? a : b,
    ),
  );
  const assessment = lifecycleAssessmentSchema.parse({
    version: 1,
    kind: intent.action === "CANCEL" ? "CANCELLATION_FEE" : "NO_SHOW_FEE",
    basisCents: item.penaltyBasisCents,
    requestedCents: requested,
    amountCents: amount,
    lifetimeCapCents: contract.lifetimeCapCents,
    assessedAt: now,
    bookingStartAt: booking.schedule.startAt,
    bookingEndAt: booking.schedule.endAt,
    timezone: booking.schedule.timezone,
    serviceId: line.serviceId,
    staffMembershipId: line.responsibleStaffMembershipId,
    bookingStatus: status,
    eventVersion: booking.eventHistory.length,
    state: "RESERVED",
  });
  return { assessment, existing: false };
}
