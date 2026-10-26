import { type ClientSession, Types } from "mongoose";
import { AppointmentReminderModel } from "../appointment-reminder/appointment-reminder.model.js";
import { BookingFinancialTransactionModel } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import { BookingSlotReservationClaimModel } from "../booking-slot-reservation/booking-slot-reservation-claim.model.js";
import { EmailOutboxModel } from "../email-outbox/email-outbox.model.js";
import type { PaymentAttemptDocument } from "../payment/payment-attempt.model.js";
import { isProviderCreationClosed } from "../payment/payment-attempt.model.js";
import type { CreatePaymentAttemptInput } from "../payment/payment-attempt.repository.js";
import {
  assertLifecyclePaymentBinding,
  hasLifecyclePaymentEvidence,
  type LifecyclePaymentBinding,
} from "../payment/payment-lifecycle-binding.js";
import { BookingModel } from "./booking.model.js";
import { buildCancellationOutcome } from "./booking-cancellation-classification.js";
import { BookingCreationClaimModel } from "./booking-creation-claim.model.js";
import { verifyBatchCompletion } from "./package-batch-completion.js";
import { batchConflict } from "./package-batch-contract.js";
import { hashCanonicalPackageCheckoutContent as digest } from "./package-checkout-binding.js";
import {
  lifecycleAssessmentSchema,
  lifecycleIntentSchema,
  PackageLifecycleOperationModel,
  readLifecycleResult,
} from "./package-lifecycle-operation.js";
import {
  lifecycleSessionAcceptanceSchema,
  lifecycleSessionQuoteSchema,
} from "./package-lifecycle-session-terms.js";

async function canonical(binding: LifecyclePaymentBinding, session?: ClientSession) {
  const row = await PackageLifecycleOperationModel.findById(new Types.ObjectId(binding.operationId))
    .session(session ?? null)
    .read("primary")
    .maxTimeMS(2000)
    .orFail();
  const intent = lifecycleIntentSchema.parse(row.intent),
    a = lifecycleAssessmentSchema.parse(row.assessment);
  if (
    digest(intent) !== binding.intentHash ||
    String(intent.businessId) !== binding.businessId ||
    String(intent.businessClientId) !== binding.businessClientId ||
    String(intent.customerUserId) !== binding.customerUserId ||
    String(intent.packageProgressId) !== binding.packageProgressId ||
    String(intent.action === "REDEEM" ? row.bookingId : intent.bookingId) !== binding.bookingId ||
    a.amountCents !== binding.amountCents ||
    a.kind !== binding.kind
  )
    throw batchConflict();
  if (a.kind === "SESSION_DUES") {
    const q = lifecycleSessionQuoteSchema.parse(row.sessionQuote),
      accepted = lifecycleSessionAcceptanceSchema.parse(row.sessionAcceptance);
    if (
      intent.action !== "REDEEM" ||
      !intent.dues ||
      q.terms.paymentMethod !== "ONLINE" ||
      q.terms.intentHash !== digest(intent) ||
      String(q.terms.bookingId) !== binding.bookingId ||
      q.termsHash !== digest(q.terms) ||
      q.disclosureHash !== digest(q.disclosure) ||
      accepted.termsHash !== q.termsHash ||
      accepted.disclosureHash !== q.disclosureHash ||
      !accepted.quoteId.equals(q.quoteId) ||
      !accepted.customerUserId.equals(intent.customerUserId) ||
      accepted.sessionFamilyId !== q.sessionFamilyId ||
      a.amountCents !== q.terms.totalCents ||
      a.basisCents !== 0 ||
      a.requestedCents !== q.terms.totalCents ||
      a.lifetimeCapCents !== 0 ||
      a.bookingStartAt.getTime() !== q.terms.startAt.getTime() ||
      a.bookingEndAt.getTime() !== q.terms.endAt.getTime() ||
      a.timezone !== q.terms.timezone ||
      !a.serviceId.equals(q.terms.serviceId) ||
      !a.staffMembershipId.equals(q.terms.staffMembershipId)
    )
      throw batchConflict();
  }
  const claim = await BookingCreationClaimModel.findOne({
    businessId: intent.businessId,
    actorUserId: intent.customerUserId,
    "packageBatchPreparation.packageProgressId": intent.packageProgressId,
  })
    .session(session ?? null)
    .read("primary")
    .maxTimeMS(2000)
    .orFail();
  const purchase = await verifyBatchCompletion(claim, session);
  if (!purchase.preparation.businessClientId.equals(intent.businessClientId)) throw batchConflict();
  if (a.kind !== "SESSION_DUES") {
    const booking = await BookingModel.findOne({
      _id: new Types.ObjectId(binding.bookingId),
      businessId: intent.businessId,
      "customer.customerUserId": intent.customerUserId,
      "customer.businessClientId": intent.businessClientId,
    })
      .session(session ?? null)
      .read("primary")
      .maxTimeMS(2000)
      .orFail();
    const item = purchase.progress.items.find((i) =>
      i.packageItemId.equals(
        booking.serviceLines[0]?.pricingInput.packageItemId ?? new Types.ObjectId(),
      ),
    );
    if (
      purchase.progress.creditAccountingVersion !== 2 ||
      !item ||
      !("penaltyBasisCents" in item) ||
      a.basisCents !== item.penaltyBasisCents ||
      a.lifetimeCapCents !== purchase.progress.purchasedContract.penalty.lifetimeCapCents
    )
      throw batchConflict();
    const line = booking.serviceLines[0];
    const knownSchedule =
      (booking.schedule.startAt.getTime() === a.bookingStartAt.getTime() &&
        booking.schedule.endAt.getTime() === a.bookingEndAt.getTime()) ||
      booking.rescheduleHistory.some(
        (h) =>
          h.previousStart.getTime() === a.bookingStartAt.getTime() &&
          h.previousEnd.getTime() === a.bookingEndAt.getTime(),
      );
    if (
      !line ||
      !knownSchedule ||
      booking.schedule.timezone !== a.timezone ||
      !a.serviceId.equals(item.serviceId) ||
      !a.staffMembershipId.equals(line.responsibleStaffMembershipId)
    )
      throw batchConflict();
    let requested: number;
    if (a.kind === "CANCELLATION_FEE") {
      if (intent.action !== "CANCEL" || intent.actorRole !== "CUSTOMER") throw batchConflict();
      const classified = buildCancellationOutcome({
        scheduledStartAt: a.bookingStartAt,
        now: a.assessedAt,
        policySnapshot: booking.toObject().cancellationPolicySnapshot,
        eligiblePlatformFeeBasisCents: item.penaltyBasisCents,
        depositAlreadyPaidCents: 0,
      });
      requested = classified.feeMode === "PERCENTAGE" ? classified.cancellationFeeCents : 0;
    } else {
      if (
        intent.action !== "NO_SHOW" ||
        intent.actorRole === "CUSTOMER" ||
        !booking.noShowDeadlineAt ||
        a.assessedAt < booking.noShowDeadlineAt
      )
        throw batchConflict();
      requested = Number(
        (BigInt(item.penaltyBasisCents) *
          BigInt(booking.cancellationPolicySnapshot?.noShowPercentage ?? 0) +
          50n) /
          100n,
      );
    }
    if (
      requested !== a.requestedCents ||
      a.amountCents >
        Math.min(
          requested,
          purchase.progress.purchasedContract.penalty.appointmentCapCents,
          a.lifetimeCapCents,
        )
    )
      throw batchConflict();
    const budget = await PackageLifecycleOperationModel.find({
      "intent.businessId": intent.businessId,
      "intent.packageProgressId": intent.packageProgressId,
      "assessment.kind": { $in: ["CANCELLATION_FEE", "NO_SHOW_FEE"] },
    })
      .session(session ?? null)
      .read("primary")
      .maxTimeMS(2000);
    const held = budget.reduce((sum, op) => {
      const evidence = lifecycleAssessmentSchema.parse(op.assessment);
      return sum + (evidence.state === "RELEASED" ? 0n : BigInt(evidence.amountCents));
    }, 0n);
    if (held > BigInt(a.lifetimeCapCents)) throw batchConflict();
  }

  return { row, intent, assessment: a, progress: purchase.progress };
}
export async function validateLifecyclePaymentCreation(
  input: CreatePaymentAttemptInput,
  session?: ClientSession,
) {
  const binding = assertLifecyclePaymentBinding(input);
  const authority = await canonical(binding, session);
  if (authority.row.phase !== "PREPARED" || authority.assessment.state !== "RESERVED")
    throw batchConflict();
}
export async function inspectLifecyclePaymentAuthority(
  attempt: PaymentAttemptDocument,
  session?: ClientSession,
) {
  if (!hasLifecyclePaymentEvidence(attempt)) return null;
  const binding = assertLifecyclePaymentBinding(attempt);
  const authority = await canonical(binding, session);
  if (authority.assessment.state === "RELEASED") {
    if (
      authority.row.phase !== "FAILED_FINAL" ||
      attempt.persistenceStatus !== "NOT_STARTED" ||
      attempt.compensationStatus !== "NOT_REQUIRED" ||
      !(attempt.providerStatus === "CANCELED" || isProviderCreationClosed(attempt))
    )
      throw batchConflict();
    return { kind: "NON_COLLECTION" as const, binding, ...authority };
  }
  if (authority.row.phase !== "COMPLETE")
    return { kind: "UNRESOLVED" as const, binding, ...authority };
  const result = readLifecycleResult(authority.row.result),
    money = result.money;
  if (
    !money?.attemptId.equals(attempt._id) ||
    money.paymentIntentId !== attempt.providerPaymentIntentId ||
    money.amountCents !== binding.amountCents
  )
    throw batchConflict();
  const ledger = await BookingFinancialTransactionModel.findOne({
    _id: money.ledgerId,
    businessId: authority.intent.businessId,
    businessClientId: authority.intent.businessClientId,
    customerUserId: authority.intent.customerUserId,
    bookingId: new Types.ObjectId(binding.bookingId),
    amountCents: binding.amountCents,
    currency: "EUR",
    type: authority.assessment.kind === "SESSION_DUES" ? "PAYMENT" : authority.assessment.kind,
    status: "SUCCEEDED",
    direction: "DEBIT",
    providerReference: money.paymentIntentId,
    idempotencyKey: `package-session-charge:${binding.operationId}`,
  })
    .session(session ?? null)
    .read("primary")
    .maxTimeMS(2000);
  if (
    !ledger ||
    !result.bookingId ||
    String(result.bookingId) !== binding.bookingId ||
    attempt.providerStatus !== "SUCCEEDED"
  )
    throw batchConflict();
  const booking = await BookingModel.findOne({
    _id: result.bookingId,
    businessId: authority.intent.businessId,
    "customer.customerUserId": authority.intent.customerUserId,
    "customer.businessClientId": authority.intent.businessClientId,
  })
    .session(session ?? null)
    .read("primary")
    .maxTimeMS(2000)
    .orFail();
  const line = booking.serviceLines[0],
    allocation = authority.progress.sessions.find((a) => a.bookingId.equals(booking._id));
  if (
    !line ||
    booking.serviceLines.length !== 1 ||
    !line.pricingInput.packageProgressId?.equals(authority.progress._id) ||
    !allocation ||
    !allocation.packageItemId.equals(line.pricingInput.packageItemId ?? new Types.ObjectId()) ||
    !allocation.serviceId.equals(line.serviceId)
  )
    throw batchConflict();
  const expected =
    booking.status === "UPCOMING" || booking.status === "PENDING"
      ? "SCHEDULED"
      : booking.status === "COMPLETED"
        ? "COMPLETED"
        : ["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_BUSINESS", "NO_SHOW_CANCELLED"].includes(
              booking.status,
            )
          ? "CANCELLED"
          : "FORFEITED";
  if (allocation.status !== expected) throw batchConflict();
  if (result.reservationKey) {
    if (!result.staffMembershipId) throw batchConflict();
    const effect = await BookingSlotReservationClaimModel.findOne({
      idempotencyKey: result.reservationKey,
      businessId: authority.intent.businessId,
      serviceId: line.serviceId,
      staffMembershipId: result.staffMembershipId,
      partySize: 1,
    })
      .session(session ?? null)
      .read("primary")
      .maxTimeMS(2000);
    if (
      !effect?.effect ||
      !result.reservationId ||
      !effect.effect.actualReservationId.equals(result.reservationId) ||
      effect.originalIntent?.startAt.getTime() !==
        (result.startAt ?? authority.intent.startAt)?.getTime() ||
      effect.originalIntent?.endAt.getTime() !== result.endAt?.getTime() ||
      effect.originalIntent?.capacityMax !== (line.schedulingSnapshot?.group?.capacityMax ?? 1) ||
      !["APPLIED", "RELEASED"].includes(effect.effect.state) ||
      (authority.intent.action === "CANCEL" && effect.effect.state !== "RELEASED")
    )
      throw batchConflict();
  }
  for (const email of result.emails)
    if (
      !(await EmailOutboxModel.exists({
        _id: email,
        eventKey: `PACKAGE_LIFECYCLE:${authority.intent.key}`,
      })
        .session(session ?? null)
        .read("primary")
        .maxTimeMS(2000))
    )
      throw batchConflict();
  for (const reminder of result.reminders)
    if (
      !(await AppointmentReminderModel.exists({
        _id: reminder,
        bookingId: booking._id,
        businessId: authority.intent.businessId,
        customerUserId: authority.intent.customerUserId,
      })
        .session(session ?? null)
        .read("primary")
        .maxTimeMS(2000))
    )
      throw batchConflict();
  return { kind: "COMPLETE" as const, binding, result, ...authority };
}
