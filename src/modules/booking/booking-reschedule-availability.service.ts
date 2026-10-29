import mongoose, { Types } from "mongoose";
import { AvailabilityError } from "../availability/availability.errors.js";
import type {
  AvailabilityResult,
  AvailabilityService,
  BookedAvailabilityLine,
} from "../availability/availability.service.js";
import { BusinessModel } from "../business/business.model.js";
import { ServiceModel } from "../services/service.model.js";
import { StaffMembershipModel } from "../staff/staff.model.js";
import { BookingError } from "./booking.errors.js";
import { BookingModel } from "./booking.model.js";
import type { BookingService } from "./booking.service.js";
import { MAX_CUSTOMER_RESCHEDULE_COUNT } from "./booking.types.js";
import { packageReservationPartySize } from "./booking-package-foundation.js";
import {
  validateSchedulingLine,
  verifiedOccupiedMilliseconds,
} from "./booking-scheduling-admission.js";
import { verifyPackageBatchActivation } from "./package-batch-authority.js";

export type RescheduleAvailabilityResult = AvailabilityResult & {
  bookingId: string;
  originalStartAt: string;
  bookingUpdatedAt: string;
};

/** Read-only orchestration. Public callers supply identity and dates, never historical timing,
 * quantities, staff, capacity or reservation exclusions. No admission fence or writes in GET. */
export class BookingRescheduleAvailabilityService {
  public constructor(
    private readonly bookingService: BookingService,
    private readonly availability: AvailabilityService,
  ) {}

  public async forCustomer(
    userId: string,
    bookingId: string,
    fromDate: string,
    toDate: string,
  ): Promise<RescheduleAvailabilityResult> {
    const booking = await this.bookingService.getBookingDetailForCustomer(userId, bookingId);
    return this.read(
      { bookingId, businessId: String(booking.businessId), userId, role: "CUSTOMER" },
      fromDate,
      toDate,
    );
  }

  public async forBusiness(
    userId: string,
    role: "BUSINESS_OWNER" | "SUPERVISOR",
    businessId: string,
    bookingId: string,
    fromDate: string,
    toDate: string,
  ): Promise<RescheduleAvailabilityResult> {
    await this.bookingService.getBookingDetailForBusiness(userId, role, businessId, bookingId);
    return this.read({ bookingId, businessId, userId, role }, fromDate, toDate);
  }

  private async read(
    actor: {
      bookingId: string;
      businessId: string;
      userId: string;
      role: "CUSTOMER" | "BUSINESS_OWNER" | "SUPERVISOR";
    },
    fromDate: string,
    toDate: string,
  ): Promise<RescheduleAvailabilityResult> {
    if (!Types.ObjectId.isValid(actor.bookingId) || !Types.ObjectId.isValid(actor.businessId))
      throw new BookingError("BOOKING_NOT_FOUND", 404);
    const session = await mongoose.startSession();
    try {
      const result = await session.withTransaction(
        async () => {
          const booking = await BookingModel.findOne({
            _id: actor.bookingId,
            businessId: actor.businessId,
            ...(actor.role === "CUSTOMER" ? { "customer.customerUserId": actor.userId } : {}),
          }).session(session);
          if (!booking) throw new BookingError("BOOKING_NOT_FOUND", 404);
          if (
            !(booking.updatedAt instanceof Date) ||
            !Number.isFinite(booking.updatedAt.getTime()) ||
            !(booking.schedule.startAt instanceof Date) ||
            !Number.isFinite(booking.schedule.startAt.getTime())
          ) {
            throw new BookingError("BOOKING_SCHEDULING_CHANGED", 409);
          }
          const business = await BusinessModel.findById(booking.businessId).session(session);
          if (!business) throw new BookingError("BOOKING_BUSINESS_NOT_FOUND", 404);
          // Recheck management access in the read snapshot; do not rely on a foreign booking ID.
          if (actor.role === "BUSINESS_OWNER" && !business.ownerUserId.equals(actor.userId))
            throw new BookingError("BOOKING_BUSINESS_NOT_FOUND", 404);
          if (
            actor.role === "SUPERVISOR" &&
            !(await StaffMembershipModel.findOne({
              userId: actor.userId,
              businessId: business._id,
              role: "SUPERVISOR",
              employmentActive: true,
              removedAt: null,
            }).session(session))
          )
            throw new BookingError("BOOKING_BUSINESS_NOT_FOUND", 404);
          if (booking.serviceLines.some((line) => line.pricingInput.packageItemId))
            await verifyPackageBatchActivation();
          if (booking.status !== "UPCOMING")
            throw new BookingError("BOOKING_INVALID_STATUS_TRANSITION", 409);
          if (
            actor.role === "CUSTOMER" &&
            booking.customerRescheduleCount >= MAX_CUSTOMER_RESCHEDULE_COUNT
          )
            throw new BookingError("BOOKING_RESCHEDULE_LIMIT_REACHED", 409);
          if (business.timezone !== booking.schedule.timezone)
            throw new BookingError("BOOKING_SCHEDULING_CHANGED", 409);
          const lines: BookedAvailabilityLine[] = [];
          for (const line of booking.serviceLines) {
            const occupied = await verifiedOccupiedMilliseconds(booking, line, session);
            const service = await ServiceModel.findOne({
              _id: line.serviceId,
              businessId: business._id,
            }).session(session);
            const staffMembership = await StaffMembershipModel.findOne({
              _id: line.responsibleStaffMembershipId,
              businessId: business._id,
              employmentActive: true,
              removedAt: { $exists: false },
            }).session(session);
            if (!service || !staffMembership)
              throw new BookingError("BOOKING_STAFF_NOT_ELIGIBLE", 409);
            const mode = line.serviceSnapshot.pricingMode;
            // Missing historical quantity is never filled from today's minimum or pooled usage.
            if (
              (mode === "HOURLY" &&
                (!Number.isFinite(line.pricingInput.hours) || !(line.pricingInput.hours! > 0))) ||
              (mode === "PER_PERSON" &&
                (!Number.isInteger(line.pricingInput.personCount) ||
                  !(line.pricingInput.personCount! > 0)))
            ) {
              throw new BookingError("BOOKING_SCHEDULING_CHANGED", 409);
            }
            lines.push({
              service,
              staffMembership,
              occupiedMilliseconds: occupied.duration,
              partySize: packageReservationPartySize(line),
              capacityMax: occupied.capacityMax,
            });
          }
          const availability = await this.availability.getBookingAvailability({
            business,
            lines,
            fromDate,
            toDate,
            session,
            validateCandidate: async (index, startAt, endAt) => {
              const line = booking.serviceLines[index]!;
              const context = lines[index]!;
              try {
                await validateSchedulingLine(
                  {
                    business,
                    serviceId: line.serviceId,
                    staffMembershipId: line.responsibleStaffMembershipId,
                    startAt,
                    endAt,
                    partySize: context.partySize,
                    capacityMax: context.capacityMax,
                    packageGroup: line.schedulingSnapshot?.group,
                    allowInactive:
                      line.packageContext?.role === "REDEMPTION" ||
                      (line.pricingInput.sessionIndex !== undefined &&
                        line.pricingInput.sessionIndex > 1),
                    existingAppointment: true,
                    fulfilment: booking.fulfilment,
                    ...(line.pricingInput.packageProgressId && !line.pricingInput.packageItemId
                      ? {
                          legacyPurchase: {
                            progressId: line.pricingInput.packageProgressId,
                            businessClientId: booking.customer.businessClientId,
                            customerUserId: booking.customer.customerUserId,
                          },
                        }
                      : {}),
                  },
                  this.availability,
                  session,
                );
                return true;
              } catch (error) {
                if (
                  (error instanceof BookingError || error instanceof AvailabilityError) &&
                  error.statusCode < 500
                )
                  return false;
                throw error;
              }
            },
          });
          return {
            ...availability,
            bookingId: String(booking._id),
            originalStartAt: booking.schedule.startAt.toISOString(),
            bookingUpdatedAt: booking.updatedAt.toISOString(),
          };
        },
        { readConcern: { level: "snapshot" } },
      );
      if (!result) throw new BookingError("BOOKING_SCHEDULING_CHANGED", 409);
      return result;
    } catch (error) {
      if (
        error instanceof Error &&
        /transaction numbers are only allowed|replica set member/i.test(error.message)
      )
        throw new BookingError("BOOKING_TRANSACTION_UNAVAILABLE", 503);
      throw error;
    } finally {
      await session.endSession();
    }
  }
}
