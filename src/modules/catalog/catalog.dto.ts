import type { AddonDocument } from "../addons/addon.model.js";
import type { BusinessAddress, BusinessDocument } from "../business/business.model.js";
import type { BusinessVisitType } from "../business/business.types.js";
import type { BusinessMediaRole } from "../business-media/business-media.model.js";
import type {
  ServiceDocument,
  ServiceFixedPricing,
  ServiceHourlyPricing,
  ServicePackagePricing,
  ServicePerPersonPricing,
} from "../services/service.model.js";
import type { ServicePricingMode } from "../services/service.types.js";
import type { StaffCreatableRole } from "../staff/staff.types.js";
import type { DayOfWeek } from "../staff/staff-schedule.types.js";

/**
 * Batch 9 — the customer-facing "can I book this" read surface. Every DTO here is a deliberately
 * NARROWED, safe-to-expose subset of the existing Owner-facing documents (reusing the SAME
 * repositories/models — never a second source of truth): no email/phone/ownerUserId/internal
 * scheduling knobs (bookingIntervalMin/bufferAfterMin/processingTimeMin — operational detail the
 * Business configures, not something a Customer needs to see or could act on). Authorization is
 * CUSTOMER-role-only at the route level (see catalog.route.ts); there is no ownership dimension
 * to these reads (any Customer may view any Business's bookable catalog), so 404s here are plain
 * "not found," not the anti-enumeration-masked 404 the Owner-management surfaces use.
 */

/** Batch 17 — the venue page's real "open now" read, computed server-side (business-clock.ts,
 * the same DST-safe local-time primitive the availability engine uses) so the frontend never
 * re-derives it from a raw weekly schedule. `configured: false` means the Business never set up
 * Opening Hours at all — distinct from every day being closed — the frontend must show a neutral
 * "hours not available" state, never fabricate an Open/Closed guess. */
export type CatalogOpenStatusDto = {
  configured: boolean;
  isOpen: boolean;
  /** Human-readable, e.g. "Open now", "Closed - opens 10:30 AM Monday", or "Hours not available". */
  label: string;
};

export type CatalogBusinessHoursDayDto = {
  dayOfWeek: DayOfWeek;
  isOpen: boolean;
  slots: { startTime: string; endTime: string }[];
};

export type CatalogMediaDto = {
  id: string;
  url: string;
  role: BusinessMediaRole;
};

export type CatalogBusinessDto = {
  id: string;
  name: string;
  category: string;
  subcategories: string[];
  briefDescription: string;
  visitType: BusinessVisitType;
  timezone: string;
  address: BusinessAddress;
  openStatus: CatalogOpenStatusDto;
  hours: CatalogBusinessHoursDayDto[];
  /** Business Media (business-media module), PROFILE first then GALLERY by sortOrder — powers
   * both the hero banner and the Gallery tab; never a second, separately-uploaded set of images. */
  media: CatalogMediaDto[];
};

export const toCatalogBusinessDto = (
  business: BusinessDocument,
  extra: {
    openStatus: CatalogOpenStatusDto;
    hours: CatalogBusinessHoursDayDto[];
    media: CatalogMediaDto[];
  },
): CatalogBusinessDto => ({
  id: String(business._id),
  name: business.name,
  category: business.category,
  subcategories: business.subcategories,
  briefDescription: business.briefDescription,
  visitType: business.visitType,
  timezone: business.timezone,
  address: business.address,
  openStatus: extra.openStatus,
  hours: extra.hours,
  media: extra.media,
});

export type CatalogServiceDto = {
  id: string;
  name: string;
  description?: string | undefined;
  category: string;
  subcategory?: string | undefined;
  isFeatured: boolean;
  isPackageDeal: boolean;
  pricingMode?: ServicePricingMode | undefined;
  fixedPricing?:
    | Pick<ServiceFixedPricing, "priceCents" | "durationMin" | "discountPercent">
    | undefined;
  hourlyPricing?:
    | Pick<ServiceHourlyPricing, "ratePerHourCents" | "minHours" | "maxHours">
    | undefined;
  perPersonPricing?:
    | Pick<
        ServicePerPersonPricing,
        "ratePerPersonCents" | "minPersons" | "maxPersons" | "durationMin"
      >
    | undefined;
  packagePricing?:
    | Pick<
        ServicePackagePricing,
        "bundlePriceCents" | "sessionsInPackage" | "durationMin" | "discountPercent"
      >
    | undefined;
  servedCities: string[];
  /** Which existing Staff memberships may perform this Service — the customer-facing
   * "Professionals" step filters against this, exactly the same eligibility set
   * AvailabilityService itself uses (see availability.service.ts's own resolveEligibleStaff) —
   * never a separately re-derived list. */
  assignedStaffMembershipIds: string[];
};

export const toCatalogServiceDto = (service: ServiceDocument): CatalogServiceDto => ({
  id: String(service._id),
  name: service.name,
  description: service.description,
  category: service.category,
  subcategory: service.subcategory,
  isFeatured: service.isFeatured,
  isPackageDeal: service.isPackageDeal,
  pricingMode: service.pricingMode,
  fixedPricing: service.fixedPricing
    ? {
        priceCents: service.fixedPricing.priceCents,
        durationMin: service.fixedPricing.durationMin,
        discountPercent: service.fixedPricing.discountPercent,
      }
    : undefined,
  hourlyPricing: service.hourlyPricing
    ? {
        ratePerHourCents: service.hourlyPricing.ratePerHourCents,
        minHours: service.hourlyPricing.minHours,
        maxHours: service.hourlyPricing.maxHours,
      }
    : undefined,
  perPersonPricing: service.perPersonPricing
    ? {
        ratePerPersonCents: service.perPersonPricing.ratePerPersonCents,
        minPersons: service.perPersonPricing.minPersons,
        maxPersons: service.perPersonPricing.maxPersons,
        durationMin: service.perPersonPricing.durationMin,
      }
    : undefined,
  packagePricing: service.packagePricing
    ? {
        bundlePriceCents: service.packagePricing.bundlePriceCents,
        sessionsInPackage: service.packagePricing.sessionsInPackage,
        durationMin: service.packagePricing.durationMin,
        discountPercent: service.packagePricing.discountPercent,
      }
    : undefined,
  servedCities: service.servedCities,
  assignedStaffMembershipIds: service.assignedStaffMembershipIds.map(String),
});

export type CatalogStaffDto = {
  id: string;
  firstName: string;
  lastName?: string | undefined;
  /** StaffMembership.role — the only real "team" job-role field this codebase has (no separate
   * display title like "Hairdresser"/"Beautician" exists on any model); the frontend displays
   * this as-is (e.g. "Staff", "Supervisor"). */
  role: StaffCreatableRole;
  avatarUrl?: string | undefined;
};

export type CatalogAddonDto = {
  id: string;
  name: string;
  description?: string | undefined;
  priceCents?: number | undefined;
};

export const toCatalogAddonDto = (addon: AddonDocument): CatalogAddonDto => ({
  id: String(addon._id),
  name: addon.name,
  description: addon.description,
  priceCents: addon.priceCents,
});

export type BusinessCatalogDto = {
  business: CatalogBusinessDto;
  services: CatalogServiceDto[];
  staff: CatalogStaffDto[];
};
