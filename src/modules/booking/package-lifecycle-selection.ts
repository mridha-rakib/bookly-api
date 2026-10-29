import mongoose from "mongoose";
import type { z } from "zod";
import { AvailabilityError } from "../availability/availability.errors.js";
import type {
  AvailabilityResult,
  AvailabilityService,
} from "../availability/availability.service.js";
import { BusinessModel } from "../business/business.model.js";
import type { PackageProgressV2Document } from "../package-progress/package-progress-v2.types.js";
import { resolvePackageServiceEntitlement } from "../packages/package-service-entitlement.js";
import { ServiceModel } from "../services/service.model.js";
import { StaffMembershipModel } from "../staff/staff.model.js";
import { BookingError } from "./booking.errors.js";
import { BookingModel } from "./booking.model.js";
import { validateSchedulingLine } from "./booking-scheduling-admission.js";
import { batchConflict } from "./package-batch-contract.js";
import type { lifecycleHttpSchemas } from "./package-lifecycle-http.schema.js";

/** Advisory selection reuses C1 with the purchased duration and seat entitlement, including
 * inactive purchased services. Final admission and credit writes remain in the lifecycle. */
export async function readLifecycleSelection(
  progress: PackageProgressV2Document,
  input: z.infer<typeof lifecycleHttpSchemas.selection>,
  availability: AvailabilityService,
  now: Date,
) {
  const item = progress.items.find((i) => i.packageItemId.equals(input.packageItemId));
  if (!item || progress.creditAccountingVersion !== 2) throw batchConflict();
  const session = await mongoose.startSession();
  try {
    const result = await session.withTransaction(
      async () => {
        const business = await BusinessModel.findById(progress.businessId).session(session);
        const service = await ServiceModel.findOne({
          _id: item.serviceId,
          businessId: progress.businessId,
          status: { $in: ["ACTIVE", "INACTIVE"] },
          archivedAt: { $exists: false },
        }).session(session);
        const original = await BookingModel.findOne({
          _id: progress.originBookingId,
          businessId: progress.businessId,
          "customer.customerUserId": progress.customerUserId,
          "customer.businessClientId": progress.businessClientId,
        }).session(session);
        if (!business || !service || !original || business.timezone !== original.schedule.timezone)
          throw batchConflict();
        const entitlement = resolvePackageServiceEntitlement(service);
        if (
          !entitlement ||
          entitlement.pricingMode !== item.serviceSnapshot.pricingMode ||
          JSON.stringify(entitlement.group ?? null) !==
            JSON.stringify(item.serviceSnapshot.group ?? null)
        )
          throw batchConflict();
        const fulfilment =
          original.fulfilment.mode === "TRAVEL_TO_CUSTOMER"
            ? {
                mode: "TRAVEL_TO_CUSTOMER" as const,
                travelAddress: input.travelAddress ?? original.fulfilment.travelAddress,
              }
            : original.fulfilment;
        if (
          fulfilment.mode === "TRAVEL_TO_CUSTOMER" &&
          !item.travelCities?.some((c) => c.city === fulfilment.travelAddress?.city)
        )
          throw batchConflict();
        const staff = await StaffMembershipModel.find({
          businessId: progress.businessId,
          _id: input.staffMembershipId ?? { $in: service.assignedStaffMembershipIds },
          employmentActive: true,
          role: { $in: ["STAFF", "SUPERVISOR"] },
          removedAt: { $exists: false },
        }).session(session);
        const occupied =
          (item.serviceSnapshot.durationMin +
            (entitlement.bufferAfterMin ?? 0) +
            (entitlement.processingTimeMin ?? 0)) *
          60000;
        const merged: AvailabilityResult = {
          businessId: String(progress.businessId),
          serviceId: String(item.serviceId),
          timezone: business.timezone,
          capacityMax: item.serviceSnapshot.group?.capacityMax ?? 1,
          days: [],
        };
        for (const member of staff) {
          const candidate = await availability.getBookingAvailability({
            business,
            fromDate: input.fromDate,
            toDate: input.toDate,
            session,
            lines: [
              {
                service,
                staffMembership: member,
                occupiedMilliseconds: occupied,
                partySize: 1,
                capacityMax: merged.capacityMax,
              },
            ],
            validateCandidate: async (_index, startAt, endAt) => {
              if (
                startAt <= now ||
                (progress.purchasedContract.validity.mode === "FINITE" &&
                  startAt >= progress.purchasedContract.validity.expiresAt)
              )
                return false;
              try {
                await validateSchedulingLine(
                  {
                    business,
                    serviceId: item.serviceId,
                    staffMembershipId: member._id,
                    startAt,
                    endAt,
                    partySize: 1,
                    capacityMax: merged.capacityMax,
                    packageGroup: item.serviceSnapshot.group,
                    allowInactive: true,
                    fulfilment,
                  },
                  availability,
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
          for (const day of candidate.days) {
            let target = merged.days.find((d) => d.date === day.date);
            if (!target) {
              target = { date: day.date, isOpen: day.isOpen, slots: [] };
              merged.days.push(target);
            }
            target.isOpen ||= day.isOpen;
            for (const slot of day.slots) {
              const existing = target.slots.find(
                (s) => s.startAt === slot.startAt && s.endAt === slot.endAt,
              );
              if (existing)
                existing.eligibleStaffMembershipIds.push(...slot.eligibleStaffMembershipIds);
              else target.slots.push(slot);
            }
          }
        }
        for (const day of merged.days) day.slots.sort((a, b) => a.startAt.localeCompare(b.startAt));
        return merged;
      },
      { readConcern: { level: "snapshot" } },
    );
    if (!result) throw batchConflict();
    return result;
  } finally {
    await session.endSession();
  }
}
