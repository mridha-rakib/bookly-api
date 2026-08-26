import {
  utcToBusinessLocalDate,
  utcToBusinessLocalTime,
} from "../../common/time/business-clock.js";
import type { AddonRepository } from "../addons/addon.repository.js";
import type { AddonServiceAssignmentRepository } from "../addons/addon-service-assignment.repository.js";
import type {
  AvailabilityResult,
  AvailabilityService,
} from "../availability/availability.service.js";
import { ANY_STAFF } from "../availability/availability.types.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { BusinessCity } from "../business/business.types.js";
import type { BusinessOpeningHoursDay } from "../business-hours/business-hours.model.js";
import type { BusinessHoursRepository } from "../business-hours/business-hours.repository.js";
import type { BusinessMediaDocument } from "../business-media/business-media.model.js";
import type { BusinessMediaRepository } from "../business-media/business-media.repository.js";
import type { ServiceRepository } from "../services/service.repository.js";
import type { StaffRepository } from "../staff/staff.repository.js";
import type { DayOfWeek } from "../staff/staff-schedule.types.js";
import { daysOfWeek } from "../staff/staff-schedule.types.js";
import { formatCanonicalTime12Hour } from "../staff/staff-schedule.utils.js";
import type { StaffAvatarService } from "../staff-avatar/staff-avatar.service.js";
import type { StorageService } from "../storage/storage.service.js";
import type { UserRepository } from "../user/user.repository.js";
import {
  type BusinessCatalogDto,
  type CatalogAddonDto,
  type CatalogBusinessHoursDayDto,
  type CatalogMediaDto,
  type CatalogOpenStatusDto,
  type CatalogStaffDto,
  toCatalogAddonDto,
  toCatalogBusinessDto,
  toCatalogServiceDto,
} from "./catalog.dto.js";
import { CatalogError } from "./catalog.errors.js";

/**
 * Batch 9 — the customer-facing "browse a known Business and book" read surface (see this
 * module's own catalog.dto.ts comment). Deliberately thin: every query is a pass-through to an
 * EXISTING repository already exercised by the Business Owner management surface — this module
 * adds authorization/shaping only, never a second implementation of listing/pricing/eligibility
 * logic. Full marketplace discovery (search, categories, ratings, geo-distance, "recommended"/
 * "trending") is explicitly OUT of this batch's scope (confirmed) — this only resolves a
 * Business the Customer already knows the id of (e.g. from a shared link), matching what the
 * booking wizard actually needs to function end to end.
 */
export class CatalogService {
  public constructor(
    private readonly businessRepository: BusinessRepository,
    private readonly serviceRepository: ServiceRepository,
    private readonly addonRepository: AddonRepository,
    private readonly addonServiceAssignmentRepository: AddonServiceAssignmentRepository,
    private readonly staffRepository: StaffRepository,
    private readonly userRepository: UserRepository,
    private readonly availabilityService: AvailabilityService,
    private readonly businessHoursRepository: BusinessHoursRepository,
    private readonly businessMediaRepository: BusinessMediaRepository,
    private readonly staffAvatarService: Pick<StaffAvatarService, "getAvatarUrlsByUserIds">,
    private readonly storageService: Pick<StorageService, "getObjectUrl">,
  ) {}

  /** The venue page's single combined read: Business header + every bookable (ACTIVE) Service +
   * every active Staff member's display name. No approval-status filter — see this method's own
   * note: no Business in this codebase can ever be anything other than "PENDING" today (no
   * approval workflow exists yet — confirmed during Batch 8's own investigation), so gating on
   * an "APPROVED" status would hide every Business from every Customer. Once a real approval
   * workflow exists, this is the place to add that filter. */
  public async getBusinessCatalog(businessId: string): Promise<BusinessCatalogDto> {
    const business = await this.requireBusiness(businessId);

    const [services, staffMemberships, hoursDoc, media] = await Promise.all([
      this.serviceRepository.listByBusinessId(business._id, { status: "ACTIVE" }),
      this.staffRepository.listActiveByBusinessId(business._id),
      this.businessHoursRepository.findByBusinessId(business._id),
      this.businessMediaRepository.listByBusinessId(business._id),
    ]);

    const [profiles, avatarUrlByUserId] = await Promise.all([
      this.userRepository.findProfilesByUserIds(
        staffMemberships.map((membership) => membership.userId),
      ),
      this.staffAvatarService.getAvatarUrlsByUserIds(
        staffMemberships.map((membership) => String(membership.userId)),
      ),
    ]);
    const profileByUserId = new Map(profiles.map((profile) => [String(profile.userId), profile]));

    const staff: CatalogStaffDto[] = staffMemberships.map((membership) => {
      const profile = profileByUserId.get(String(membership.userId));
      return {
        id: String(membership._id),
        firstName: profile?.firstName ?? "Team",
        lastName: profile?.lastName,
        role: membership.role,
        avatarUrl: avatarUrlByUserId.get(String(membership.userId)),
      };
    });

    const hours = this.toHoursDto(hoursDoc?.days);
    const openStatus = this.computeOpenStatus(business.timezone, hoursDoc?.days);
    const mediaDtos = await this.toMediaDtos(media);

    return {
      business: toCatalogBusinessDto(business, { openStatus, hours, media: mediaDtos }),
      services: services.map(toCatalogServiceDto),
      staff,
    };
  }

  private toHoursDto(days: BusinessOpeningHoursDay[] | undefined): CatalogBusinessHoursDayDto[] {
    if (!days) {
      return [];
    }

    const dayOrder = new Map(daysOfWeek.map((day, index) => [day, index]));
    return [...days]
      .sort((a, b) => (dayOrder.get(a.dayOfWeek) ?? 0) - (dayOrder.get(b.dayOfWeek) ?? 0))
      .map((day) => ({
        dayOfWeek: day.dayOfWeek,
        isOpen: day.isOpen,
        slots: day.slots.map((slot) => ({ startTime: slot.startTime, endTime: slot.endTime })),
      }));
  }

  /** "Is this Business open right now" — reuses business-clock.ts's DST-safe local-time
   * primitives (the same ones the availability engine itself is built on), never a second
   * re-derivation of local weekday/time. A missing Opening Hours document means "not
   * configured" — surfaced explicitly rather than guessed as always-open or always-closed. */
  private computeOpenStatus(
    timezone: string,
    days: BusinessOpeningHoursDay[] | undefined,
  ): CatalogOpenStatusDto {
    if (!days || days.length === 0) {
      return { configured: false, isOpen: false, label: "Hours not available" };
    }

    const now = new Date();
    const { dayOfWeek } = utcToBusinessLocalDate(timezone, now);
    const nowTime = utcToBusinessLocalTime(timezone, now);
    const byDay = new Map(days.map((day) => [day.dayOfWeek, day]));

    const today = byDay.get(dayOfWeek);
    const isOpenNow = Boolean(
      today?.isOpen &&
        today.slots.some((slot) => slot.startTime <= nowTime && nowTime < slot.endTime),
    );

    if (isOpenNow) {
      return { configured: true, isOpen: true, label: "Open now" };
    }

    const next = this.findNextOpening(dayOfWeek, nowTime, byDay);
    if (!next) {
      return { configured: true, isOpen: false, label: "Closed" };
    }

    const label =
      next.dayOfWeek === dayOfWeek
        ? `Closed - opens at ${formatCanonicalTime12Hour(next.startTime)}`
        : `Closed - opens at ${formatCanonicalTime12Hour(next.startTime)} ${this.capitalize(next.dayOfWeek)}`;

    return { configured: true, isOpen: false, label };
  }

  /** Walks forward from today (inclusive) up to 7 days to find the next configured opening
   * slot, so the closed label can say when the Business reopens (matching the existing venue
   * page design's "Closed - opens at 10:30 AM" copy) without ever fabricating a time. */
  private findNextOpening(
    fromDay: DayOfWeek,
    fromTime: string,
    byDay: Map<DayOfWeek, BusinessOpeningHoursDay>,
  ): { dayOfWeek: DayOfWeek; startTime: string } | undefined {
    const startIndex = daysOfWeek.indexOf(fromDay);

    for (let offset = 0; offset < 7; offset += 1) {
      const day = daysOfWeek[(startIndex + offset) % daysOfWeek.length] as DayOfWeek;
      const config = byDay.get(day);
      if (!config?.isOpen || config.slots.length === 0) {
        continue;
      }

      const upcomingSlot = [...config.slots]
        .sort((a, b) => a.startTime.localeCompare(b.startTime))
        .find((slot) => offset > 0 || slot.startTime > fromTime);

      if (upcomingSlot) {
        return { dayOfWeek: day, startTime: upcomingSlot.startTime };
      }
    }

    return undefined;
  }

  private capitalize(value: string): string {
    return value.charAt(0) + value.slice(1).toLowerCase();
  }

  private async toMediaDtos(media: BusinessMediaDocument[]): Promise<CatalogMediaDto[]> {
    const dtos = await Promise.all(
      media.map(async (item) => ({
        id: String(item._id),
        url: await this.storageService.getObjectUrl({ key: item.storageKey }),
        role: item.role,
      })),
    );

    // PROFILE (the cover photo) first, then GALLERY in the repository's own sortOrder —
    // powers the hero banner (first image) without a second, separately-maintained ordering.
    return dtos.sort((a, b) => (a.role === "PROFILE" ? -1 : 0) - (b.role === "PROFILE" ? -1 : 0));
  }

  /** Add-ons assigned to one Service, ACTIVE only — the customer-facing Add-ons step's read. */
  public async listServiceAddons(
    businessId: string,
    serviceId: string,
  ): Promise<CatalogAddonDto[]> {
    const business = await this.requireBusiness(businessId);
    const service = await this.serviceRepository.findById(business._id, serviceId);
    if (service?.status !== "ACTIVE") {
      throw new CatalogError("CATALOG_SERVICE_NOT_FOUND", 404);
    }

    const assignments = await this.addonServiceAssignmentRepository.findByServiceIds([service._id]);
    const addonIds = assignments.map((assignment) => assignment.addonId);
    const addons = await this.addonRepository.findManyByIdsForBusiness(business._id, addonIds);

    return addons.filter((addon) => addon.status === "ACTIVE").map(toCatalogAddonDto);
  }

  /** Customer-facing availability read — the exact same AvailabilityService.getAvailability
   * this codebase's Owner/Supervisor calendar already uses (never a second implementation),
   * just without AvailabilityController's `requireBookingManagementAccess` ownership check
   * (there is none for a Customer browsing a Business they don't own — see this module's own
   * doc comment). `requireBusiness`/`requireBookableService` inside `getAvailability` itself
   * still validates the Service is real/ACTIVE and belongs to this Business. */
  public async getServiceAvailability(
    businessId: string,
    serviceId: string,
    input: {
      fromDate: string;
      toDate: string;
      staffMembershipId?: string | undefined;
      partySize?: number | undefined;
      customerCity?: BusinessCity | undefined;
    },
  ): Promise<AvailabilityResult> {
    await this.requireBusiness(businessId);
    return this.availabilityService.getAvailability({
      businessId,
      serviceId,
      staffMembershipId:
        input.staffMembershipId === ANY_STAFF ? undefined : input.staffMembershipId,
      fromDate: input.fromDate,
      toDate: input.toDate,
      partySize: input.partySize,
      customerCity: input.customerCity,
    });
  }

  private async requireBusiness(businessId: string) {
    if (!/^[a-f\d]{24}$/i.test(businessId)) {
      throw new CatalogError("CATALOG_BUSINESS_NOT_FOUND", 404);
    }
    const business = await this.businessRepository.findById(businessId);
    if (!business) {
      throw new CatalogError("CATALOG_BUSINESS_NOT_FOUND", 404);
    }
    return business;
  }
}
