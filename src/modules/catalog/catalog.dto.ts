import type { AddonDocument } from "../addons/addon.model.js";
import type { BusinessAddress, BusinessDocument } from "../business/business.model.js";
import type { BusinessVisitType } from "../business/business.types.js";
import type {
  ServiceDocument,
  ServiceFixedPricing,
  ServiceHourlyPricing,
  ServicePackagePricing,
  ServicePerPersonPricing,
} from "../services/service.model.js";
import type { ServicePricingMode } from "../services/service.types.js";

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

export type CatalogBusinessDto = {
  id: string;
  name: string;
  category: string;
  subcategories: string[];
  briefDescription: string;
  visitType: BusinessVisitType;
  timezone: string;
  address: BusinessAddress;
};

export const toCatalogBusinessDto = (business: BusinessDocument): CatalogBusinessDto => ({
  id: String(business._id),
  name: business.name,
  category: business.category,
  subcategories: business.subcategories,
  briefDescription: business.briefDescription,
  visitType: business.visitType,
  timezone: business.timezone,
  address: business.address,
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
