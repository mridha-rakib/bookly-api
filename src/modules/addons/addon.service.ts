import { Types } from "mongoose";

import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import type { ServiceDocument } from "../services/service.model.js";
import type { ServiceRepository } from "../services/service.repository.js";
import type { ServiceStatus } from "../services/service.types.js";
import type { ServiceCategoryDocument } from "../services/service-category.model.js";
import type { ServiceCategoryRepository } from "../services/service-category.repository.js";
import { AddonError } from "./addon.errors.js";
import type { AddonDocument } from "./addon.model.js";
import type {
  AddonListFilter,
  AddonRepository,
  AddonStatusCounts,
  CreateAddonInput,
  ReplaceAddonFields,
} from "./addon.repository.js";
import type { CreateAddonBody, UpdateAddonBody } from "./addon.schema.js";
import type { AddonStatus } from "./addon.types.js";
import type { AddonServiceAssignmentDocument } from "./addon-service-assignment.model.js";
import type { AddonServiceAssignmentRepository } from "./addon-service-assignment.repository.js";

export type AddonAssignedServiceDto = {
  serviceId: string;
  name: string;
  status: ServiceStatus;
};

export type AddonDto = {
  id: string;
  businessId: string;
  status: AddonStatus;
  name: string;
  description?: string | undefined;
  /** Flat fee in integer cents — never a formatted string. */
  priceCents?: number | undefined;
  customServiceCategoryId?: string | undefined;
  customServiceCategoryName?: string | undefined;
  assignedServices: AddonAssignedServiceDto[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | undefined;
};

export type AddonListDto = {
  addons: AddonDto[];
  counts: AddonStatusCounts;
};

/** Read-only summary used by Service Edit/View's "Assigned Add-ons" section. */
export type ServiceAssignedAddonDto = {
  addonId: string;
  name: string;
  status: AddonStatus;
  priceCents?: number | undefined;
};

export class AddonService {
  public constructor(
    private readonly addonRepository: AddonRepository,
    private readonly addonServiceAssignmentRepository: AddonServiceAssignmentRepository,
    private readonly businessRepository: BusinessRepository,
    private readonly serviceCategoryRepository: ServiceCategoryRepository,
    private readonly serviceRepository: ServiceRepository,
  ) {}

  public async listAddons(
    actorUserId: string,
    businessId: string,
    filter: AddonListFilter,
  ): Promise<AddonListDto> {
    const business = await this.requireOwnedBusiness(actorUserId, businessId);

    const [addons, counts] = await Promise.all([
      this.addonRepository.listByBusinessId(business._id, filter),
      this.addonRepository.countByStatus(business._id),
    ]);

    const dtos = await this.toAddonDtos(business, addons);
    return { addons: dtos, counts };
  }

  public async getAddon(
    actorUserId: string,
    businessId: string,
    addonId: string,
  ): Promise<AddonDto> {
    const business = await this.requireOwnedBusiness(actorUserId, businessId);
    const addon = await this.addonRepository.findById(business._id, addonId);

    if (!addon) {
      throw new AddonError("ADDON_NOT_FOUND", 404);
    }

    const [dto] = await this.toAddonDtos(business, [addon]);
    return dto as AddonDto;
  }

  public async createAddon(
    actorUserId: string,
    businessId: string,
    body: CreateAddonBody,
  ): Promise<AddonDto> {
    const business = await this.requireOwnedBusiness(actorUserId, businessId);
    const fields = await this.buildAddonFields(business, body);

    const input: CreateAddonInput = {
      businessId: business._id,
      status: body.status,
      name: body.name,
      description: fields.description,
      priceCents: fields.priceCents,
      customServiceCategoryId: fields.category?._id,
    };

    const created = await this.addonRepository.create(input);
    await this.syncServiceAssignments(business, created._id, fields.assignedServiceIds);

    const [dto] = await this.toAddonDtos(business, [created]);
    return dto as AddonDto;
  }

  public async updateAddon(
    actorUserId: string,
    businessId: string,
    addonId: string,
    body: UpdateAddonBody,
  ): Promise<AddonDto> {
    const business = await this.requireOwnedBusiness(actorUserId, businessId);
    const existing = await this.addonRepository.findById(business._id, addonId);

    if (!existing || existing.status === "ARCHIVED") {
      throw new AddonError("ADDON_NOT_FOUND", 404);
    }

    const fields = await this.buildAddonFields(business, body);
    const replaced = await this.addonRepository.replaceById(business._id, addonId, {
      status: body.status,
      name: body.name,
      description: fields.description,
      priceCents: fields.priceCents,
      customServiceCategoryId: fields.category?._id,
    } as ReplaceAddonFields);

    if (!replaced) {
      throw new AddonError("ADDON_NOT_FOUND", 404);
    }

    await this.syncServiceAssignments(business, replaced._id, fields.assignedServiceIds);

    const [dto] = await this.toAddonDtos(business, [replaced]);
    return dto as AddonDto;
  }

  public async updateAddonStatus(
    actorUserId: string,
    businessId: string,
    addonId: string,
    status: Extract<AddonStatus, "ACTIVE" | "INACTIVE">,
  ): Promise<AddonDto> {
    const business = await this.requireOwnedBusiness(actorUserId, businessId);
    const updated = await this.addonRepository.updateStatusById(business._id, addonId, status);

    if (!updated) {
      const existing = await this.addonRepository.findById(business._id, addonId);
      if (existing?.status === "DRAFT") {
        throw new AddonError("ADDON_DRAFT_CANNOT_TOGGLE", 409);
      }
      throw new AddonError("ADDON_NOT_FOUND", 404);
    }

    const [dto] = await this.toAddonDtos(business, [updated]);
    return dto as AddonDto;
  }

  public async archiveAddon(
    actorUserId: string,
    businessId: string,
    addonId: string,
  ): Promise<void> {
    const business = await this.requireOwnedBusiness(actorUserId, businessId);
    const existing = await this.addonRepository.findById(business._id, addonId);

    if (!existing) {
      throw new AddonError("ADDON_NOT_FOUND", 404);
    }
    if (existing.status === "ARCHIVED") {
      throw new AddonError("ADDON_ALREADY_ARCHIVED", 409);
    }

    await this.addonRepository.archiveById(business._id, addonId);
  }

  public async restoreAddon(
    actorUserId: string,
    businessId: string,
    addonId: string,
    status: Extract<AddonStatus, "ACTIVE" | "INACTIVE">,
  ): Promise<AddonDto> {
    const business = await this.requireOwnedBusiness(actorUserId, businessId);
    const existing = await this.addonRepository.findById(business._id, addonId);

    if (!existing) {
      throw new AddonError("ADDON_NOT_FOUND", 404);
    }
    if (existing.status !== "ARCHIVED") {
      throw new AddonError("ADDON_NOT_ARCHIVED", 409);
    }

    const restored = await this.addonRepository.restoreById(business._id, addonId, status);

    if (!restored) {
      throw new AddonError("ADDON_NOT_FOUND", 404);
    }

    const [dto] = await this.toAddonDtos(business, [restored]);
    return dto as AddonDto;
  }

  /** Backs Service Edit/View's "Assigned Add-ons" section — read-only in this phase. */
  public async listAddonsForService(
    actorUserId: string,
    businessId: string,
    serviceId: string,
  ): Promise<ServiceAssignedAddonDto[]> {
    const business = await this.requireOwnedBusiness(actorUserId, businessId);
    const service = await this.serviceRepository.findById(business._id, serviceId);

    if (!service) {
      throw new AddonError("ADDON_SERVICE_INVALID", 404);
    }

    const assignments = await this.addonServiceAssignmentRepository.findByServiceIds([serviceId]);
    const addonIds = assignments.map((assignment) => assignment.addonId);
    const addons = await this.addonRepository.findManyByIdsForBusiness(business._id, addonIds);

    // Historical (e.g. archived) Add-ons stay visible here — only the assignment row itself
    // ever gets removed (via the Add-on's own "Assign to services" edit), never silently
    // dropped just because the Add-on's status changed later.
    return addons.map((addon) => ({
      addonId: String(addon._id),
      name: addon.name,
      status: addon.status,
      priceCents: addon.priceCents,
    }));
  }

  // --- Validation / field building ----------------------------------------------------------

  /**
   * DRAFT tolerates a missing category/price/assigned-Services (skipped checks below), but
   * whatever IS supplied — draft or not — still has to be real: a category must belong to
   * this business and be active, an assigned Service must belong to this business.
   */
  private async buildAddonFields(
    business: BusinessDocument,
    body: CreateAddonBody | UpdateAddonBody,
  ): Promise<{
    description: string | undefined;
    priceCents: number | undefined;
    category: ServiceCategoryDocument | undefined;
    assignedServiceIds: string[];
  }> {
    const category =
      body.customServiceCategoryId !== undefined
        ? await this.requireActiveCategory(business, body.customServiceCategoryId)
        : undefined;

    return {
      description: body.description,
      priceCents: body.priceCents,
      category,
      assignedServiceIds: body.assignedServiceIds ?? [],
    };
  }

  private async requireActiveCategory(
    business: BusinessDocument,
    categoryId: string,
  ): Promise<ServiceCategoryDocument> {
    if (!Types.ObjectId.isValid(categoryId)) {
      throw new AddonError("ADDON_CATEGORY_NOT_FOUND", 404);
    }

    const category = await this.serviceCategoryRepository.findActiveById(business._id, categoryId);

    if (!category) {
      throw new AddonError("ADDON_CATEGORY_NOT_FOUND", 404);
    }

    return category;
  }

  /**
   * Diffs the requested Service-assignment set against the current one and applies only the
   * delta. A brand-new assignment may not target an ARCHIVED Service, but an assignment that
   * already existed before the Service was archived is preserved as history (not re-validated,
   * never force-removed) — matching the "existing historical association must be preserved"
   * rule. Category is deliberately never checked here — it's filtering metadata, not a hard
   * assignment boundary.
   */
  private async syncServiceAssignments(
    business: BusinessDocument,
    addonId: Types.ObjectId,
    requestedServiceIds: string[],
  ): Promise<void> {
    if (
      requestedServiceIds.length > 0 &&
      !requestedServiceIds.every((id) => Types.ObjectId.isValid(id))
    ) {
      throw new AddonError("ADDON_SERVICE_INVALID", 400);
    }

    const uniqueRequestedIds = [...new Set(requestedServiceIds)];
    const services = await this.serviceRepository.findManyByIdsForBusiness(
      business._id,
      uniqueRequestedIds,
    );

    if (services.length !== uniqueRequestedIds.length) {
      // Covers: unknown id, and a Service id belonging to a different Business —
      // findManyByIdsForBusiness already scopes by businessId.
      throw new AddonError("ADDON_SERVICE_INVALID", 400);
    }

    const serviceById = new Map(services.map((service) => [String(service._id), service]));

    const existingAssignments = await this.addonServiceAssignmentRepository.findByAddonIds([
      addonId,
    ]);
    const existingServiceIds = new Set(
      existingAssignments.map((assignment) => String(assignment.serviceId)),
    );
    const requestedSet = new Set(uniqueRequestedIds);

    const toAdd = uniqueRequestedIds.filter((id) => !existingServiceIds.has(id));
    const toRemove = [...existingServiceIds].filter((id) => !requestedSet.has(id));

    for (const id of toAdd) {
      if (serviceById.get(id)?.status === "ARCHIVED") {
        throw new AddonError("ADDON_SERVICE_ARCHIVED", 400);
      }
    }

    if (toAdd.length > 0) {
      await this.addonServiceAssignmentRepository.insertMany(
        toAdd.map((id) => ({
          businessId: business._id,
          addonId,
          serviceId: new Types.ObjectId(id),
        })),
      );
    }
    if (toRemove.length > 0) {
      await this.addonServiceAssignmentRepository.deleteByAddonAndServiceIds(addonId, toRemove);
    }
  }

  // --- Authorization -------------------------------------------------------------------------

  /**
   * Add-ons are Business-Owner-only management functionality, same as Services — no
   * BusinessAccess (linked/secondary Business) fallback. 404 on any ownership mismatch (never
   * a bare 403) so a forged businessId cannot be used to probe for another owner's business.
   */
  private async requireOwnedBusiness(
    actorUserId: string,
    businessId: string,
  ): Promise<BusinessDocument> {
    if (!Types.ObjectId.isValid(businessId)) {
      throw new AddonError("ADDON_BUSINESS_NOT_FOUND", 404);
    }

    const business = await this.businessRepository.findById(businessId);

    if (!business) {
      throw new AddonError("ADDON_BUSINESS_NOT_FOUND", 404);
    }

    if (!business.ownerUserId.equals(actorUserId)) {
      throw new AddonError("ADDON_BUSINESS_NOT_FOUND", 404);
    }

    return business;
  }

  // --- DTO mapping -----------------------------------------------------------------------

  /**
   * Batches every cross-collection lookup needed to render a page of Add-ons: category names
   * (one $in query) and assigned-Service names (one assignment query + one Service $in query)
   * — never one query per Add-on regardless of how many are returned.
   */
  private async toAddonDtos(
    business: BusinessDocument,
    addons: AddonDocument[],
  ): Promise<AddonDto[]> {
    const categoryIds = [
      ...new Set(
        addons
          .map((addon) => addon.customServiceCategoryId)
          .filter((id): id is Types.ObjectId => id !== undefined)
          .map((id) => String(id)),
      ),
    ];
    const addonIds = addons.map((addon) => addon._id);

    const [categories, assignments] = await Promise.all([
      Promise.all(
        categoryIds.map((id) => this.serviceCategoryRepository.findById(business._id, id)),
      ),
      this.addonServiceAssignmentRepository.findByAddonIds(addonIds),
    ]);

    const categoryById = new Map(
      categories
        .filter((category): category is ServiceCategoryDocument => category !== null)
        .map((category) => [String(category._id), category]),
    );

    const serviceIds = [...new Set(assignments.map((assignment) => String(assignment.serviceId)))];
    const services = await this.serviceRepository.findManyByIdsForBusiness(
      business._id,
      serviceIds,
    );
    const serviceById = new Map(services.map((service) => [String(service._id), service]));

    const assignmentsByAddonId = new Map<string, AddonServiceAssignmentDocument[]>();
    for (const assignment of assignments) {
      const key = String(assignment.addonId);
      const list = assignmentsByAddonId.get(key) ?? [];
      list.push(assignment);
      assignmentsByAddonId.set(key, list);
    }

    return addons.map((addon) => {
      const category =
        addon.customServiceCategoryId !== undefined
          ? categoryById.get(String(addon.customServiceCategoryId))
          : undefined;

      const assignedServices: AddonAssignedServiceDto[] = (
        assignmentsByAddonId.get(String(addon._id)) ?? []
      )
        .map((assignment) => serviceById.get(String(assignment.serviceId)))
        .filter((service): service is ServiceDocument => service !== undefined)
        .map((service) => ({
          serviceId: String(service._id),
          name: service.name,
          status: service.status,
        }));

      return {
        id: String(addon._id),
        businessId: String(addon.businessId),
        status: addon.status,
        name: addon.name,
        description: addon.description,
        priceCents: addon.priceCents,
        customServiceCategoryId:
          addon.customServiceCategoryId !== undefined
            ? String(addon.customServiceCategoryId)
            : undefined,
        customServiceCategoryName: category?.name,
        assignedServices,
        createdAt: addon.createdAt.toISOString(),
        updatedAt: addon.updatedAt.toISOString(),
        archivedAt: addon.archivedAt?.toISOString(),
      };
    });
  }
}
