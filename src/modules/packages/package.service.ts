import { Types } from "mongoose";
import { RequestValidationError } from "../../common/errors/validation-error.js";
import { AuthError } from "../auth/auth.errors.js";
import type { BusinessDocument } from "../business/business.model.js";
import type { BusinessRepository } from "../business/business.repository.js";
import { businessCities, normalizeBusinessVisitType } from "../business/business.types.js";
import type { BusinessTravelSettingsRepository } from "../business-travel-settings/business-travel-settings.repository.js";
import type { ServiceRepository } from "../services/service.repository.js";
import type { ServiceCategoryRepository } from "../services/service-category.repository.js";
import type { StaffRepository } from "../staff/staff.repository.js";
import { toPackageDefinitionDto } from "./package.dto.js";
import { PackageError } from "./package.errors.js";
import type { PackageDocument } from "./package.model.js";
import type { PackageFields, PackageListFilter, PackageRepository } from "./package.repository.js";
import {
  type CreatePackageBody,
  type PackageInput,
  packageDefinitionInputSchema,
  type UpdatePackageBody,
} from "./package.schema.js";
import type { EditablePackageStatus, PackageDependencyIssue } from "./package.types.js";
import { resolvePackageServiceEntitlement } from "./package-service-entitlement.js";
import {
  copyPackageDefinitionContractTerms,
  PACKAGE_DEFINITION_CONTRACT_VERSION,
  PACKAGE_DEFINITION_VALIDITY_CONTRACT_VERSION,
  PACKAGE_SESSION_PENALTY_POLICY,
} from "./package-session-penalty-policy.js";

const invalidEvenInDraft = new Set([
  "PACKAGE_SERVICE_INVALID",
  "PACKAGE_SERVICE_NOT_FIXED",
  "PACKAGE_FIXED_CONFIG_INVALID",
  "PACKAGE_CATEGORY_INVALID",
  "PACKAGE_SUBCATEGORY_INVALID",
]);

export class PackageService {
  public constructor(
    private readonly packages: PackageRepository,
    private readonly businesses: BusinessRepository,
    private readonly services: ServiceRepository,
    private readonly categories: ServiceCategoryRepository,
    private readonly staff: StaffRepository,
    private readonly travel: BusinessTravelSettingsRepository,
  ) {}

  /** Read-only customer catalogue. Reuse publication dependencies; never grant checkout. */
  public async customerCatalog(businessId: string, packageId?: string) {
    const business = await this.businesses.findById(businessId);
    if (!business || !["APPROVED", "WARNING"].includes(business.status))
      throw new PackageError("PACKAGE_NOT_FOUND", 404);
    const definitions = await this.packages.list(business._id, { status: "ACTIVE" });
    const issues = await this.dependencies(business, definitions);
    const services = await this.services.findManyByIdsForBusiness(business._id, [
      ...new Set(definitions.flatMap((d) => d.items.map((i) => String(i.serviceId)))),
    ]);
    const packages = definitions.flatMap((definition, index) => {
      const dto = toPackageDefinitionDto(definition, issues[index] ?? []);
      if (
        !dto.newContractReady ||
        definition.status !== "ACTIVE" ||
        (packageId && String(definition._id) !== packageId)
      )
        return [];
      return [
        {
          id: dto.id,
          businessId: dto.businessId,
          name: dto.name,
          description: dto.description,
          currency: "EUR" as const,
          bundlePriceCents: dto.bundlePriceCents,
          validity:
            definition.contractTerms?.version === 2
              ? definition.contractTerms.validity
              : { mode: "FINITE" as const, months: definition.contractTerms?.validityMonths },
          fulfilmentMode: normalizeBusinessVisitType(business.visitType),
          checkoutAvailable: false as const,
          items: definition.items.map((item) => {
            const service = services.find((s) => s._id.equals(item.serviceId));
            return {
              itemId: String(item.itemId),
              serviceId: String(item.serviceId),
              name: service?.name,
              quantity: item.includedSessions,
              pricingMode: service?.pricingMode,
              group: service ? resolvePackageServiceEntitlement(service)?.group : undefined,
            };
          }),
        },
      ];
    });
    if (packageId && packages.length === 0) throw new PackageError("PACKAGE_NOT_FOUND", 404);
    return { packages };
  }

  public async list(actor: string, businessId: string, filter: PackageListFilter) {
    const business = await this.requireBusiness(actor, businessId);
    const definitions = await this.packages.list(business._id, filter);
    const issues = await this.dependencies(business, definitions);
    return {
      packages: definitions.map((definition, index) =>
        toPackageDefinitionDto(definition, issues[index] ?? []),
      ),
    };
  }

  public async detail(actor: string, businessId: string, packageId: string) {
    const business = await this.requireBusiness(actor, businessId);
    return this.dto(business, await this.requireDefinition(business, packageId));
  }

  public async create(actor: string, businessId: string, input: CreatePackageBody) {
    const business = await this.requireBusiness(actor, businessId);
    const fields = this.fields(business, input);
    await this.validate(business, fields);
    return this.dto(business, await this.packages.create(business._id, fields));
  }

  public async update(
    actor: string,
    businessId: string,
    packageId: string,
    input: UpdatePackageBody,
  ) {
    const business = await this.requireBusiness(actor, businessId);
    const existing = await this.requireDefinition(business, packageId, input.expectedRevision);
    if (existing.status !== "ARCHIVED") this.requireTransition(existing, input.status);
    const fields = this.fields(business, input, existing);
    if (existing.status === "ARCHIVED") fields.status = "ARCHIVED";
    await this.validate(business, fields);
    return this.save(business, existing, fields);
  }

  public async status(
    actor: string,
    businessId: string,
    packageId: string,
    status: EditablePackageStatus,
    expectedRevision: number,
  ) {
    const business = await this.requireBusiness(actor, businessId);
    const existing = await this.requireDefinition(business, packageId, expectedRevision);
    this.requireTransition(existing, status);
    const fields = { ...this.existingFields(existing), status };
    await this.validate(business, fields);
    return this.save(business, existing, fields);
  }

  public async archive(
    actor: string,
    businessId: string,
    packageId: string,
    expectedRevision: number,
  ): Promise<void> {
    const business = await this.requireBusiness(actor, businessId);
    const existing = await this.requireDefinition(business, packageId, expectedRevision);
    // An already archived definition is a no-op only for the exact current revision.
    if (existing.status === "ARCHIVED") return;
    await this.save(
      business,
      existing,
      { ...this.existingFields(existing), status: "ARCHIVED" },
      new Date(),
    );
  }

  public async restore(
    actor: string,
    businessId: string,
    packageId: string,
    status: "ACTIVE" | "INACTIVE",
    expectedRevision: number,
  ) {
    const business = await this.requireBusiness(actor, businessId);
    const existing = await this.requireDefinition(business, packageId, expectedRevision);
    if (existing.status !== "ARCHIVED")
      throw new PackageError("PACKAGE_INVALID_STATUS_TRANSITION", 409);
    const fields = { ...this.existingFields(existing), status };
    await this.validate(business, fields);
    return this.save(business, existing, fields);
  }

  private fields(
    business: BusinessDocument,
    input: PackageInput,
    existing?: PackageDocument,
  ): PackageFields {
    const oldItems = new Map(existing?.items.map((item) => [String(item.itemId), item]) ?? []);
    return {
      name: input.name,
      description: input.description,
      category: business.category,
      serviceCategoryId: input.serviceCategoryId
        ? new Types.ObjectId(input.serviceCategoryId)
        : undefined,
      subcategory: input.subcategory,
      status: input.status,
      isFeatured: input.isFeatured,
      bundlePriceCents: input.bundlePriceCents,
      // Full replacement: omission removes terms; status/archive/restore preserve them below.
      contractTerms: input.contractTerms
        ? {
            ...("validity" in input.contractTerms
              ? {
                  version: PACKAGE_DEFINITION_VALIDITY_CONTRACT_VERSION,
                  validity: input.contractTerms.validity,
                }
              : {
                  version: PACKAGE_DEFINITION_CONTRACT_VERSION,
                  validityMonths: input.contractTerms.validityMonths,
                }),
            penaltyPolicyVersion: PACKAGE_SESSION_PENALTY_POLICY.version,
          }
        : undefined,
      items: input.items.map((item) => {
        const old = item.itemId ? oldItems.get(item.itemId) : undefined;
        if (item.itemId && (!old || String(old.serviceId) !== item.serviceId))
          throw new PackageError("PACKAGE_ITEM_NOT_FOUND", 404);
        return {
          itemId: old?.itemId ?? new Types.ObjectId(),
          serviceId: new Types.ObjectId(item.serviceId),
          includedSessions: item.includedSessions,
          referenceUnitPriceCents: item.referenceUnitPriceCents,
          penaltyBasisCents: item.penaltyBasisCents,
        };
      }),
    };
  }

  private existingFields(definition: PackageDocument): PackageFields {
    return {
      name: definition.name,
      description: definition.description,
      category: definition.category,
      subcategory: definition.subcategory,
      serviceCategoryId: definition.serviceCategoryId,
      status: definition.status,
      isFeatured: definition.isFeatured,
      contractTerms: definition.contractTerms
        ? copyPackageDefinitionContractTerms(definition.contractTerms)
        : undefined,
      items: definition.items.map((item) => ({
        itemId: item.itemId,
        serviceId: item.serviceId,
        includedSessions: item.includedSessions,
        referenceUnitPriceCents: item.referenceUnitPriceCents,
        penaltyBasisCents: item.penaltyBasisCents,
      })),
      bundlePriceCents: definition.bundlePriceCents,
    };
  }

  private async validate(business: BusinessDocument, fields: PackageFields): Promise<void> {
    const result = packageDefinitionInputSchema.safeParse({
      name: fields.name,
      description: fields.description,
      status: fields.status === "ARCHIVED" ? "DRAFT" : fields.status,
      isFeatured: fields.isFeatured,
      subcategory: fields.subcategory,
      serviceCategoryId: fields.serviceCategoryId ? String(fields.serviceCategoryId) : undefined,
      bundlePriceCents: fields.bundlePriceCents,
      contractTerms: fields.contractTerms,
      items: fields.items.map((item) => ({
        itemId: String(item.itemId),
        serviceId: String(item.serviceId),
        includedSessions: item.includedSessions,
        referenceUnitPriceCents: item.referenceUnitPriceCents,
        penaltyBasisCents: item.penaltyBasisCents,
      })),
    });
    if (!result.success)
      throw new RequestValidationError(
        result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      );
    const [issues = []] = await this.dependencies(business, [fields]);
    const invalid = issues.filter((issue) => invalidEvenInDraft.has(issue.code));
    if (invalid.length)
      throw new PackageError(
        "PACKAGE_COMPOSITION_INVALID",
        400,
        invalid.map((issue) => ({
          code: issue.code,
          message: "Invalid Package dependency",
          ...(issue.itemId ? { path: `items.${issue.itemId}` } : {}),
        })),
      );
    if (fields.status !== "DRAFT" && fields.status !== "ARCHIVED" && issues.length) {
      throw new PackageError(
        "PACKAGE_NOT_SELLABLE",
        409,
        issues.map((issue) => ({
          code: issue.code,
          message: "Package dependency is not publication-ready",
        })),
      );
    }
  }

  /** Batched reads for the entire Owner list; no per-card or per-item DB queries. */
  private async dependencies(
    business: BusinessDocument,
    definitions: PackageFields[],
  ): Promise<PackageDependencyIssue[][]> {
    const serviceIds = definitions.flatMap((definition) =>
      definition.items.map((item) => String(item.serviceId)),
    );
    const categoryIds = definitions.flatMap((definition) =>
      definition.serviceCategoryId ? [String(definition.serviceCategoryId)] : [],
    );
    const [services, categories, staff, travel] = await Promise.all([
      this.services.findManyByIdsForBusiness(business._id, [...new Set(serviceIds)]),
      this.categories.findManyByIdsForBusiness(business._id, [...new Set(categoryIds)]),
      this.staff.listActiveByBusinessId(business._id),
      this.travel.findByBusinessId(business._id),
    ]);
    const serviceById = new Map(services.map((service) => [String(service._id), service]));
    const activeCategories = new Set(
      categories.filter((category) => category.active).map((category) => String(category._id)),
    );
    const providers = new Set(
      staff
        .filter(
          (member) =>
            member.employmentActive &&
            !member.removedAt &&
            (member.role === "STAFF" || member.role === "SUPERVISOR"),
        )
        .map((member) => String(member._id)),
    );
    const cities = new Set(
      (travel?.cities ?? [])
        .filter(
          (city) =>
            city.active &&
            businessCities.includes(city.city) &&
            Number.isSafeInteger(city.feeCents) &&
            city.feeCents >= 0,
        )
        .map((city) => city.city),
    );
    return definitions.map((definition) => {
      const issues: PackageDependencyIssue[] = [];
      if (!definition.serviceCategoryId || !definition.subcategory)
        issues.push({ code: "PACKAGE_GROUPING_REQUIRED" });
      if (
        definition.serviceCategoryId &&
        !activeCategories.has(String(definition.serviceCategoryId))
      )
        issues.push({ code: "PACKAGE_CATEGORY_INVALID" });
      if (definition.subcategory && !business.subcategories.includes(definition.subcategory))
        issues.push({ code: "PACKAGE_SUBCATEGORY_INVALID" });
      if (!definition.items.length) issues.push({ code: "PACKAGE_ITEMS_REQUIRED" });
      if (
        definition.bundlePriceCents === undefined ||
        definition.items.some((item) => item.referenceUnitPriceCents === undefined)
      )
        issues.push({ code: "PACKAGE_PRICING_INCOMPLETE" });
      for (const item of definition.items) {
        const itemId = String(item.itemId);
        const service = serviceById.get(String(item.serviceId));
        const add = (code: string) => issues.push({ itemId, code });
        if (!service || service.status === "ARCHIVED") {
          add("PACKAGE_SERVICE_INVALID");
          continue;
        }
        if (service.isPackageDeal || !["FIXED", "PER_PERSON"].includes(service.pricingMode ?? "")) {
          add("PACKAGE_SERVICE_NOT_FIXED");
          continue;
        }
        if (!resolvePackageServiceEntitlement(service)) {
          add("PACKAGE_FIXED_CONFIG_INVALID");
          continue;
        }
        if (service.status !== "ACTIVE") add("PACKAGE_SERVICE_INACTIVE");
        if (!service.assignedStaffMembershipIds.some((id) => providers.has(String(id))))
          add("PACKAGE_PROVIDER_REQUIRED");
        if (
          normalizeBusinessVisitType(business.visitType) === "TRAVEL_TO_CUSTOMER" &&
          !service.servedCities.some((city) => cities.has(city))
        )
          add("PACKAGE_TRAVEL_CITY_REQUIRED");
      }
      return issues;
    });
  }

  private requireTransition(existing: PackageDocument, status: EditablePackageStatus): void {
    if (existing.status === "ARCHIVED" || (existing.status !== "DRAFT" && status === "DRAFT"))
      throw new PackageError("PACKAGE_INVALID_STATUS_TRANSITION", 409);
  }
  private async requireBusiness(actor: string, businessId: string): Promise<BusinessDocument> {
    if (!Types.ObjectId.isValid(businessId)) throw new PackageError("PACKAGE_NOT_FOUND", 404);
    const business = await this.businesses.findById(businessId);
    if (!business?.ownerUserId.equals(actor)) throw new PackageError("PACKAGE_NOT_FOUND", 404);
    // A parent router.use does not reliably have child-route params. Recheck the existing
    // Business approval policy after ownership masking, without changing shared middleware.
    if (business.status === "PENDING") throw new AuthError("BUSINESS_PENDING_APPROVAL", 403);
    if (business.status === "SUSPENDED") throw new AuthError("BUSINESS_SUSPENDED", 403);
    return business;
  }
  private async requireDefinition(
    business: BusinessDocument,
    id: string,
    expectedRevision?: number,
  ): Promise<PackageDocument> {
    if (!Types.ObjectId.isValid(id)) throw new PackageError("PACKAGE_NOT_FOUND", 404);
    const definition = await this.packages.findById(business._id, id);
    if (!definition) throw new PackageError("PACKAGE_NOT_FOUND", 404);
    if (expectedRevision !== undefined && definition.revision !== expectedRevision)
      throw new PackageError("PACKAGE_REVISION_CONFLICT", 409);
    return definition;
  }
  private async save(
    business: BusinessDocument,
    existing: PackageDocument,
    fields: PackageFields,
    archivedAt = existing.archivedAt,
  ) {
    if (existing.revision >= Number.MAX_SAFE_INTEGER)
      throw new PackageError("PACKAGE_REVISION_CONFLICT", 409);
    const updated = await this.packages.replace(
      business._id,
      String(existing._id),
      existing.revision,
      fields,
      fields.status === "ARCHIVED" ? archivedAt : undefined,
    );
    if (!updated) throw new PackageError("PACKAGE_REVISION_CONFLICT", 409);
    return this.dto(business, updated);
  }
  private async dto(business: BusinessDocument, definition: PackageDocument) {
    const [issues = []] = await this.dependencies(business, [definition]);
    return toPackageDefinitionDto(definition, issues);
  }
}
