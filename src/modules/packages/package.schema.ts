import { z } from "zod";
import { editablePackageStatuses } from "./package.types.js";
import { calculatePackagePricing } from "./package-pricing.js";
import {
  PACKAGE_DEFINITION_CONTRACT_VERSION,
  PACKAGE_DEFINITION_VALIDITY_CONTRACT_VERSION,
  PACKAGE_SESSION_PENALTY_POLICY,
} from "./package-session-penalty-policy.js";

const objectId = z
  .string()
  .regex(/^[a-f\d]{24}$/i, "Invalid id")
  .transform((id) => id.toLowerCase());
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const packagePenaltyBasisSchema = cents.max(PACKAGE_SESSION_PENALTY_POLICY.maxBasisCents);
const months = z.union([z.literal(6), z.literal(12)]);
export const packageDefinitionValiditySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("FINITE"), months }).strict(),
  z.object({ mode: z.literal("FOREVER") }).strict(),
]);
// v1 input stays finite-only. v2 adds an explicit discriminant; omission is never FOREVER.
const finiteOwnerContractTermsSchema = z
  .object({ validityMonths: z.union([z.literal(6), z.literal(12)]) })
  .strict();
const explicitOwnerContractTermsSchema = z
  .object({ validity: packageDefinitionValiditySchema })
  .strict();
const ownerContractTermsSchema = z.union([
  finiteOwnerContractTermsSchema,
  explicitOwnerContractTermsSchema,
]);
export const packageDefinitionContractTermsSchema = z.discriminatedUnion("version", [
  finiteOwnerContractTermsSchema
    .extend({
      version: z.literal(PACKAGE_DEFINITION_CONTRACT_VERSION),
      penaltyPolicyVersion: z.literal(PACKAGE_SESSION_PENALTY_POLICY.version),
    })
    .strict(),
  explicitOwnerContractTermsSchema
    .extend({
      version: z.literal(PACKAGE_DEFINITION_VALIDITY_CONTRACT_VERSION),
      penaltyPolicyVersion: z.literal(PACKAGE_SESSION_PENALTY_POLICY.version),
    })
    .strict(),
]);

export const packageBusinessParamsSchema = z.object({ businessId: objectId }).strict();
export const packageIdParamsSchema = packageBusinessParamsSchema
  .extend({ packageId: objectId })
  .strict();
export const packageItemInputSchema = z
  .object({
    itemId: objectId.optional(),
    serviceId: objectId,
    includedSessions: positiveInteger,
    referenceUnitPriceCents: positiveInteger.optional(),
    penaltyBasisCents: packagePenaltyBasisSchema.optional(),
  })
  .strict();

const fields = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    status: z.enum(editablePackageStatuses),
    isFeatured: z.boolean(),
    serviceCategoryId: objectId.optional(),
    subcategory: z.string().trim().min(1).optional(),
    items: z.array(packageItemInputSchema),
    bundlePriceCents: cents.optional(),
    contractTerms: ownerContractTermsSchema.optional(),
  })
  .strict();

type Fields = z.infer<typeof fields>;
const validateSupplied = (body: Fields, context: z.RefinementCtx): void => {
  for (const key of ["serviceId", "itemId"] as const) {
    const ids = body.items.flatMap((item) => (item[key] ? [item[key]] : []));
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: `Duplicate ${key} is not allowed`,
      });
    }
  }
  try {
    calculatePackagePricing(body.items, body.bundlePriceCents);
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["bundlePriceCents"],
      message: (error as Error).message,
    });
  }
};
const validateComplete = (body: Fields, context: z.RefinementCtx): void => {
  if (body.status === "DRAFT") return;
  for (const key of ["serviceCategoryId", "subcategory", "bundlePriceCents"] as const) {
    if (body[key] === undefined)
      context.addIssue({ code: "custom", path: [key], message: "Required for publication" });
  }
  if (!body.items.length)
    context.addIssue({
      code: "custom",
      path: ["items"],
      message: "At least one Service is required",
    });
  body.items.forEach((item, index) => {
    if (item.referenceUnitPriceCents === undefined)
      context.addIssue({
        code: "custom",
        path: ["items", index, "referenceUnitPriceCents"],
        message: "Required for publication",
      });
  });
};

/** Also used by the service for status/restore and effective archived-edit validation. */
export const packageDefinitionInputSchema = fields
  .extend({ contractTerms: packageDefinitionContractTermsSchema.optional() })
  .superRefine(validateSupplied)
  .superRefine(validateComplete);
export const createPackageBodySchema = fields
  .extend({
    status: fields.shape.status.default("DRAFT"),
    isFeatured: z.boolean().default(false),
    items: z.array(packageItemInputSchema.omit({ itemId: true }).strict()).default([]),
  })
  .strict()
  .superRefine(validateSupplied)
  .superRefine(validateComplete);

// Completeness depends on persisted status: archived edits stay archived and may be incomplete.
export const updatePackageBodySchema = fields
  .extend({ expectedRevision: positiveInteger })
  .strict()
  .superRefine(validateSupplied);
export const updatePackageStatusBodySchema = z
  .object({ status: z.enum(editablePackageStatuses), expectedRevision: positiveInteger })
  .strict();
export const restorePackageBodySchema = z
  .object({ status: z.enum(["ACTIVE", "INACTIVE"]), expectedRevision: positiveInteger })
  .strict();
export const archivePackageQuerySchema = z
  .object({
    expectedRevision: z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(positiveInteger),
  })
  .strict();
export const listPackagesQuerySchema = z
  .object({
    status: z.enum(editablePackageStatuses).optional(),
    archived: z.enum(["true", "false"]).optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.status !== undefined && query.archived !== undefined)
      context.addIssue({ code: "custom", message: "Use status or archived, not both" });
  })
  .transform((query) => ({ status: query.status, archivedOnly: query.archived === "true" }));

export type CreatePackageBody = z.infer<typeof createPackageBodySchema>;
export type UpdatePackageBody = z.infer<typeof updatePackageBodySchema>;
export type PackageInput = z.infer<typeof fields>;
