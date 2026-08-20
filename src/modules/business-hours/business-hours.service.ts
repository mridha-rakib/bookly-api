import { Types } from "mongoose";

import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import { type DayOfWeek, daysOfWeek } from "../staff/staff-schedule.types.js";
import { BusinessHoursError } from "./business-hours.errors.js";
import type {
  BusinessOpeningHoursDay,
  BusinessOpeningHoursDocument,
} from "./business-hours.model.js";
import type { BusinessHoursRepository } from "./business-hours.repository.js";

export type BusinessHoursDayDto = {
  dayOfWeek: DayOfWeek;
  isOpen: boolean;
  slots: { startTime: string; endTime: string }[];
};

export type BusinessHoursDto = {
  businessId: string;
  /**
   * false when no BusinessOpeningHours document exists yet for this Business — the future
   * availability engine must treat that as "not configured" (unknown/unbookable), never as
   * "open every day". Only becomes true after an explicit successful PUT.
   */
  configured: boolean;
  days: BusinessHoursDayDto[];
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export class BusinessHoursService {
  public constructor(
    private readonly businessHoursRepository: BusinessHoursRepository,
    private readonly businessRepository: BusinessRepository,
  ) {}

  public async getOpeningHours(userId: string, businessId: string): Promise<BusinessHoursDto> {
    await this.requireOwnedBusiness(userId, businessId);
    const hours = await this.businessHoursRepository.findByBusinessId(businessId);
    return this.toDto(businessId, hours);
  }

  /**
   * Replaces the whole week in one write, mirroring StaffSchedule.putSchedule — this is what
   * makes "at most one entry per day" true regardless of what the caller sends.
   */
  public async putOpeningHours(
    userId: string,
    businessId: string,
    days: BusinessOpeningHoursDay[],
  ): Promise<BusinessHoursDto> {
    const business = await this.requireOwnedBusiness(userId, businessId);

    // Defense in depth beyond the schema's duplicate-day check, matching
    // StaffService.putSchedule's Map-based dedupe: keep the last entry per day.
    const byDay = new Map<DayOfWeek, BusinessOpeningHoursDay>();
    for (const day of days) {
      byDay.set(day.dayOfWeek, {
        dayOfWeek: day.dayOfWeek,
        isOpen: day.isOpen,
        slots: day.isOpen
          ? [...day.slots].sort((a, b) => a.startTime.localeCompare(b.startTime))
          : [],
      });
    }

    const normalizedDays = [...byDay.values()];
    const hours = await this.businessHoursRepository.replace(business._id, normalizedDays);

    return this.toDto(businessId, hours);
  }

  // Owner-only, no BusinessAccess fallback, no Supervisor access — Business opening hours are
  // a Business Profile / settings surface, same rationale as business-booking-settings and
  // services (see those modules' equivalent comments).
  private async requireOwnedBusiness(
    userId: string,
    businessId: string,
  ): Promise<BusinessDocument> {
    if (!Types.ObjectId.isValid(businessId)) {
      throw new BusinessHoursError("BUSINESS_HOURS_BUSINESS_NOT_FOUND", 404);
    }

    const business = await this.businessRepository.findById(businessId);

    if (!business) {
      throw new BusinessHoursError("BUSINESS_HOURS_BUSINESS_NOT_FOUND", 404);
    }

    if (!business.ownerUserId.equals(userId)) {
      throw new BusinessHoursError("BUSINESS_HOURS_BUSINESS_NOT_FOUND", 404);
    }

    return business;
  }

  private toDto(businessId: string, hours: BusinessOpeningHoursDocument | null): BusinessHoursDto {
    if (!hours) {
      return { businessId, configured: false, days: [] };
    }

    const dayOrder = new Map(daysOfWeek.map((day, index) => [day, index]));
    const sortedDays = [...hours.days].sort(
      (a, b) => (dayOrder.get(a.dayOfWeek) ?? 0) - (dayOrder.get(b.dayOfWeek) ?? 0),
    );

    return {
      businessId,
      configured: true,
      days: sortedDays.map((day) => ({
        dayOfWeek: day.dayOfWeek,
        isOpen: day.isOpen,
        slots: day.slots.map((slot) => ({ startTime: slot.startTime, endTime: slot.endTime })),
      })),
      createdAt: hours.createdAt.toISOString(),
      updatedAt: hours.updatedAt.toISOString(),
    };
  }
}
