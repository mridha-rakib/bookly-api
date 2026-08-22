import { Types } from "mongoose";

import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { BusinessCity } from "../business/business.types.js";
import type { BusinessTravelSettingsRepository } from "../business-travel-settings/business-travel-settings.repository.js";
import type { StaffMembershipDocument } from "../staff/staff.model.js";
import type { StaffRepository } from "../staff/staff.repository.js";
import type { StaffAvatarService } from "../staff-avatar/staff-avatar.service.js";
import type { UserRepository } from "../user/user.repository.js";
import { ServiceError } from "./service.errors.js";
import type {
  ServiceDocument,
  ServiceFixedPricing,
  ServiceHourlyPricing,
  ServiceManualScheduleDay,
  ServicePackagePricing,
  ServicePerPersonPricing,
  ServiceSessionExpiryAlert,
} from "./service.model.js";
import type {
  CreateServiceInput,
  ReplaceServiceFields,
  ServiceListFilter,
  ServiceRepository,
  ServiceStatusCounts,
} from "./service.repository.js";
import type { CreateServiceBody, UpdateServiceBody } from "./service.schema.js";
import type { ServicePricingMode, ServiceScheduleMode, ServiceStatus } from "./service.types.js";
import type { ServiceCategoryDocument } from "./service-category.model.js";
import type { ServiceCategoryRepository } from "./service-category.repository.js";

export type ServiceCategoryDto = {
  id: string;
  businessId: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AssignedStaffDto = {
  membershipId: string;
  userId: string;
  name: string;
  avatarUrl?: string | undefined;
  employmentActive: boolean;
};

export type ServiceDto = {
  id: string;
  businessId: string;
  status: ServiceStatus;
  isFeatured: boolean;
  isPackageDeal: boolean;
  category: string;
  subcategory?: string | undefined;
  serviceCategoryId?: string | undefined;
  serviceCategoryName?: string | undefined;
  name: string;
  packageServicesName?: string | undefined;
  description?: string | undefined;
  pricingMode?: ServicePricingMode | undefined;
  fixedPricing?: ServiceFixedPricing | undefined;
  hourlyPricing?: ServiceHourlyPricing | undefined;
  perPersonPricing?: ServicePerPersonPricing | undefined;
  packagePricing?: ServicePackagePricing | undefined;
  sessionExpiryAlert: ServiceSessionExpiryAlert;
  scheduleMode: ServiceScheduleMode;
  manualSchedule: ServiceManualScheduleDay[];
  servedCities: BusinessCity[];
  assignedStaff: AssignedStaffDto[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | undefined;
};

export type ServiceListDto = {
  services: ServiceDto[];
  counts: ServiceStatusCounts;
};

export class ServiceService {
  public constructor(
    private readonly serviceRepository: ServiceRepository,
    private readonly serviceCategoryRepository: ServiceCategoryRepository,
    private readonly businessRepository: BusinessRepository,
    private readonly businessTravelSettingsRepository: BusinessTravelSettingsRepository,
    private readonly staffRepository: StaffRepository,
    private readonly userRepository: UserRepository,
    private readonly staffAvatarService: StaffAvatarService,
  ) {}

  // --- Service Categories -----------------------------------------------------------------

  public async listCategories(
    actorUserId: string,
    businessId: string,
    includeInactive: boolean,
  ): Promise<ServiceCategoryDto[]> {
    const business = await this.requireOwnedBusiness(actorUserId, businessId);
    const categories = await this.serviceCategoryRepository.listByBusinessId(business._id, {
      includeInactive,
    });
    return categories.map((category) => this.toCategoryDto(category));
  }

  public async createCategory(
    actorUserId: string,
    businessId: string,
    name: string,
  ): Promise<ServiceCategoryDto> {
    const business = await this.requireOwnedBusiness(actorUserId, businessId);
    const nameKey = this.normalizeNameKey(name);
    const existing = await this.serviceCategoryRepository.findByNameKey(business._id, nameKey);

    if (existing) {
      throw new ServiceError("SERVICE_CATEGORY_ALREADY_EXISTS", 409);
    }

    const category = await this.serviceCategoryRepository.create({
      businessId: business._id,
      name: name.trim(),
      nameKey,
    });

    return this.toCategoryDto(category);
  }

  public async updateCategory(
    actorUserId: string,
    businessId: string,
    categoryId: string,
    input: { name?: string | undefined; active?: boolean | undefined },
  ): Promise<ServiceCategoryDto> {
    const business = await this.requireOwnedBusiness(actorUserId, businessId);
    const existing = await this.serviceCategoryRepository.findById(business._id, categoryId);

    if (!existing) {
      throw new ServiceError("SERVICE_CATEGORY_NOT_FOUND", 404);
    }

    const update: Partial<Pick<ServiceCategoryDocument, "name" | "nameKey" | "active">> = {};

    if (input.name !== undefined) {
      const nameKey = this.normalizeNameKey(input.name);
      const duplicate = await this.serviceCategoryRepository.findByNameKey(business._id, nameKey);

      if (duplicate && String(duplicate._id) !== String(existing._id)) {
        throw new ServiceError("SERVICE_CATEGORY_ALREADY_EXISTS", 409);
      }

      update.name = input.name.trim();
      update.nameKey = nameKey;
    }

    if (input.active !== undefined) {
      update.active = input.active;
    }

    const updated = await this.serviceCategoryRepository.updateById(
      business._id,
      categoryId,
      update,
    );

    if (!updated) {
      throw new ServiceError("SERVICE_CATEGORY_NOT_FOUND", 404);
    }

    return this.toCategoryDto(updated);
  }

  // --- Services ----------------------------------------------------------------------------

  public async listServices(
    actorUserId: string,
    businessId: string,
    filter: ServiceListFilter,
  ): Promise<ServiceListDto> {
    const business = await this.requireOwnedBusiness(actorUserId, businessId);

    const [services, counts] = await Promise.all([
      this.serviceRepository.listByBusinessId(business._id, filter),
      this.serviceRepository.countByStatus(business._id),
    ]);

    const dtos = await this.toServiceDtos(business, services);

    return { services: dtos, counts };
  }

  public async getService(
    actorUserId: string,
    businessId: string,
    serviceId: string,
  ): Promise<ServiceDto> {
    const business = await this.requireOwnedBusiness(actorUserId, businessId);
    const service = await this.serviceRepository.findById(business._id, serviceId);

    if (!service) {
      throw new ServiceError("SERVICE_NOT_FOUND", 404);
    }

    const [dto] = await this.toServiceDtos(business, [service]);
    return dto as ServiceDto;
  }

  public async createService(
    actorUserId: string,
    businessId: string,
    body: CreateServiceBody,
  ): Promise<ServiceDto> {
    const business = await this.requireOwnedBusiness(actorUserId, businessId);
    const fields = await this.buildServiceFields(business, body);

    const input: CreateServiceInput = {
      businessId: business._id,
      status: body.status,
      ...fields,
    };

    const created = await this.serviceRepository.create(input);
    const [dto] = await this.toServiceDtos(business, [created]);
    return dto as ServiceDto;
  }

  public async updateService(
    actorUserId: string,
    businessId: string,
    serviceId: string,
    body: UpdateServiceBody,
  ): Promise<ServiceDto> {
    const business = await this.requireOwnedBusiness(actorUserId, businessId);
    const existing = await this.serviceRepository.findById(business._id, serviceId);

    if (!existing || existing.status === "ARCHIVED") {
      throw new ServiceError("SERVICE_NOT_FOUND", 404);
    }

    const fields = await this.buildServiceFields(business, body);
    // status travels in the same full-replace body as everything else now — the Zod layer
    // already guarantees ACTIVE/INACTIVE only reach here with a fully valid payload (DRAFT
    // tolerates partial data), so no separate status-transition call is needed.
    const replaced = await this.serviceRepository.replaceById(business._id, serviceId, {
      ...fields,
      status: body.status,
    } as ReplaceServiceFields);

    if (!replaced) {
      throw new ServiceError("SERVICE_NOT_FOUND", 404);
    }

    const [dto] = await this.toServiceDtos(business, [replaced]);
    return dto as ServiceDto;
  }

  public async updateServiceStatus(
    actorUserId: string,
    businessId: string,
    serviceId: string,
    status: Extract<ServiceStatus, "ACTIVE" | "INACTIVE">,
  ): Promise<ServiceDto> {
    const business = await this.requireOwnedBusiness(actorUserId, businessId);
    const updated = await this.serviceRepository.updateStatusById(business._id, serviceId, status);

    if (!updated) {
      // Distinguish "still a draft" from "doesn't exist / archived" so the UI can explain why
      // the quick toggle didn't work, rather than a generic not-found.
      const existing = await this.serviceRepository.findById(business._id, serviceId);
      if (existing?.status === "DRAFT") {
        throw new ServiceError("SERVICE_DRAFT_CANNOT_TOGGLE", 409);
      }
      throw new ServiceError("SERVICE_NOT_FOUND", 404);
    }

    const [dto] = await this.toServiceDtos(business, [updated]);
    return dto as ServiceDto;
  }

  public async archiveService(
    actorUserId: string,
    businessId: string,
    serviceId: string,
  ): Promise<void> {
    const business = await this.requireOwnedBusiness(actorUserId, businessId);
    const existing = await this.serviceRepository.findById(business._id, serviceId);

    if (!existing) {
      throw new ServiceError("SERVICE_NOT_FOUND", 404);
    }

    if (existing.status === "ARCHIVED") {
      throw new ServiceError("SERVICE_ALREADY_ARCHIVED", 409);
    }

    await this.serviceRepository.archiveById(business._id, serviceId);
  }

  public async restoreService(
    actorUserId: string,
    businessId: string,
    serviceId: string,
    status: Extract<ServiceStatus, "ACTIVE" | "INACTIVE">,
  ): Promise<ServiceDto> {
    const business = await this.requireOwnedBusiness(actorUserId, businessId);
    const existing = await this.serviceRepository.findById(business._id, serviceId);

    if (!existing) {
      throw new ServiceError("SERVICE_NOT_FOUND", 404);
    }

    if (existing.status !== "ARCHIVED") {
      throw new ServiceError("SERVICE_NOT_ARCHIVED", 409);
    }

    const restored = await this.serviceRepository.restoreById(business._id, serviceId, status);

    if (!restored) {
      throw new ServiceError("SERVICE_NOT_FOUND", 404);
    }

    const [dto] = await this.toServiceDtos(business, [restored]);
    return dto as ServiceDto;
  }

  // --- Validation / field building ----------------------------------------------------------

  /**
   * DRAFT tolerates missing serviceCategoryId/subcategory (skips their cross-collection
   * checks entirely) but whatever IS supplied — draft or not — still has to be a real,
   * currently-valid reference: a draft may omit a category, but it may never point at another
   * business's category or a nonsense id.
   */
  private async buildServiceFields(
    business: BusinessDocument,
    body: CreateServiceBody | UpdateServiceBody,
  ): Promise<Omit<CreateServiceInput, "businessId" | "status">> {
    const category =
      body.serviceCategoryId !== undefined
        ? await this.requireActiveCategory(business, body.serviceCategoryId)
        : undefined;
    if (body.subcategory !== undefined) {
      this.requireValidSubcategory(business, body.subcategory);
    }
    await this.requireValidStaffMemberships(business, body.assignedStaffMembershipIds);
    const servedCities = await this.requireValidServedCities(business, body.servedCities);

    return {
      isFeatured: body.isFeatured,
      isPackageDeal: body.isPackageDeal,
      category: business.category,
      subcategory: body.subcategory,
      serviceCategoryId: category?._id,
      name: body.name,
      packageServicesName: body.packageServicesName,
      description: body.description,
      pricingMode: body.pricingMode,
      fixedPricing: body.fixedPricing,
      hourlyPricing: body.hourlyPricing,
      perPersonPricing: body.perPersonPricing,
      packagePricing: body.packagePricing,
      sessionExpiryAlert: body.sessionExpiryAlert ?? { enabled: false },
      scheduleMode: body.scheduleMode,
      manualSchedule: body.manualSchedule ?? [],
      servedCities,
      assignedStaffMembershipIds: body.assignedStaffMembershipIds.map(
        (id) => new Types.ObjectId(id),
      ),
    };
  }

  private async requireActiveCategory(
    business: BusinessDocument,
    categoryId: string,
  ): Promise<ServiceCategoryDocument> {
    if (!Types.ObjectId.isValid(categoryId)) {
      throw new ServiceError("SERVICE_CATEGORY_NOT_FOUND", 404);
    }

    const category = await this.serviceCategoryRepository.findActiveById(business._id, categoryId);

    if (!category) {
      throw new ServiceError("SERVICE_CATEGORY_NOT_FOUND", 404);
    }

    return category;
  }

  private requireValidSubcategory(business: BusinessDocument, subcategory: string): void {
    if (!business.subcategories.includes(subcategory)) {
      throw new ServiceError("SERVICE_SUBCATEGORY_INVALID", 400);
    }
  }

  private async requireValidStaffMemberships(
    business: BusinessDocument,
    staffMembershipIds: string[],
  ): Promise<void> {
    if (staffMembershipIds.length === 0) {
      return;
    }

    if (!staffMembershipIds.every((id) => Types.ObjectId.isValid(id))) {
      throw new ServiceError("SERVICE_STAFF_INVALID", 400);
    }

    const memberships = await this.staffRepository.findManyByIdsForBusiness(
      business._id,
      staffMembershipIds,
    );

    if (memberships.length !== new Set(staffMembershipIds).size) {
      // Covers: unknown id, and a membership id belonging to a different Business —
      // findManyByIdsForBusiness already scopes by businessId, so cross-business
      // assignment is rejected here rather than silently dropped.
      throw new ServiceError("SERVICE_STAFF_INVALID", 400);
    }
  }

  private async requireValidServedCities(
    business: BusinessDocument,
    servedCities: BusinessCity[],
  ): Promise<BusinessCity[]> {
    if (business.visitType === "AT_BUSINESS_LOCATION") {
      if (servedCities.length > 0) {
        throw new ServiceError("SERVICE_CITIES_NOT_APPLICABLE", 400);
      }
      return [];
    }

    if (servedCities.length === 0) {
      return [];
    }

    const travelSettings = await this.businessTravelSettingsRepository.findByBusinessId(
      business._id,
    );
    const activeCities = new Set(
      (travelSettings?.cities ?? []).filter((city) => city.active).map((city) => city.city),
    );

    if (!servedCities.every((city) => activeCities.has(city))) {
      throw new ServiceError("SERVICE_CITY_NOT_SERVED", 400);
    }

    return servedCities;
  }

  // --- Authorization -------------------------------------------------------------------------

  /**
   * Services are Business-Owner-only management functionality (confirmed product rule) — no
   * BusinessAccess (linked/secondary Business) fallback anywhere in this method, unlike
   * business-travel-settings' read path. 404 on any ownership mismatch (never a bare 403) so
   * a forged businessId cannot be used to probe for another owner's business existing.
   */
  private async requireOwnedBusiness(
    actorUserId: string,
    businessId: string,
  ): Promise<BusinessDocument> {
    if (!Types.ObjectId.isValid(businessId)) {
      throw new ServiceError("SERVICE_BUSINESS_NOT_FOUND", 404);
    }

    const business = await this.businessRepository.findById(businessId);

    if (!business) {
      throw new ServiceError("SERVICE_BUSINESS_NOT_FOUND", 404);
    }

    if (!business.ownerUserId.equals(actorUserId)) {
      throw new ServiceError("SERVICE_BUSINESS_NOT_FOUND", 404);
    }

    return business;
  }

  // --- DTO mapping -----------------------------------------------------------------------

  private normalizeNameKey(name: string): string {
    return name.trim().toLowerCase();
  }

  private toCategoryDto(category: ServiceCategoryDocument): ServiceCategoryDto {
    return {
      id: String(category._id),
      businessId: String(category.businessId),
      name: category.name,
      active: category.active,
      createdAt: category.createdAt.toISOString(),
      updatedAt: category.updatedAt.toISOString(),
    };
  }

  /**
   * Batches every cross-collection lookup needed to render a page of Services: category
   * names (one $in query) and assigned-staff identity + avatars (one membership query, one
   * User query, one avatar-URL query) — never one query per Service regardless of how many
   * are returned.
   */
  private async toServiceDtos(
    business: BusinessDocument,
    services: ServiceDocument[],
  ): Promise<ServiceDto[]> {
    const categoryIds = [
      ...new Set(
        services
          .map((service) => service.serviceCategoryId)
          .filter((id): id is Types.ObjectId => id !== undefined)
          .map((id) => String(id)),
      ),
    ];
    const staffMembershipIds = [
      ...new Set(
        services.flatMap((service) => service.assignedStaffMembershipIds.map((id) => String(id))),
      ),
    ];

    const [categories, memberships] = await Promise.all([
      this.serviceCategoryRepository.findManyByIdsForBusiness(business._id, categoryIds),
      this.staffRepository.findManyByIdsForBusiness(business._id, staffMembershipIds),
    ]);

    const categoryById = new Map(
      categories
        .filter((category): category is ServiceCategoryDocument => category !== null)
        .map((category) => [String(category._id), category]),
    );

    const userIds = [...new Set(memberships.map((membership) => String(membership.userId)))];
    const [users, profiles, avatarUrlByUserId] = await Promise.all([
      this.userRepository.findManyByIds(userIds),
      this.userRepository.findProfilesByUserIds(userIds),
      this.staffAvatarService.getAvatarUrlsByUserIds(userIds),
    ]);

    const userById = new Map(users.map((user) => [String(user._id), user]));
    const profileById = new Map(profiles.map((profile) => [String(profile.userId), profile]));
    const membershipById = new Map(
      memberships.map((membership) => [String(membership._id), membership]),
    );

    return services.map((service) =>
      this.toServiceDto(
        service,
        categoryById,
        membershipById,
        userById,
        profileById,
        avatarUrlByUserId,
      ),
    );
  }

  private toServiceDto(
    service: ServiceDocument,
    categoryById: Map<string, ServiceCategoryDocument>,
    membershipById: Map<string, StaffMembershipDocument>,
    userById: Map<string, { normalizedEmail: string }>,
    profileById: Map<string, { firstName: string; lastName: string }>,
    avatarUrlByUserId: Map<string, string>,
  ): ServiceDto {
    const category =
      service.serviceCategoryId !== undefined
        ? categoryById.get(String(service.serviceCategoryId))
        : undefined;

    const assignedStaff: AssignedStaffDto[] = service.assignedStaffMembershipIds
      .map((id) => membershipById.get(String(id)))
      .filter((membership): membership is StaffMembershipDocument => membership !== undefined)
      .map((membership) => {
        const userId = String(membership.userId);
        const profile = profileById.get(userId);
        const name = profile
          ? `${profile.firstName} ${profile.lastName}`.trim()
          : (userById.get(userId)?.normalizedEmail ?? "Unknown");

        return {
          membershipId: String(membership._id),
          userId,
          name,
          avatarUrl: avatarUrlByUserId.get(userId),
          employmentActive: membership.employmentActive,
        };
      });

    return {
      id: String(service._id),
      businessId: String(service.businessId),
      status: service.status,
      isFeatured: service.isFeatured,
      isPackageDeal: service.isPackageDeal,
      category: service.category,
      subcategory: service.subcategory,
      serviceCategoryId:
        service.serviceCategoryId !== undefined ? String(service.serviceCategoryId) : undefined,
      serviceCategoryName: category?.name,
      name: service.name,
      packageServicesName: service.packageServicesName,
      description: service.description,
      pricingMode: service.pricingMode,
      fixedPricing: service.fixedPricing,
      hourlyPricing: service.hourlyPricing,
      perPersonPricing: service.perPersonPricing,
      packagePricing: service.packagePricing,
      sessionExpiryAlert: service.sessionExpiryAlert,
      scheduleMode: service.scheduleMode,
      manualSchedule: service.manualSchedule,
      servedCities: service.servedCities,
      assignedStaff,
      createdAt: service.createdAt.toISOString(),
      updatedAt: service.updatedAt.toISOString(),
      archivedAt: service.archivedAt?.toISOString(),
    };
  }
}
