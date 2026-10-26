import { isDeepStrictEqual } from "node:util";
import type { ClientSession } from "mongoose";
import { utcToBusinessLocalDate } from "../../common/time/business-clock.js";
import { BookingSlotReservationModel } from "../booking-slot-reservation/booking-slot-reservation.model.js";
import { BookingSlotReservationClaimModel } from "../booking-slot-reservation/booking-slot-reservation-claim.model.js";
import { BusinessClientModel } from "../client/client.model.js";
import { PackageProgressV2Model } from "../package-progress/package-progress-v2.model.js";
import { packageProgressV2InputSchema } from "../package-progress/package-progress-v2.rules.js";
import { BookingModel } from "./booking.model.js";
import type { BookingCreationClaimDocument } from "./booking-creation-claim.model.js";
import {
  assertBatchMaterialization,
  assertBatchPreparation,
  batchConflict,
  canonicalPackageBatch,
  packageBatchOperation,
} from "./package-batch-contract.js";
import { validatePackageActivationDeadline } from "./package-checkout-validity.js";

/** Complete original membership, never a commercial result. Initial validation also proves
 * live application and initial counters; later reads allow actual lifecycle/accounting evolution. */
export async function verifyPackageBatchMembers(
  claim: BookingCreationClaimDocument,
  proofInput: unknown,
  session?: ClientSession,
  initial = false,
) {
  if (session && !session.inTransaction()) throw batchConflict();
  const p = assertBatchPreparation(claim, claim.packageBatchPreparation);
  const proof = assertBatchMaterialization(p, proofInput);
  const { quote: q, accepted } = canonicalPackageBatch(claim);
  const client = initial
    ? await BusinessClientModel.exists({
        _id: p.businessClientId,
        businessId: p.businessId,
        linkedUserId: p.customerUserId,
      })
        .session(session ?? null)
        .read("primary")
        .maxTimeMS(2000)
    : null;
  const bookings = await BookingModel.find({
    _id: { $in: p.members.map((m) => m.bookingId) },
    businessId: p.businessId,
    "customer.customerUserId": p.customerUserId,
    "customer.businessClientId": p.businessClientId,
  })
    .session(session ?? null)
    .read("primary")
    .maxTimeMS(2000)
    .lean();
  const progress = await PackageProgressV2Model.findOne({
    _id: p.packageProgressId,
    schemaVersion: 2,
    businessId: p.businessId,
    customerUserId: p.customerUserId,
    businessClientId: p.businessClientId,
    packageId: q.packageId,
    originBookingId: p.originBookingId,
  })
    .session(session ?? null)
    .read("primary")
    .maxTimeMS(2000);
  // Historical ownership is frozen on claim/Progress/nested Booking Customer roots. A later
  // CRM unlink cannot reassign those records or require a new initial admission.
  if ((initial && !client) || !progress || bookings.length !== p.members.length)
    throw batchConflict();
  if (
    initial &&
    (await BookingModel.countDocuments({
      "serviceLines.pricingInput.packageProgressId": p.packageProgressId,
    })
      .session(session ?? null)
      .read("primary")
      .maxTimeMS(2000)) !== p.members.length
  )
    throw batchConflict();
  const plain = progress.toObject();
  for (const key of ["createdAt", "updatedAt", "__v"]) Reflect.deleteProperty(plain, key);
  const valid = packageProgressV2InputSchema.parse(plain);
  if (
    valid.creditAccountingVersion !== 2 ||
    valid.purchaseSnapshot.packageRevision !== q.definitionRevision ||
    valid.purchaseSnapshot.bundlePriceCents !== q.financials.bundlePriceCents ||
    valid.items.length !== q.items.length ||
    !isDeepStrictEqual(valid.purchasedContract.acceptance, accepted.evidence) ||
    !valid.purchasedContract.activation.activationId.equals(p.activationId) ||
    !valid.purchasedContract.activation.activationEventId.equals(p.activationEventId) ||
    valid.purchasedContract.activation.purchasedAt.getTime() !== p.materializedAt.getTime() ||
    !isDeepStrictEqual(valid.purchasedContract.definition.contractTerms, q.definitionTerms) ||
    !isDeepStrictEqual(valid.purchasedContract.penalty, q.penalty) ||
    valid.purchasedContract.validity.mode !== q.validity.mode
  )
    throw batchConflict();
  const expiry = validatePackageActivationDeadline(
    q.validity,
    p.materializedAt,
    p.members.map((m) => m.startAt),
  );
  const validity = valid.purchasedContract.validity;
  if (
    validity.mode === "FINITE" &&
    (q.validity.mode !== "FINITE" ||
      validity.expiresAt.getTime() !== expiry?.getTime() ||
      validity.months !== q.validity.months ||
      validity.timezone !== q.validity.timezone ||
      !validity.calculation.provenanceRef.equals(q.validity.guaranteeProofRef) ||
      validity.activationWindow.notBefore.getTime() !== q.validity.activationNotBefore.getTime() ||
      validity.activationWindow.notAfterExclusive.getTime() !==
        q.validity.activationNotAfterExclusive.getTime() ||
      validity.expiryDisclosure.guaranteedNotBeforeExpiry.getTime() !==
        q.validity.guaranteedNotBeforeExpiry.getTime())
  )
    throw batchConflict();
  for (const item of q.items) {
    const stored = valid.items.find((i) => i.packageItemId.equals(item.packageItemId));
    if (
      !stored?.definitionItemId.equals(item.definitionItemId) ||
      !stored.serviceId.equals(item.serviceId) ||
      stored.totalSessions !== item.totalSessions ||
      stored.referenceUnitPriceCents !== item.referenceUnitPriceCents ||
      stored.penaltyBasisCents !== item.penaltyBasisCents ||
      stored.serviceSnapshot.durationMin !== item.baseDurationMin ||
      stored.serviceSnapshot.name !== item.serviceName ||
      stored.serviceSnapshot.pricingMode !== (item.group ? "PER_PERSON" : "FIXED") ||
      !isDeepStrictEqual(stored.travelCities, item.travelEntitlement?.cities) ||
      !isDeepStrictEqual(
        stored.serviceSnapshot.pricingMode === "PER_PERSON"
          ? stored.serviceSnapshot.group
          : undefined,
        item.group,
      )
    )
      throw batchConflict();
    if (
      initial &&
      (stored.remainingSessions !==
        item.totalSessions -
          p.members.filter((m) => m.packageItemId.equals(item.packageItemId)).length ||
        stored.completedSessions !== 0 ||
        stored.expiredSessions !== 0)
    )
      throw batchConflict();
  }
  if (
    initial &&
    (valid.sessions.length !== p.members.length ||
      valid.sessions.some((s) => s.status !== "SCHEDULED"))
  )
    throw batchConflict();
  for (const member of p.members) {
    const booking = bookings.find((b) => b._id.equals(member.bookingId));
    const effect = proof.members.find((m) => m.bookingId.equals(member.bookingId));
    const line = booking?.serviceLines[0];
    const attempt = valid.sessions.find((s) => s.bookingId.equals(member.bookingId));
    if (
      !booking ||
      !effect ||
      !line ||
      booking.serviceLines.length !== 1 ||
      booking.source !== "BOOKLY_MANAGED" ||
      !booking.createdBy.actorUserId.equals(p.customerUserId) ||
      booking.createdBy.actorRole !== "CUSTOMER" ||
      booking.reference !== member.reference ||
      !line.serviceId.equals(member.serviceId) ||
      (initial && !line.responsibleStaffMembershipId.equals(member.staffMembershipId)) ||
      !line.pricingInput.packageProgressId?.equals(p.packageProgressId) ||
      !line.pricingInput.packageItemId?.equals(member.packageItemId) ||
      !line.packageContext?.packageId.equals(q.packageId) ||
      !line.packageContext.definitionItemId.equals(member.definitionItemId) ||
      line.packageContext.role !== "PURCHASE" ||
      line.serviceSnapshot.pricingMode !== "PACKAGE" ||
      !isDeepStrictEqual(line.schedulingSnapshot?.group, member.group) ||
      !attempt?.packageItemId.equals(member.packageItemId) ||
      !attempt.serviceId.equals(member.serviceId)
    )
      throw batchConflict();
    // The original B3 effect is durable even after a legitimate move/release. Its terminal
    // state is allowed on replay; a current live interval is required only at materialization.
    const operation = await BookingSlotReservationClaimModel.findOne({
      idempotencyKey: effect.operationKey,
      businessId: p.businessId,
      staffMembershipId: member.staffMembershipId,
      serviceId: member.serviceId,
      occupancyDate: utcToBusinessLocalDate(q.businessTimezone, member.startAt).dateStr,
      partySize: 1,
    })
      .session(session ?? null)
      .read("primary")
      .maxTimeMS(2000);
    const intent = operation?.originalIntent;
    if (
      !intent ||
      intent.startAt.getTime() !== member.startAt.getTime() ||
      intent.endAt.getTime() !== member.endAt.getTime() ||
      intent.timezone !== q.businessTimezone ||
      intent.capacityMax !== (member.group?.capacityMax ?? 1) ||
      !isDeepStrictEqual(
        operation?.toObject().originalIntent?.packageOperation,
        packageBatchOperation(p, member),
      ) ||
      !operation?.effect ||
      (initial && operation.effect.state !== "APPLIED") ||
      !operation.effect.actualReservationId.equals(effect.reservationId)
    )
      throw batchConflict();
    if (!initial) {
      const moved =
        booking.schedule.startAt.getTime() !== member.startAt.getTime() ||
        booking.schedule.endAt.getTime() !== member.endAt.getTime() ||
        !line.responsibleStaffMembershipId.equals(member.staffMembershipId) ||
        line.reservationOperationKey !== effect.operationKey;
      if (moved) {
        if (
          operation.effect.state !== "RELEASED" ||
          booking.rescheduleHistory.length === 0 ||
          !line.reservationOperationKey
        )
          throw batchConflict();
        const replacement = await BookingSlotReservationClaimModel.findOne({
          idempotencyKey: line.reservationOperationKey,
          businessId: p.businessId,
          staffMembershipId: line.responsibleStaffMembershipId,
          serviceId: member.serviceId,
          partySize: 1,
        })
          .session(session ?? null)
          .read("primary")
          .maxTimeMS(2000);
        if (
          !replacement?.effect?.actualReservationId.equals(line.reservationId) ||
          replacement.originalIntent?.startAt.getTime() !== booking.schedule.startAt.getTime() ||
          replacement.originalIntent?.endAt.getTime() !== booking.schedule.endAt.getTime() ||
          replacement.originalIntent?.timezone !== booking.schedule.timezone
        )
          throw batchConflict();
      }
      continue;
    }
    const item = q.items.find((i) => i.packageItemId.equals(member.packageItemId));
    const appointment = q.appointments.find((a) => a.bookingId.equals(member.bookingId));
    const allocation = q.financials.appointments.find((a) => a.bookingId.equals(member.bookingId));
    if (
      !item ||
      !appointment ||
      !allocation ||
      (allocation.upfrontCents !== 0 && !claim.packageBatchFinance) ||
      line.serviceSnapshot.name !== item.serviceName ||
      line.serviceSnapshot.durationMin !== item.baseDurationMin ||
      line.packageContext.packageName !== q.packageName ||
      line.amountCents !== allocation.includedBaseCents ||
      !isDeepStrictEqual(line.addons, appointment.addons) ||
      (!claim.packageBatchCompletion &&
        (booking.financialContract ||
          booking.financials.depositCents !== 0 ||
          booking.financials.platformFeeCents !== 0)) ||
      booking.financials.servicesSubtotalCents !== allocation.includedBaseCents ||
      booking.financials.addonsSubtotalCents !== allocation.addonsCents ||
      booking.financials.travelFeeCents !== allocation.travelCents ||
      booking.financials.totalCents !==
        allocation.includedBaseCents + allocation.addonsCents + allocation.travelCents ||
      booking.financials.balanceDueCents !==
        allocation.includedBaseCents +
          allocation.addonsCents +
          allocation.travelCents -
          booking.financials.depositCents ||
      !isDeepStrictEqual(booking.cancellationPolicySnapshot ?? null, q.policy.cancellation) ||
      !isDeepStrictEqual(booking.noShowEligibilitySnapshot ?? null, q.policy.noShowWindow) ||
      !isDeepStrictEqual(line.schedulingSnapshot, {
        ...appointment.timing,
        ...(member.group ? { group: member.group } : {}),
      })
    )
      throw batchConflict();
    if (
      booking.status !== "UPCOMING" ||
      booking.schedule.startAt.getTime() !== member.startAt.getTime() ||
      booking.schedule.endAt.getTime() !== member.endAt.getTime() ||
      booking.schedule.timezone !== q.businessTimezone ||
      !line.reservationId.equals(effect.reservationId) ||
      line.reservationOperationKey !== effect.operationKey
    )
      throw batchConflict();
    const day = await BookingSlotReservationModel.findOne({
      businessId: p.businessId,
      staffMembershipId: member.staffMembershipId,
      occupancyDate: operation.occupancyDate,
    })
      .session(session ?? null)
      .read("primary")
      .maxTimeMS(2000);
    const interval = day?.intervals.find((i) => i.reservationId.equals(effect.reservationId));
    if (
      !interval?.serviceId.equals(member.serviceId) ||
      interval.startAt.getTime() !== member.startAt.getTime() ||
      interval.endAt.getTime() !== member.endAt.getTime() ||
      interval.capacityMax !== intent.capacityMax
    )
      throw batchConflict();
  }
  return {
    kind: "INTERNAL_MATERIALIZATION_ONLY" as const,
    commercialCompletion: "NOT_ESTABLISHED" as const,
    preparation: p,
    proof,
    bookings: p.members.map((m) => {
      const booking = bookings.find((b) => b._id.equals(m.bookingId));
      if (!booking) throw batchConflict();
      return booking;
    }),
    progress,
  };
}
