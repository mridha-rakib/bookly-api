import { Types } from "mongoose";

import { StaffError } from "../staff/staff.errors.js";
import type { StaffMembershipDocument } from "../staff/staff.model.js";
import { StaffRepository } from "../staff/staff.repository.js";
import { BookingError } from "./booking.errors.js";
import type { BookingDocument } from "./booking.model.js";
import { BookingRepository } from "./booking.repository.js";
import type { BookingStatus } from "./booking.types.js";
import { bookingDeliveryPurchaseVerified } from "./booking-email-delivery-eligibility.js";

/**
 * P4C-1 — Owner decision D-S1: a Staff member may READ their own currently assigned
 * appointments through their authenticated, currently active StaffMembership. Nothing else.
 *
 * Authority, on every request:
 *  - the authenticated user (live sid-bound session, ACTIVE user, role STAFF — route guards);
 *  - their ONE non-removed StaffMembership (partial-unique on userId), resolved from the
 *    session user id, never from a posted id; it must be `employmentActive`, role STAFF and in
 *    the requested Business, else 404 (no enumeration);
 *  - a Booking query restricted to that Business AND to the membership on a service line
 *    (`responsibleStaffMembershipId`, the canonical assignment field). A reassigned line, an
 *    ended membership or another Business can therefore never match. No historical access.
 *  - First-Class Package Bookings are shown only with genuine purchase proof (same check the
 *    email/SMS delivery guards use); legacy/ordinary Bookings keep their existing visibility.
 *
 * The DTO mirrors the established staff-facing disclosure (assigned-staff notification emails):
 * reference, schedule, the Staff member's own services, the Customer's display name, status.
 * No contact details, notes, prices, payment, refund, Package balance or other
 * Staff members' data. No write path exists here.
 * D-S2 adds a minimal travel destination to eligible details only, never the list.
 */

export type StaffAppointmentDto = {
  id: string;
  reference: string;
  businessId: string;
  status: BookingStatus;
  schedule: { startAt: string; endAt: string; timezone: string };
  fulfilment:
    | {
        mode: "AT_BUSINESS_LOCATION";
        businessLocation?: { city: string; area: string; streetName: string; streetNumber: string };
      }
    | { mode: "TRAVEL_TO_CUSTOMER" };
  customer: { displayName: string };
  /** Only the service lines assigned to the requesting Staff member. */
  services: Array<{
    serviceName: string;
    durationMin: number;
    occupiedDurationMin?: number;
    addonNames: string[];
    isPackageSession: boolean;
  }>;
  /** True when other professionals also have lines on this Booking (no identities disclosed). */
  sharedWithOtherProfessionals: boolean;
};

export type StaffAppointmentPage = {
  appointments: StaffAppointmentDto[];
  page: number;
  limit: number;
  hasMore: boolean;
  range: { fromDate: string; toDate: string };
};

export type StaffTravelAddress = {
  city: string;
  area: string;
  streetName: string;
  streetNumber: string;
  floorUnit?: string;
  aptRoom?: string;
};
export type StaffAppointmentDetailDto = StaffAppointmentDto & {
  travelAddress?: StaffTravelAddress;
};

export type StaffAppointmentListQuery = {
  page: number;
  limit: number;
  status?: BookingStatus[] | undefined;
  fromDate: Date;
  toDate: Date;
};

export function toStaffAppointmentDto(
  booking: BookingDocument,
  membershipId: Types.ObjectId,
): StaffAppointmentDto {
  const mine = booking.serviceLines.filter((line) =>
    membershipId.equals(line.responsibleStaffMembershipId),
  );
  const location = booking.fulfilment?.businessLocation;
  return {
    id: String(booking._id),
    reference: booking.reference,
    businessId: String(booking.businessId),
    status: booking.status,
    schedule: {
      startAt: booking.schedule.startAt.toISOString(),
      endAt: booking.schedule.endAt.toISOString(),
      timezone: booking.schedule.timezone,
    },
    fulfilment:
      booking.fulfilment?.mode === "AT_BUSINESS_LOCATION"
        ? {
            mode: "AT_BUSINESS_LOCATION",
            ...(location
              ? {
                  businessLocation: {
                    city: location.city,
                    area: location.area,
                    streetName: location.streetName,
                    streetNumber: location.streetNumber,
                  },
                }
              : {}),
          }
        : { mode: "TRAVEL_TO_CUSTOMER" },
    customer: {
      displayName: [booking.customer.contact.firstName, booking.customer.contact.lastName]
        .filter(Boolean)
        .join(" "),
    },
    services: mine.map((line) => ({
      serviceName: line.serviceSnapshot.name,
      durationMin: line.schedulingSnapshot?.baseDurationMin ?? line.serviceSnapshot.durationMin,
      ...(line.schedulingSnapshot
        ? { occupiedDurationMin: line.schedulingSnapshot.occupiedDurationMin }
        : {}),
      addonNames: line.addons.map((addon) => addon.name),
      isPackageSession: Boolean(
        line.pricingInput?.packageProgressId ||
          line.pricingInput?.packageItemId ||
          line.packageContext,
      ),
    })),
    sharedWithOtherProfessionals: mine.length < booking.serviceLines.length,
  };
}

export class StaffAppointmentService {
  public constructor(
    private readonly staffRepository: Pick<
      StaffRepository,
      "findActiveByUserId"
    > = new StaffRepository(),
    private readonly bookingRepository: Pick<
      BookingRepository,
      | "listAssignedToStaffMembership"
      | "findAssignedToStaffMembership"
      | "findStaffTravelDestination"
    > = new BookingRepository(),
    private readonly purchaseVerified: (
      booking: BookingDocument,
    ) => Promise<boolean> = bookingDeliveryPurchaseVerified,
  ) {}

  private async requireOwnStaffMembership(
    actorUserId: string,
    businessId: string,
  ): Promise<StaffMembershipDocument> {
    if (!Types.ObjectId.isValid(actorUserId) || !Types.ObjectId.isValid(businessId))
      throw new StaffError("STAFF_NOT_FOUND", 404);
    const membership = await this.staffRepository.findActiveByUserId(actorUserId);
    if (
      !membership ||
      !membership.businessId.equals(businessId) ||
      !membership.userId.equals(actorUserId) ||
      membership.removedAt ||
      !membership.employmentActive ||
      membership.role !== "STAFF"
    )
      throw new StaffError("STAFF_NOT_FOUND", 404);
    return membership;
  }

  public async listMyAppointments(
    actorUserId: string,
    businessId: string,
    query: StaffAppointmentListQuery,
  ): Promise<StaffAppointmentPage> {
    const membership = await this.requireOwnStaffMembership(actorUserId, businessId);
    const { bookings, hasMore } = await this.bookingRepository.listAssignedToStaffMembership(
      membership.businessId,
      membership._id,
      { status: query.status, fromDate: query.fromDate, toDate: query.toDate },
      { page: query.page, limit: query.limit },
    );
    const visible: StaffAppointmentDto[] = [];
    for (const booking of bookings)
      if (await this.purchaseVerified(booking))
        visible.push(toStaffAppointmentDto(booking, membership._id));
    return {
      appointments: visible,
      page: query.page,
      limit: query.limit,
      hasMore,
      range: { fromDate: query.fromDate.toISOString(), toDate: query.toDate.toISOString() },
    };
  }

  public async getMyAppointment(
    actorUserId: string,
    businessId: string,
    bookingId: string,
  ): Promise<StaffAppointmentDetailDto> {
    const membership = await this.requireOwnStaffMembership(actorUserId, businessId);
    if (!Types.ObjectId.isValid(bookingId)) throw new BookingError("BOOKING_NOT_FOUND", 404);
    const booking = await this.bookingRepository.findAssignedToStaffMembership(
      membership.businessId,
      membership._id,
      bookingId,
    );
    if (!booking || !(await this.purchaseVerified(booking)))
      throw new BookingError("BOOKING_NOT_FOUND", 404);
    const result: StaffAppointmentDetailDto = toStaffAppointmentDto(booking, membership._id);
    // No continued operational need is established for cancelled, no-show, completed or ended
    // appointments. Missing/ambiguous snapshots fail closed; never consult a Customer profile.
    if (
      booking.fulfilment?.mode !== "TRAVEL_TO_CUSTOMER" ||
      booking.fulfilment.businessLocation ||
      booking.status !== "UPCOMING" ||
      !(booking.schedule.endAt.getTime() > Date.now())
    )
      return result;
    const destination = await this.bookingRepository.findStaffTravelDestination(
      membership.businessId,
      membership._id,
      booking._id,
    );
    const currentMembership = await this.requireOwnStaffMembership(actorUserId, businessId);
    if (!currentMembership._id.equals(membership._id)) throw new StaffError("STAFF_NOT_FOUND", 404);
    const address = destination?.fulfilment?.travelAddress;
    if (
      address &&
      [address.city, address.area, address.streetName, address.streetNumber].every(
        (value) => typeof value === "string" && value.trim().length > 0,
      )
    ) {
      result.travelAddress = {
        city: address.city,
        area: address.area,
        streetName: address.streetName,
        streetNumber: address.streetNumber,
        ...(address.floorUnit ? { floorUnit: address.floorUnit } : {}),
        ...(address.aptRoom ? { aptRoom: address.aptRoom } : {}),
      };
    }
    return result;
  }
}
