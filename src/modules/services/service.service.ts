import { Types } from "mongoose";

import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { BusinessCity } from "../business/business.types.js";
import type { BusinessTravelSettingsRepository } from "../business-travel-settings/business-travel-settings.repository.js";
import type { PackageProgressRepository } from "../package-progress/package-progress.repository.js";
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
import { updateServiceBodySchema } from "./service.schema.js";
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
    private readonly packageProgressRepository?: Pick<
      PackageProgressRepository,
      "hasOutstandingEntitlementsForService"
    >,
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

    if (!existing) {
      throw new ServiceError("SERVICE_NOT_FOUND", 404);
    }

    const fields = await this.buildServiceFields(business, body);
    // Bug fix: editing an ARCHIVED Service is a repair flow, never an implicit restore — only
    // the explicit Restore action (ServiceService.restoreService, which re-runs the full
    // ACTIVE/INACTIVE publish validation) may unarchive. `body.status` still selects which
    // completeness rules buildServiceFields/updateServiceBodySchema's own superRefine already
    // applied above (DRAFT tolerates partial data, letting the Owner save an intermediate
    // repair; ACTIVE/INACTIVE do not) — it just never becomes the PERSISTED value while the
    // Service is ARCHIVED. `archivedAt` is untouched either way: it isn't part of
    // ReplaceServiceFields, so replaceById's $set can never write it.
    const persistedStatus = existing.status === "ARCHIVED" ? "ARCHIVED" : body.status;
    const replaced = await this.serviceRepository.replaceById(business._id, serviceId, {
      ...fields,
      status: persistedStatus,
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

    // Approved rule: ARCHIVED is blocked while outstanding Package entitlements (unused,
    // unvoided purchased sessions) exist for this Service — archiving must never strand a
    // customer who already paid for sessions they haven't used yet. INACTIVE already blocks new
    // purchases (see resolveServiceLines's own ACTIVE-only gate) without this restriction —
    // existing customers keep redeeming an INACTIVE Package Deal, so only ARCHIVED needs it.
    if (existing.isPackageDeal && this.packageProgressRepository) {
      const hasOutstanding =
        await this.packageProgressRepository.hasOutstandingEntitlementsForService(
          business._id,
          serviceId,
        );
      if (hasOutstanding) {
        throw new ServiceError("SERVICE_ARCHIVE_BLOCKED_BY_PACKAGE_ENTITLEMENTS", 409);
      }
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

    // Bug fix: restore used to bypass the exact same completeness/publish validation
    // create/update already enforce for ACTIVE/INACTIVE — an incomplete Service (e.g. archived
    // while still an incomplete DRAFT, or one whose category/staff/served-city later became
    // invalid while it sat archived) could be restored straight to ACTIVE. This re-runs that
    // SAME validation (never a second, independently-invented rule set) against the Service's
    // current persisted fields before allowing the status change; on failure nothing is written
    // — the Service stays ARCHIVED exactly as it was.
    await this.assertRestorableToStatus(business, existing, status);

    const restored = await this.serviceRepository.restoreById(business._id, serviceId, status);

    if (!restored) {
      throw new ServiceError("SERVICE_NOT_FOUND", 404);
    }

    const [dto] = await this.toServiceDtos(business, [restored]);
    return dto as ServiceDto;
  }

  /**
   * Reuses the EXACT same publish/activation validation create/update already run for
   * ACTIVE/INACTIVE — never a second, independently-maintained rule set:
   *  1. `updateServiceBodySchema`'s own presence/consistency `superRefine` (required category,
   *     subcategory, sessionExpiryAlert, pricing block for the selected mode, Package Deal
   *     fields, manual-schedule requirements, etc.) — the same schema `updateService`'s route
   *     validates a request body against, run here against the Service's OWN current persisted
   *     fields reshaped into that exact body shape.
   *  2. `buildServiceFields`'s cross-collection checks (category still exists/active, staff
   *     still belongs to this Business, served cities still enabled) — catches a Service whose
   *     references went stale WHILE it sat archived (e.g. its category was deactivated
   *     meanwhile), which the schema alone cannot see.
   * Throws (never returns a partial result) on the first failure from either layer — the
   * schema's own generic issue becomes `SERVICE_RESTORE_INCOMPLETE`; buildServiceFields's own
   * specific errors (SERVICE_CATEGORY_NOT_FOUND, SERVICE_STAFF_INVALID, etc.) propagate verbatim
   * since they are already more actionable than a generic wrapper.
   */
  private async assertRestorableToStatus(
    business: BusinessDocument,
    existing: ServiceDocument,
    status: Extract<ServiceStatus, "ACTIVE" | "INACTIVE">,
  ): Promise<void> {
    // `existing` is a live Mongoose document — its embedded objects (sessionExpiryAlert,
    // fixedPricing, manualSchedule entries, ...) are Mongoose subdocument instances, not plain
    // objects, and Zod's `.strict()` object check rejects their non-enumerable-looking internal
    // properties. `.toObject()` is Mongoose's own, already-existing plain-object conversion —
    // reused here rather than hand-rewriting every nested shape.
    const plain = (existing as unknown as { toObject: () => ServiceDocument }).toObject();

    const candidateBody: UpdateServiceBody = {
      status,
      isFeatured: plain.isFeatured,
      isPackageDeal: plain.isPackageDeal,
      serviceCategoryId: plain.serviceCategoryId ? String(plain.serviceCategoryId) : undefined,
      subcategory: plain.subcategory,
      name: plain.name,
      packageServicesName: plain.packageServicesName,
      description: plain.description,
      pricingMode: plain.pricingMode,
      fixedPricing: plain.fixedPricing,
      hourlyPricing: plain.hourlyPricing,
      perPersonPricing: plain.perPersonPricing,
      packagePricing: plain.packagePricing,
      sessionExpiryAlert: plain.sessionExpiryAlert,
      scheduleMode: plain.scheduleMode,
      manualSchedule: plain.manualSchedule,
      servedCities: plain.servedCities,
      assignedStaffMembershipIds: plain.assignedStaffMembershipIds.map(String),
    };

    const parsed = updateServiceBodySchema.safeParse(candidateBody);
    if (!parsed.success) {
      throw new ServiceError("SERVICE_RESTORE_INCOMPLETE", 409);
    }

    await this.buildServiceFields(business, parsed.data);
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

    // Bug fix: a removed StaffMembership row is never deleted (soft-remove — see
    // staff.model.ts's own removedAt comment), and removal also sets employmentActive: false
    // (see StaffRepository.softRemoveById), so findManyByIdsForBusiness above happily "found"
    // it — this check alone used to treat that as a valid assignment. Every Service update is a
    // full replace of the whole assignedStaffMembershipIds array (see replaceById's own doc
    // comment), so simply rejecting any inactive/removed id here is exactly equivalent to
    // requiring the Owner to actually remove a stale assignment before a save can succeed — an
    // update that omits it (the Owner unchecked it) still only submits the remaining valid ids
    // and passes fine. Never touches already-persisted data by itself; this only gates a new
    // write.
    if (memberships.some((membership) => !membership.employmentActive || membership.removedAt)) {
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
