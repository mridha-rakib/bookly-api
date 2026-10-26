import type { ClientSession, Types } from "mongoose";
import { utcToBusinessLocalDate } from "../../common/time/business-clock.js";
import type { AvailabilityService } from "../availability/availability.service.js";
import { BookingSlotReservationModel } from "../booking-slot-reservation/booking-slot-reservation.model.js";
import { BookingSlotReservationClaimModel } from "../booking-slot-reservation/booking-slot-reservation-claim.model.js";
import { type BusinessDocument, BusinessModel } from "../business/business.model.js";
import { normalizeBusinessVisitType } from "../business/business.types.js";
import { BusinessTravelSettingsModel } from "../business-travel-settings/business-travel-settings.model.js";
import {
  acquirePackageEligibilityFence,
  requirePackageTransaction,
} from "../package-progress/package-eligibility.js";
import { resolvePackageFulfilmentEntitlement } from "../package-progress/package-fulfilment-entitlement.js";
import { PackageProgressModel } from "../package-progress/package-progress.model.js";
import {
  type PackageGroupSeat,
  readPackageGroupSeat,
  resolvePackageServiceEntitlement,
} from "../packages/package-service-entitlement.js";
import { type ServiceDocument, ServiceModel } from "../services/service.model.js";
import { StaffMembershipModel } from "../staff/staff.model.js";
import { BookingError } from "./booking.errors.js";
import type { BookingDocument, BookingFulfilment, BookingServiceLine } from "./booking.model.js";
import { BookingModel } from "./booking.model.js";
import { packageReservationPartySize } from "./booking-package-foundation.js";

const conflict = () => new BookingError("BOOKING_SCHEDULING_CHANGED", 409);

/** The parent transaction owns admission. Call before any reservation or credit write.
 * This is the same actual Business write used by Package dependency mutations. */
export async function acquireSchedulingAdmission(
  expected: BusinessDocument,
  session: ClientSession,
): Promise<BusinessDocument> {
  await acquirePackageEligibilityFence(expected._id, session);
  const current = await BusinessModel.findById(expected._id).session(session);
  if (
    !current ||
    current.timezone !== expected.timezone ||
    current.visitType !== expected.visitType
  )
    throw conflict();
  if (
    JSON.stringify(current.address) !== JSON.stringify(expected.address) ||
    JSON.stringify(current.location) !== JSON.stringify(expected.location)
  )
    throw conflict();
  return current;
}

export async function validateSchedulingLine(
  input: {
    business: BusinessDocument;
    serviceId: Types.ObjectId;
    staffMembershipId: Types.ObjectId;
    startAt: Date;
    endAt: Date;
    partySize: number;
    capacityMax: number;
    packageGroup?: PackageGroupSeat | undefined;
    allowInactive: boolean;
    expectedService?: ServiceDocument;
    existingAppointment?: boolean;
    legacyPurchase?: {
      progressId: Types.ObjectId;
      businessClientId: Types.ObjectId;
      customerUserId?: Types.ObjectId | undefined;
    };
    fulfilment: BookingFulfilment;
  },
  availability: AvailabilityService,
  session: ClientSession,
): Promise<void> {
  requirePackageTransaction(session);
  if (!input.existingAppointment && !["APPROVED", "WARNING"].includes(input.business.status))
    throw conflict();
  const service = await ServiceModel.findOne({
    _id: input.serviceId,
    businessId: input.business._id,
  }).session(session);
  const staff = await StaffMembershipModel.findOne({
    _id: input.staffMembershipId,
    businessId: input.business._id,
    removedAt: { $exists: false },
  }).session(session);
  if (
    !service ||
    !staff?.employmentActive ||
    !["STAFF", "SUPERVISOR"].includes(staff.role) ||
    !service.assignedStaffMembershipIds.some((id) => id.equals(staff._id))
  )
    throw new BookingError("BOOKING_STAFF_NOT_ELIGIBLE", 409);
  if (service.status !== "ACTIVE" && !(input.allowInactive && service.status === "INACTIVE"))
    throw conflict();
  if (input.packageGroup) {
    const seat = readPackageGroupSeat(input.packageGroup);
    const entitlement = resolvePackageServiceEntitlement(service);
    if (
      input.partySize !== seat.partySize ||
      input.capacityMax !== seat.capacityMax ||
      entitlement?.group?.capacityMax !== seat.capacityMax
    )
      throw conflict();
  }
  // A refreshed catalogue never silently changes already prepared money or timing.
  if (input.expectedService) {
    for (const field of [
      "pricingMode",
      "isPackageDeal",
      "fixedPricing",
      "hourlyPricing",
      "perPersonPricing",
      "packagePricing",
    ] as const) {
      if (JSON.stringify(service[field]) !== JSON.stringify(input.expectedService[field]))
        throw conflict();
    }
  }
  if (input.legacyPurchase) {
    // Purchased fulfilment is an existing entitlement, not a live-city override.
    // Reload the same owned legacy authority within this admission transaction.
    const progress = await PackageProgressModel.findOne({
      _id: input.legacyPurchase.progressId,
      businessId: input.business._id,
      businessClientId: input.legacyPurchase.businessClientId,
      ...(input.legacyPurchase.customerUserId
        ? { customerUserId: input.legacyPurchase.customerUserId }
        : {}),
      schemaVersion: { $exists: false },
    }).session(session);
    if (!progress?.serviceId.equals(service._id)) throw conflict();
    const origin = await BookingModel.findOne({
      _id: progress.originBookingId,
      businessId: input.business._id,
      "customer.businessClientId": progress.businessClientId,
    }).session(session);
    if (!origin) throw conflict();
    const entitlement = resolvePackageFulfilmentEntitlement(progress, origin);
    if (
      entitlement.mode !== input.fulfilment.mode ||
      (entitlement.mode === "TRAVEL_TO_CUSTOMER" &&
        !entitlement.travelCities?.some(
          (entry) => entry.city === input.fulfilment.travelAddress?.city,
        ))
    )
      throw conflict();
  } else if (normalizeBusinessVisitType(input.business.visitType) === "TRAVEL_TO_CUSTOMER") {
    const city = input.fulfilment.travelAddress?.city;
    const settings = await BusinessTravelSettingsModel.findOne({
      businessId: input.business._id,
    }).session(session);
    if (
      !city ||
      !service.servedCities.includes(city) ||
      !settings?.cities.some((entry) => entry.city === city && entry.active)
    )
      throw conflict();
  }
  const result = await availability.assertSlotIsBookable(
    {
      business: input.business,
      service,
      staffMembership: staff,
      startAt: input.startAt,
      endAt: input.endAt,
      partySize: input.partySize,
    },
    session,
  );
  if (result.capacityMax !== input.capacityMax) throw conflict();
}

/** Verify the exact original line interval, independently of ambiguous duration snapshots. */
export async function verifiedOccupiedMilliseconds(
  booking: BookingDocument,
  line: BookingServiceLine,
  session: ClientSession,
): Promise<{ duration: number; capacityMax: number }> {
  requirePackageTransaction(session);
  const scope = {
    businessId: booking.businessId,
    staffMembershipId: line.responsibleStaffMembershipId,
    occupancyDate: utcToBusinessLocalDate(booking.schedule.timezone, booking.schedule.startAt)
      .dateStr,
  };
  const day = await BookingSlotReservationModel.findOne(scope).session(session);
  const interval = day?.intervals.find((entry) => entry.reservationId.equals(line.reservationId));
  if (
    !interval ||
    day?.timezone !== booking.schedule.timezone ||
    !interval.serviceId.equals(line.serviceId) ||
    interval.startAt.getTime() !== booking.schedule.startAt.getTime()
  )
    throw conflict();
  if (line.reservationOperationKey) {
    const claim = await BookingSlotReservationClaimModel.findOne({
      idempotencyKey: line.reservationOperationKey,
      businessId: booking.businessId,
      staffMembershipId: line.responsibleStaffMembershipId,
      serviceId: line.serviceId,
      partySize: packageReservationPartySize(line),
    }).session(session);
    const intent = claim?.originalIntent;
    if (
      !claim ||
      !intent ||
      claim.occupancyDate !== scope.occupancyDate ||
      intent.timezone !== day.timezone ||
      intent.startAt.getTime() !== interval.startAt.getTime() ||
      intent.endAt.getTime() !== interval.endAt.getTime() ||
      intent.capacityMax !== interval.capacityMax ||
      (line.schedulingSnapshot?.group !== undefined &&
        line.schedulingSnapshot.group.capacityMax !== interval.capacityMax) ||
      claim.effect?.state !== "APPLIED" ||
      !claim.effect.actualReservationId.equals(interval.reservationId)
    )
      throw conflict();
  } else if (interval.capacityMax !== 1) {
    // Historical Group membership cannot be reconstructed from pooled usage.
    throw conflict();
  }
  const duration = interval.endAt.getTime() - interval.startAt.getTime();
  if (!Number.isSafeInteger(duration) || duration <= 0) throw conflict();
  return { duration, capacityMax: interval.capacityMax };
}
