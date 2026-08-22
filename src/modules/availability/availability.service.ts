import { Types } from "mongoose";

import {
  addCalendarDays,
  businessLocalToUtc,
  dayOfWeekForDate,
  enumerateCalendarDates,
  utcToBusinessLocalDate,
  utcToBusinessLocalTime,
} from "../../common/time/business-clock.js";
import type { BookingSlotReservationDocument } from "../booking-slot-reservation/booking-slot-reservation.model.js";
import type { BookingSlotReservationRepository } from "../booking-slot-reservation/booking-slot-reservation.repository.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { BusinessCity } from "../business/business.types.js";
import type { BusinessBookingSettingsRepository } from "../business-booking-settings/business-booking-settings.repository.js";
import type { BusinessHoursRepository } from "../business-hours/business-hours.repository.js";
import type { BusinessTravelSettingsRepository } from "../business-travel-settings/business-travel-settings.repository.js";
import type { ServiceDocument } from "../services/service.model.js";
import type { ServiceRepository } from "../services/service.repository.js";
import type { StaffMembershipDocument } from "../staff/staff.model.js";
import type { StaffRepository } from "../staff/staff.repository.js";
import type { StaffScheduleDocument } from "../staff/staff-schedule.model.js";
import type { StaffScheduleRepository } from "../staff/staff-schedule.repository.js";
import type { DayOfWeek } from "../staff/staff-schedule.types.js";
import { minutesSinceMidnight, minutesToCanonicalTime } from "../staff/staff-schedule.utils.js";
import type { StaffTimeOffDocument } from "../staff/staff-time-off.model.js";
import type { StaffTimeOffRepository } from "../staff/staff-time-off.repository.js";
import { AvailabilityError } from "./availability.errors.js";
import { ANY_STAFF, MAX_AVAILABILITY_RANGE_DAYS } from "./availability.types.js";

export type AvailabilitySlot = {
  startAt: string;
  endAt: string;
  eligibleStaffMembershipIds: string[];
  /** Present only for a capacity (PER_PERSON) service — the largest remaining capacity among
   * eligible staff for this slot (see this service's own doc comment on why "largest among
   * eligible staff," not a per-staff breakdown, in this batch). Absent for an exclusive
   * service, where a slot is either offered (capacity 1) or not offered at all. */
  remainingCapacity?: number | undefined;
  source: "AUTO" | "MANUAL";
};

export type AvailabilityDay = {
  date: string;
  /** True if the Business/Service configuration allows ANY slot that day before staff/
   * reservation filtering — lets the frontend distinguish "closed" from "open but fully
   * booked" (both render as `slots: []`, but only the latter is `isOpen: true`). */
  isOpen: boolean;
  slots: AvailabilitySlot[];
};

export type AvailabilityResult = {
  businessId: string;
  serviceId: string;
  timezone: string;
  capacityMax: number;
  days: AvailabilityDay[];
};

export type GetAvailabilityInput = {
  businessId: string;
  serviceId: string;
  /** Omit (or ANY_STAFF) for "no preference" — matches every Staff member assigned to the
   * Service. */
  staffMembershipId?: string | undefined;
  fromDate: string;
  toDate: string;
  /** Only meaningful for a PER_PERSON service; defaults to 1. */
  partySize?: number | undefined;
  /** Required when Business.visitType is TRAVEL_TO_CUSTOMER. */
  customerCity?: BusinessCity | undefined;
};

type ServiceSchedulingConfig = {
  /** The customer-visible duration used to decide whether a candidate slot FITS inside an
   * opening/staff-schedule boundary. For HOURLY services (which have no fixed durationMin —
   * the customer chooses an hour count at booking time, see service.model.ts) this is
   * `minHours * 60`: the minimum commitment is the only duration this engine can safely assume
   * without inventing one: a candidate start is only offered if it can accommodate at least
   * the shortest booking the Service allows. The actual chosen duration is Batch 3's concern
   * (booking creation), not this engine's. */
  durationMin: number;
  bufferAfterMin: number;
  /** Deliberately treated as additional blocking time, never a staff-reuse opportunity — see
   * this service's own module doc comment ("PROCESSING TIME") for why. */
  processingTimeMin: number;
  /** The step between AUTO-mode candidate starts. Falls back to `durationMin` (back-to-back,
   * non-overlapping candidates) when the Service has no explicit bookingIntervalMin
   * configured — the only defensible default absent a configured value: never invents a
   * *smaller* step than the service actually occupies. For HOURLY (no bookingIntervalMin
   * field exists at all), this is `minHours * 60`, the same derivation as `durationMin`. */
  bookingIntervalMin: number;
  /** 1 for every pricing mode except PER_PERSON. */
  capacityMax: number;
};

type StaffContext = {
  membership: StaffMembershipDocument;
  schedule: StaffScheduleDocument | undefined;
  timeOffDateSet: Set<string>;
};

/**
 * The bounded-domain Availability Engine — reads the existing scheduling configuration
 * (Business.timezone, BusinessOpeningHours, StaffSchedule, StaffTimeOff, Service scheduling
 * fields, BusinessTravelSettings) and the new conflict-safe BookingSlotReservation occupancy
 * record, and answers "which slots are bookable" for a Business+Service (+ optional Staff/
 * party size/city). Never writes anything — see BookingSlotReservationService for the actual
 * reservation write path this engine's output feeds into (Batch 3 wires that composition; this
 * batch exposes `reserveOrJoin` on that service directly, already fully correct and tested).
 *
 * PROCESSING TIME: Service.fixedPricing/packagePricing.processingTimeMin has no further
 * documented semantics anywhere in the existing model/schema/UI beyond its name and that it's
 * a non-negative minute count alongside bufferAfterMin. Per this batch's own instruction
 * ("Correctness is more important than maximizing utilization" / "implement conservative
 * blocking behavior and explicitly report the limitation"), this engine treats it as
 * additional blocking time on the Staff member's timeline
 * (occupiedMin = durationMin + bufferAfterMin + processingTimeMin), identical in effect to
 * bufferAfterMin. It does NOT attempt to let a Staff member take a second booking during a
 * "passive" processing window, since no existing code/UI confirms that's the intended
 * semantics — see the Batch 2 final report's "product ambiguity" section.
 */
export class AvailabilityService {
  public constructor(
    private readonly businessRepository: BusinessRepository,
    private readonly serviceRepository: ServiceRepository,
    private readonly staffRepository: StaffRepository,
    private readonly staffScheduleRepository: StaffScheduleRepository,
    private readonly staffTimeOffRepository: StaffTimeOffRepository,
    private readonly businessHoursRepository: BusinessHoursRepository,
    private readonly businessBookingSettingsRepository: BusinessBookingSettingsRepository,
    private readonly businessTravelSettingsRepository: BusinessTravelSettingsRepository,
    private readonly reservationRepository: BookingSlotReservationRepository,
  ) {}

  public async getAvailability(input: GetAvailabilityInput): Promise<AvailabilityResult> {
    this.requireBoundedRange(input.fromDate, input.toDate);

    const business = await this.requireBusiness(input.businessId);
    const service = await this.requireBookableService(business, input.serviceId);
    const config = this.resolveServiceConfig(service);
    const partySize = input.partySize ?? 1;
    this.requireValidPartySize(partySize, config);

    if (business.visitType === "TRAVEL_TO_CUSTOMER") {
      await this.requireServedCity(business, service, input.customerCity);
    }

    const eligibleStaff = await this.resolveEligibleStaff(
      business,
      service,
      input.staffMembershipId,
    );

    if (eligibleStaff.length === 0) {
      return {
        businessId: input.businessId,
        serviceId: input.serviceId,
        timezone: business.timezone,
        capacityMax: config.capacityMax,
        days: enumerateCalendarDates(input.fromDate, input.toDate).map((date) => ({
          date,
          isOpen: false,
          slots: [],
        })),
      };
    }

    const [openingHours, bookingSettings, staffSchedules, staffTimeOffs, reservations] =
      await Promise.all([
        this.businessHoursRepository.findByBusinessId(business._id),
        this.businessBookingSettingsRepository.findByBusinessId(business._id),
        this.staffScheduleRepository.findManyByMembershipIds(eligibleStaff.map((s) => s._id)),
        this.staffTimeOffRepository.findManyByMembershipIdsOverlappingRange(
          eligibleStaff.map((s) => s._id),
          input.fromDate,
          input.toDate,
        ),
        this.reservationRepository.findManyForStaffInDateRange(
          business._id,
          eligibleStaff.map((s) => s._id),
          enumerateCalendarDates(input.fromDate, input.toDate),
        ),
      ]);

    const staffContexts = this.buildStaffContexts(eligibleStaff, staffSchedules, staffTimeOffs);
    const gapEliminationEnabled = bookingSettings?.gapEliminationEnabled ?? false;

    const days = enumerateCalendarDates(input.fromDate, input.toDate).map((date) =>
      this.buildDay({
        date,
        business,
        service,
        config,
        partySize,
        openingHours: openingHours?.days ?? [],
        staffContexts,
        reservations,
        gapEliminationEnabled,
      }),
    );

    return {
      businessId: input.businessId,
      serviceId: input.serviceId,
      timezone: business.timezone,
      capacityMax: config.capacityMax,
      days,
    };
  }

  /**
   * The Batch 3 booking-creation write-path guard: re-validates that ONE specific
   * (staffMembership, [startAt, endAt)) pair is genuinely bookable, independent of and in
   * addition to the atomic occupancy-conflict check `BookingSlotReservationService.reserveOrJoin`
   * performs. This is necessary because the reservation collection only knows about OTHER
   * reservations, not staff schedules/time-off/opening-hours/manual-times — an atomically
   * successful reservation claim on an interval outside the staff's shift, or on a day they are
   * on leave, or (for a MANUAL-schedule service) at a time never configured, would still
   * "succeed" at the occupancy layer while violating a real scheduling rule. Booking creation
   * must call this BEFORE attempting the reservation claim (see BookingCreationService).
   *
   * Deliberately does NOT check `BookingSlotReservation` occupancy itself — that is
   * `reserveOrJoin`'s job, and duplicating it here would just be a second, non-atomic (hence
   * unsafe to rely on) conflict check.
   */
  public async assertSlotIsBookable(input: {
    business: BusinessDocument;
    service: ServiceDocument;
    staffMembership: StaffMembershipDocument;
    startAt: Date;
    endAt: Date;
    partySize: number;
  }): Promise<{ capacityMax: number }> {
    const config = this.resolveServiceConfig(input.service);
    this.requireValidPartySize(input.partySize, config);

    if (input.endAt <= input.startAt) {
      throw new AvailabilityError("AVAILABILITY_SLOT_NOT_BOOKABLE", 409);
    }

    const { dateStr: date, dayOfWeek } = utcToBusinessLocalDate(
      input.business.timezone,
      input.startAt,
    );
    const endLocalDate = utcToBusinessLocalDate(input.business.timezone, input.endAt).dateStr;
    if (date !== endLocalDate) {
      throw new AvailabilityError("AVAILABILITY_SLOT_NOT_BOOKABLE", 409);
    }

    const [schedules, timeOffs] = await Promise.all([
      this.staffScheduleRepository.findManyByMembershipIds([input.staffMembership._id]),
      this.staffTimeOffRepository.findManyByMembershipIdsOverlappingRange(
        [input.staffMembership._id],
        date,
        date,
      ),
    ]);
    const [staffContext] = this.buildStaffContexts([input.staffMembership], schedules, timeOffs);

    if (
      !staffContext ||
      !this.isWithinStaffShift({
        staffContext,
        date,
        dayOfWeek,
        timezone: input.business.timezone,
        startAt: input.startAt,
        endAt: input.endAt,
      })
    ) {
      throw new AvailabilityError("AVAILABILITY_SLOT_NOT_BOOKABLE", 409);
    }

    if (input.service.scheduleMode === "MANUAL") {
      const day = input.service.manualSchedule.find((entry) => entry.dayOfWeek === dayOfWeek);
      const localTime = utcToBusinessLocalTime(input.business.timezone, input.startAt);
      if (!day?.isOpen || !day.times.includes(localTime)) {
        throw new AvailabilityError("AVAILABILITY_SLOT_NOT_BOOKABLE", 409);
      }
    } else {
      const openingHours = await this.businessHoursRepository.findByBusinessId(input.business._id);
      const day = (openingHours?.days ?? []).find((entry) => entry.dayOfWeek === dayOfWeek);
      const withinOpeningHours =
        day?.isOpen === true &&
        day.slots.some((slot) => {
          const slotStartAt = businessLocalToUtc(input.business.timezone, date, slot.startTime);
          const slotEndAt = businessLocalToUtc(input.business.timezone, date, slot.endTime);
          return input.startAt >= slotStartAt && input.endAt <= slotEndAt;
        });

      if (!withinOpeningHours) {
        throw new AvailabilityError("AVAILABILITY_SLOT_NOT_BOOKABLE", 409);
      }
    }

    return { capacityMax: config.capacityMax };
  }

  // --- Day building ---------------------------------------------------------------------------

  private buildDay(context: {
    date: string;
    business: BusinessDocument;
    service: ServiceDocument;
    config: ServiceSchedulingConfig;
    partySize: number;
    openingHours: Array<{
      dayOfWeek: DayOfWeek;
      isOpen: boolean;
      slots: { startTime: string; endTime: string }[];
    }>;
    staffContexts: StaffContext[];
    reservations: BookingSlotReservationDocument[];
    gapEliminationEnabled: boolean;
  }): AvailabilityDay {
    const { date, business, service, config, partySize } = context;
    const dayOfWeek = dayOfWeekForDate(date);

    const candidates =
      service.scheduleMode === "MANUAL"
        ? this.manualCandidateStarts(service, dayOfWeek)
        : this.autoCandidateStarts(context.openingHours, dayOfWeek, config);

    if (candidates.length === 0) {
      return { date, isOpen: false, slots: [] };
    }

    const occupiedMin = config.durationMin + config.bufferAfterMin + config.processingTimeMin;
    const source: "AUTO" | "MANUAL" = service.scheduleMode === "MANUAL" ? "MANUAL" : "AUTO";

    const slots: AvailabilitySlot[] = [];

    for (const startHHmm of candidates) {
      const startAt = businessLocalToUtc(business.timezone, date, startHHmm);
      const endAt = new Date(startAt.getTime() + occupiedMin * 60_000);

      const eligible: { staffId: string; remainingCapacity: number }[] = [];

      for (const staffContext of context.staffContexts) {
        const outcome = this.evaluateStaffForSlot({
          staffContext,
          date,
          dayOfWeek,
          timezone: business.timezone,
          startAt,
          endAt,
          serviceId: service._id,
          config,
          partySize,
          reservations: context.reservations,
        });

        if (outcome) {
          eligible.push(outcome);
        }
      }

      if (eligible.length > 0) {
        slots.push({
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
          eligibleStaffMembershipIds: eligible.map((entry) => entry.staffId),
          ...(config.capacityMax > 1
            ? { remainingCapacity: Math.max(...eligible.map((entry) => entry.remainingCapacity)) }
            : {}),
          source,
        });
      }
    }

    if (context.gapEliminationEnabled) {
      this.applyGapEliminationOrdering(slots, context.reservations, date);
    }

    return { date, isOpen: true, slots };
  }

  /**
   * Shared by both the day-builder (evaluateStaffForSlot, below) and the Batch 3 booking-
   * creation write-path guard (assertSlotIsBookable) — a Staff member is working a given
   * interval only if they are not on time off that business-local day AND their StaffSchedule
   * has a shift for that weekday whose [startTime, endTime) fully contains [startAt, endAt).
   */
  private isWithinStaffShift(input: {
    staffContext: StaffContext;
    date: string;
    dayOfWeek: DayOfWeek;
    timezone: string;
    startAt: Date;
    endAt: Date;
  }): boolean {
    if (input.staffContext.timeOffDateSet.has(input.date)) {
      return false;
    }

    const shift = input.staffContext.schedule?.days.find(
      (day) => day.dayOfWeek === input.dayOfWeek,
    );
    if (!shift) {
      return false;
    }

    const shiftStartAt = businessLocalToUtc(input.timezone, input.date, shift.startTime);
    const shiftEndAt = businessLocalToUtc(input.timezone, input.date, shift.endTime);
    return input.startAt >= shiftStartAt && input.endAt <= shiftEndAt;
  }

  private evaluateStaffForSlot(input: {
    staffContext: StaffContext;
    date: string;
    dayOfWeek: DayOfWeek;
    timezone: string;
    startAt: Date;
    endAt: Date;
    serviceId: Types.ObjectId;
    config: ServiceSchedulingConfig;
    partySize: number;
    reservations: BookingSlotReservationDocument[];
  }): { staffId: string; remainingCapacity: number } | null {
    const { staffContext } = input;

    if (!this.isWithinStaffShift(input)) {
      return null;
    }

    const staffReservations = input.reservations.filter(
      (doc) =>
        doc.staffMembershipId.equals(staffContext.membership._id) &&
        doc.occupancyDate === input.date,
    );
    const intervals = staffReservations.flatMap((doc) => doc.intervals);

    const exactMatch = intervals.find(
      (entry) =>
        entry.serviceId.equals(input.serviceId) &&
        entry.startAt.getTime() === input.startAt.getTime() &&
        entry.endAt.getTime() === input.endAt.getTime(),
    );

    if (exactMatch) {
      const remaining = exactMatch.capacityMax - exactMatch.capacityUsed;
      return remaining >= input.partySize
        ? { staffId: String(staffContext.membership._id), remainingCapacity: remaining }
        : null;
    }

    const blockingOverlap = intervals.some(
      (entry) => entry.startAt < input.endAt && entry.endAt > input.startAt,
    );
    if (blockingOverlap) {
      return null;
    }

    return {
      staffId: String(staffContext.membership._id),
      remainingCapacity: input.config.capacityMax,
    };
  }

  // --- Candidate generation ---------------------------------------------------------------------

  private autoCandidateStarts(
    openingDays: Array<{
      dayOfWeek: DayOfWeek;
      isOpen: boolean;
      slots: { startTime: string; endTime: string }[];
    }>,
    dayOfWeek: DayOfWeek,
    config: ServiceSchedulingConfig,
  ): string[] {
    const day = openingDays.find((entry) => entry.dayOfWeek === dayOfWeek);
    if (!day?.isOpen) {
      return [];
    }

    const occupiedMin = config.durationMin + config.bufferAfterMin + config.processingTimeMin;
    const starts: string[] = [];

    for (const slot of day.slots) {
      const openStart = minutesSinceMidnight(slot.startTime);
      const openEnd = minutesSinceMidnight(slot.endTime);

      for (
        let start = openStart;
        start + occupiedMin <= openEnd;
        start += config.bookingIntervalMin
      ) {
        starts.push(minutesToCanonicalTime(start));
      }
    }

    return starts;
  }

  private manualCandidateStarts(service: ServiceDocument, dayOfWeek: DayOfWeek): string[] {
    const day = service.manualSchedule.find((entry) => entry.dayOfWeek === dayOfWeek);
    if (!day?.isOpen) {
      return [];
    }

    // Explicitly-configured times only — never generates additional times around them
    // (confirmed rule: MANUAL means "fixed time slots... override the Business's general
    // hours for this Service only," see service.types.ts).
    return [...day.times].sort();
  }

  // --- Gap elimination (item 10) ----------------------------------------------------------------

  /**
   * BusinessBookingSettings.gapEliminationEnabled ("Fill your day like Tetris. No useless gaps
   * between appointments." — confirmed UI copy, ServicesListPage.tsx) has no further specified
   * algorithm anywhere in the existing code/schema: no confirmed "useless gap" threshold, no
   * confirmed hide-vs-rank semantics. Per this batch's explicit instruction ("keep it as a
   * deterministic filtering/ranking rule... never override staff conflicts, closed hours, time
   * off, reservations, duration constraints" / "if unclear, leave the core engine correct
   * without it and report exactly what remains undefined"), this implements ONLY the safest
   * possible reading: a stable re-ordering (never a filter — every slot `buildDay` already
   * proved valid stays in the result) that ranks a slot earlier when it starts immediately
   * after, or ends immediately before, another already-occupied interval for at least one of
   * its eligible staff — i.e. slots that pack against existing occupancy are surfaced first.
   * No slot is ever hidden by this pass. See the Batch 2 final report for what remains
   * genuinely undefined about this setting (an exact "gap size" threshold, per-staff vs.
   * per-business scope, whether it should also affect Manual-mode/multi-staff differently).
   */
  private applyGapEliminationOrdering(
    slots: AvailabilitySlot[],
    reservations: BookingSlotReservationDocument[],
    date: string,
  ): void {
    const occupiedBoundaries = reservations
      .filter((doc) => doc.occupancyDate === date)
      .flatMap((doc) => doc.intervals)
      .flatMap((interval) => [interval.startAt.getTime(), interval.endAt.getTime()]);

    if (occupiedBoundaries.length === 0) {
      return;
    }

    const boundarySet = new Set(occupiedBoundaries);
    const packsAgainstOccupancy = (slot: AvailabilitySlot): boolean =>
      boundarySet.has(new Date(slot.startAt).getTime()) ||
      boundarySet.has(new Date(slot.endAt).getTime());

    // Stable sort: packed-against-occupancy slots first, preserving chronological order
    // within each group — never reorders in a way that would make the result look
    // non-chronological to a user unless it is genuinely prioritizing a packed slot.
    slots.sort((a, b) => {
      const aPacked = packsAgainstOccupancy(a) ? 0 : 1;
      const bPacked = packsAgainstOccupancy(b) ? 0 : 1;
      if (aPacked !== bPacked) {
        return aPacked - bPacked;
      }
      return new Date(a.startAt).getTime() - new Date(b.startAt).getTime();
    });
  }

  // --- Config / eligibility resolution -----------------------------------------------------------

  private resolveServiceConfig(service: ServiceDocument): ServiceSchedulingConfig {
    if (service.isPackageDeal) {
      const pricing = service.packagePricing;
      if (!pricing) {
        throw new AvailabilityError("AVAILABILITY_SERVICE_NOT_FOUND", 409);
      }
      return {
        durationMin: pricing.durationMin,
        bufferAfterMin: pricing.bufferAfterMin ?? 0,
        processingTimeMin: pricing.processingTimeMin ?? 0,
        bookingIntervalMin: pricing.bookingIntervalMin ?? pricing.durationMin,
        capacityMax: 1,
      };
    }

    switch (service.pricingMode) {
      case "FIXED": {
        const pricing = service.fixedPricing;
        if (!pricing) throw new AvailabilityError("AVAILABILITY_SERVICE_NOT_FOUND", 409);
        return {
          durationMin: pricing.durationMin,
          bufferAfterMin: pricing.bufferAfterMin ?? 0,
          processingTimeMin: pricing.processingTimeMin ?? 0,
          bookingIntervalMin: pricing.bookingIntervalMin ?? pricing.durationMin,
          capacityMax: 1,
        };
      }
      case "HOURLY": {
        const pricing = service.hourlyPricing;
        if (!pricing) throw new AvailabilityError("AVAILABILITY_SERVICE_NOT_FOUND", 409);
        const minDurationMin = pricing.minHours * 60;
        return {
          durationMin: minDurationMin,
          bufferAfterMin: pricing.bufferAfterMin ?? 0,
          processingTimeMin: 0,
          bookingIntervalMin: minDurationMin,
          capacityMax: 1,
        };
      }
      case "PER_PERSON": {
        const pricing = service.perPersonPricing;
        if (!pricing) throw new AvailabilityError("AVAILABILITY_SERVICE_NOT_FOUND", 409);
        return {
          durationMin: pricing.durationMin,
          bufferAfterMin: pricing.bufferAfterMin ?? 0,
          processingTimeMin: 0,
          bookingIntervalMin: pricing.bookingIntervalMin ?? pricing.durationMin,
          capacityMax: pricing.maxPersons,
        };
      }
      default:
        throw new AvailabilityError("AVAILABILITY_SERVICE_NOT_FOUND", 409);
    }
  }

  private async resolveEligibleStaff(
    business: BusinessDocument,
    service: ServiceDocument,
    requestedStaffMembershipId: string | undefined,
  ): Promise<StaffMembershipDocument[]> {
    if (requestedStaffMembershipId && requestedStaffMembershipId !== ANY_STAFF) {
      if (!Types.ObjectId.isValid(requestedStaffMembershipId)) {
        throw new AvailabilityError("AVAILABILITY_STAFF_NOT_FOUND", 404);
      }

      const membership = await this.staffRepository.findActiveById(
        business._id,
        requestedStaffMembershipId,
      );

      if (!membership) {
        throw new AvailabilityError("AVAILABILITY_STAFF_NOT_FOUND", 404);
      }

      if (!service.assignedStaffMembershipIds.some((id) => id.equals(membership._id))) {
        throw new AvailabilityError("AVAILABILITY_STAFF_NOT_ELIGIBLE", 409);
      }

      return [membership];
    }

    if (service.assignedStaffMembershipIds.length === 0) {
      return [];
    }

    const memberships = await this.staffRepository.findManyByIdsForBusiness(
      business._id,
      service.assignedStaffMembershipIds,
    );

    return memberships.filter((membership) => membership.employmentActive && !membership.removedAt);
  }

  private buildStaffContexts(
    staff: StaffMembershipDocument[],
    schedules: StaffScheduleDocument[],
    timeOffs: StaffTimeOffDocument[],
  ): StaffContext[] {
    const scheduleByMembershipId = new Map(schedules.map((s) => [String(s.membershipId), s]));
    const timeOffByMembershipId = new Map<string, StaffTimeOffDocument[]>();
    for (const timeOff of timeOffs) {
      const key = String(timeOff.membershipId);
      const bucket = timeOffByMembershipId.get(key) ?? [];
      bucket.push(timeOff);
      timeOffByMembershipId.set(key, bucket);
    }

    return staff.map((membership) => {
      const key = String(membership._id);
      const entries = timeOffByMembershipId.get(key) ?? [];
      const dateSet = new Set<string>();

      for (const entry of entries) {
        let cursor = entry.startDate;
        // Time-off ranges are short (leave requests), so this bounded per-day walk is cheap —
        // never called with an unbounded range (StaffTimeOff creation validates that
        // separately; see staff.service.ts).
        while (cursor <= entry.endDate) {
          dateSet.add(cursor);
          cursor = addCalendarDays(cursor, 1);
        }
      }

      return {
        membership,
        schedule: scheduleByMembershipId.get(key),
        timeOffDateSet: dateSet,
      };
    });
  }

  // --- Guards -----------------------------------------------------------------------------------

  private requireBoundedRange(fromDate: string, toDate: string): void {
    const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!isoDatePattern.test(fromDate) || !isoDatePattern.test(toDate) || fromDate > toDate) {
      throw new AvailabilityError("AVAILABILITY_RANGE_INVALID", 400);
    }

    const dayCount = enumerateCalendarDates(fromDate, toDate).length;
    if (dayCount > MAX_AVAILABILITY_RANGE_DAYS) {
      throw new AvailabilityError("AVAILABILITY_RANGE_TOO_WIDE", 400, [
        {
          message: `The date range must not exceed ${MAX_AVAILABILITY_RANGE_DAYS} days`,
          code: "AVAILABILITY_RANGE_TOO_WIDE",
        },
      ]);
    }
  }

  private requireValidPartySize(partySize: number, config: ServiceSchedulingConfig): void {
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > config.capacityMax) {
      throw new AvailabilityError("AVAILABILITY_PARTY_SIZE_INVALID", 400);
    }
  }

  private async requireBusiness(businessId: string): Promise<BusinessDocument> {
    if (!Types.ObjectId.isValid(businessId)) {
      throw new AvailabilityError("AVAILABILITY_BUSINESS_NOT_FOUND", 404);
    }

    const business = await this.businessRepository.findById(businessId);
    if (!business) {
      throw new AvailabilityError("AVAILABILITY_BUSINESS_NOT_FOUND", 404);
    }

    return business;
  }

  private async requireBookableService(
    business: BusinessDocument,
    serviceId: string,
  ): Promise<ServiceDocument> {
    if (!Types.ObjectId.isValid(serviceId)) {
      throw new AvailabilityError("AVAILABILITY_SERVICE_NOT_FOUND", 404);
    }

    const service = await this.serviceRepository.findById(business._id, serviceId);
    if (service?.status !== "ACTIVE") {
      throw new AvailabilityError("AVAILABILITY_SERVICE_NOT_FOUND", 404);
    }

    return service;
  }

  /** Public — also reused verbatim by BookingCreationService's mandatory write-time
   * re-validation of city/service/business travel eligibility (Batch 3); never duplicated. */
  public async requireServedCity(
    business: BusinessDocument,
    service: ServiceDocument,
    customerCity: BusinessCity | undefined,
  ): Promise<void> {
    if (!customerCity) {
      throw new AvailabilityError("AVAILABILITY_CITY_REQUIRED", 400);
    }

    if (!service.servedCities.includes(customerCity)) {
      throw new AvailabilityError("AVAILABILITY_CITY_NOT_SERVED", 409);
    }

    const settings = await this.businessTravelSettingsRepository.findByBusinessId(business._id);
    const citySetting = settings?.cities.find((entry) => entry.city === customerCity);

    if (!citySetting?.active) {
      throw new AvailabilityError("AVAILABILITY_CITY_NOT_SERVED", 409);
    }
  }
}
