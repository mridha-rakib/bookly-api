import type { PackageDocument } from "./package.model.js";
import type { PackageDependencyIssue } from "./package.types.js";
import { calculatePackagePricing } from "./package-pricing.js";
import {
  copyPackageDefinitionContractTerms,
  hasCompletePackageDefinitionContract,
} from "./package-session-penalty-policy.js";

export const toPackageDefinitionDto = (
  definition: PackageDocument,
  dependencyIssues: PackageDependencyIssue[],
) => ({
  id: String(definition._id),
  businessId: String(definition.businessId),
  name: definition.name,
  description: definition.description,
  category: definition.category,
  subcategory: definition.subcategory,
  serviceCategoryId: definition.serviceCategoryId
    ? String(definition.serviceCategoryId)
    : undefined,
  status: definition.status,
  isFeatured: definition.isFeatured,
  revision: definition.revision,
  items: definition.items.map((item) => ({
    itemId: String(item.itemId),
    serviceId: String(item.serviceId),
    includedSessions: item.includedSessions,
    referenceUnitPriceCents: item.referenceUnitPriceCents,
    ...(item.penaltyBasisCents !== undefined ? { penaltyBasisCents: item.penaltyBasisCents } : {}),
  })),
  bundlePriceCents: definition.bundlePriceCents,
  ...(definition.contractTerms
    ? {
        contractTerms: copyPackageDefinitionContractTerms(definition.contractTerms),
      }
    : {}),
  ...calculatePackagePricing(definition.items, definition.bundlePriceCents),
  sellable: definition.status === "ACTIVE" && dependencyIssues.length === 0,
  // Catalog qualification only: no customer acceptance, entitlement or sales activation.
  newContractReady:
    definition.status === "ACTIVE" &&
    dependencyIssues.length === 0 &&
    hasCompletePackageDefinitionContract(definition),
  dependencyIssues,
  archivedAt: definition.archivedAt?.toISOString(),
  createdAt: definition.createdAt.toISOString(),
  updatedAt: definition.updatedAt.toISOString(),
});
export type PackageDefinitionDto = ReturnType<typeof toPackageDefinitionDto>;
