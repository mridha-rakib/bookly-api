import type { AddonRepository } from "../addons/addon.repository.js";
import type { AddonServiceAssignmentRepository } from "../addons/addon-service-assignment.repository.js";
import type {
  AvailabilityResult,
  AvailabilityService,
} from "../availability/availability.service.js";
import { ANY_STAFF } from "../availability/availability.types.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { BusinessCity } from "../business/business.types.js";
import type { ServiceRepository } from "../services/service.repository.js";
import type { StaffRepository } from "../staff/staff.repository.js";
import type { UserRepository } from "../user/user.repository.js";
import {
  type BusinessCatalogDto,
  type CatalogAddonDto,
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
  ) {}

  /** The venue page's single combined read: Business header + every bookable (ACTIVE) Service +
   * every active Staff member's display name. No approval-status filter — see this method's own
   * note: no Business in this codebase can ever be anything other than "PENDING" today (no
   * approval workflow exists yet — confirmed during Batch 8's own investigation), so gating on
   * an "APPROVED" status would hide every Business from every Customer. Once a real approval
   * workflow exists, this is the place to add that filter. */
  public async getBusinessCatalog(businessId: string): Promise<BusinessCatalogDto> {
    const business = await this.requireBusiness(businessId);

    const [services, staffMemberships] = await Promise.all([
      this.serviceRepository.listByBusinessId(business._id, { status: "ACTIVE" }),
      this.staffRepository.listActiveByBusinessId(business._id),
    ]);

    const profiles = await this.userRepository.findProfilesByUserIds(
      staffMemberships.map((membership) => membership.userId),
    );
    const profileByUserId = new Map(profiles.map((profile) => [String(profile.userId), profile]));

    const staff: CatalogStaffDto[] = staffMemberships.map((membership) => {
      const profile = profileByUserId.get(String(membership.userId));
      return {
        id: String(membership._id),
        firstName: profile?.firstName ?? "Team",
        lastName: profile?.lastName,
      };
    });

    return {
      business: toCatalogBusinessDto(business),
      services: services.map(toCatalogServiceDto),
      staff,
    };
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
