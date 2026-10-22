import { extendZodWithOpenApi, type OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import {
  createPackageBodySchema,
  packageBusinessParamsSchema,
  packageDefinitionContractTermsSchema,
  packageIdParamsSchema,
  packagePenaltyBasisSchema,
  restorePackageBodySchema,
  updatePackageBodySchema,
  updatePackageStatusBodySchema,
} from "./package.schema.js";
import { packageStatuses } from "./package.types.js";

extendZodWithOpenApi(z);

const id = z.string().regex(/^[a-f\d]{24}$/i);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const item = z.object({
  itemId: id,
  serviceId: id,
  includedSessions: integer.min(1),
  referenceUnitPriceCents: integer.min(1).optional(),
  penaltyBasisCents: packagePenaltyBasisSchema.optional(),
});
const dto = z.object({
  id,
  businessId: id,
  name: z.string(),
  description: z.string().optional(),
  category: z.string(),
  subcategory: z.string().optional(),
  serviceCategoryId: id.optional(),
  status: z.enum(packageStatuses),
  isFeatured: z.boolean(),
  revision: integer.min(1),
  items: z.array(item),
  bundlePriceCents: integer.optional(),
  contractTerms: packageDefinitionContractTermsSchema.optional(),
  totalSessions: integer,
  referenceTotalCents: integer.nullable(),
  savingsCents: integer.nullable(),
  discountPercent: z.number().min(0).max(100).nullable(),
  sellable: z.boolean(),
  newContractReady: z.boolean(),
  dependencyIssues: z.array(z.object({ itemId: id.optional(), code: z.string() })),
  archivedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const envelope = (data: z.ZodType) =>
  z.object({ success: z.literal(true), message: z.string(), data });
const error = z.object({
  success: z.literal(false),
  message: z.string(),
  errors: z
    .array(
      z.object({ path: z.string().optional(), code: z.string().optional(), message: z.string() }),
    )
    .optional(),
  requestId: z.string().optional(),
});

export const registerPackageOpenApi = (registry: OpenAPIRegistry, version: string): void => {
  registry.registerComponent("securitySchemes", "PackageOwnerBearer", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });
  registry.register("PackageDefinition", dto);
  const base = `/api/${version}/businesses/{businessId}/packages`;
  const definitions = [
    {
      method: "get",
      path: base,
      summary: "List owned Package definitions",
      query: z
        .object({
          status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]).optional(),
          archived: z.enum(["true", "false"]).optional(),
        })
        .strict(),
      response: envelope(z.object({ packages: z.array(dto) })),
    },
    {
      method: "post",
      path: base,
      summary: "Create Package definition (no customer sales activation)",
      body: createPackageBodySchema,
      response: envelope(dto),
      created: true,
    },
    {
      method: "get",
      path: `${base}/{packageId}`,
      summary: "Read owned Package, including archived",
      response: envelope(dto),
    },
    {
      method: "patch",
      path: `${base}/{packageId}`,
      summary: "Replace owned definition under revision CAS",
      body: updatePackageBodySchema,
      response: envelope(dto),
    },
    {
      method: "patch",
      path: `${base}/{packageId}/status`,
      summary: "Change Package status with publication validation",
      body: updatePackageStatusBodySchema,
      response: envelope(dto),
    },
    {
      method: "delete",
      path: `${base}/{packageId}`,
      summary: "Soft archive Package under revision CAS",
      query: z.object({ expectedRevision: z.string().regex(/^[1-9]\d*$/) }).strict(),
      response: z.object({ success: z.literal(true), message: z.string() }),
    },
    {
      method: "post",
      path: `${base}/{packageId}/restore`,
      summary: "Restore archived Package after dependency revalidation",
      body: restorePackageBodySchema,
      response: envelope(dto),
    },
  ] as const;
  for (const definition of definitions) {
    const body = "body" in definition ? definition.body : undefined;
    const query = "query" in definition ? definition.query : undefined;
    registry.registerPath({
      method: definition.method,
      path: definition.path,
      tags: ["Package definitions"],
      summary: definition.summary,
      description:
        "Active BUSINESS_OWNER of the Business only, under the existing approved-Business gate. Strict inputs; no customer purchase or entitlement writes. Lists default to nonarchived; status and archived filters cannot be combined. Updates fully replace optional fields, including contractTerms and item penaltyBasisCents: omitted fields are removed. Status/archive/restore preserve terms. Archived edits stay archived. Every real mutation increments revision once; archive at the exact already-archived revision is a no-op. Positive reference units; bundle <= reference total; comparison pricing is unchanged. Optional contractTerms retains finite-only v1 input {validityMonths: 6|12} and adds v2 input {validity: {mode: FINITE, months: 6|12}} or {validity: {mode: FOREVER}}. Missing terms never imply FOREVER. FOREVER adds no expiry timestamp or purchased processing. Finite deadline is original-purchase anchored booking validity; exact appointment cutoff remains future P2/P3 scope, not a completion-recording deadline; contract/policy versions are server-assigned and are output-only. Independent penaltyBasisCents is EUR integer 0..5000, never derived from reference. Fixed Option B policy v1: appointment cap 2500; lifetime cap min(10000, floor(sold bundle cents / 2)); zero bundle has no positive cash penalty. Owners cannot supply currency, caps, formula or policy version. Old definitions need no defaults/backfill and keep existing sellable semantics. Separate newContractReady requires complete terms, explicit basis on every item and current sellability; it is catalog qualification, not customer consent or public sales/penalty activation.",
      security: [{ PackageOwnerBearer: [] }],
      request: {
        params: definition.path.includes("{packageId}")
          ? packageIdParamsSchema
          : packageBusinessParamsSchema,
        ...(query ? { query } : {}),
        ...(body
          ? { body: { required: true, content: { "application/json": { schema: body } } } }
          : {}),
      },
      responses: {
        ["created" in definition ? 201 : 200]: {
          description: "Owner operation succeeded",
          content: { "application/json": { schema: definition.response } },
        },
        400: {
          description:
            "Invalid schema or PACKAGE_COMPOSITION_INVALID (invalid/foreign/archived/non-FIXED Service, grouping, duplicate identity, reference/overflow).",
          content: { "application/json": { schema: error } },
        },
        401: {
          description: "Session missing or expired",
          content: { "application/json": { schema: error } },
        },
        403: {
          description: "Role, inactive user or Business approval gate denied",
          content: { "application/json": { schema: error } },
        },
        404: {
          description: "PACKAGE_NOT_FOUND or PACKAGE_ITEM_NOT_FOUND; foreign ownership masked",
          content: { "application/json": { schema: error } },
        },
        409: {
          description:
            "PACKAGE_REVISION_CONFLICT, PACKAGE_INVALID_STATUS_TRANSITION or PACKAGE_NOT_SELLABLE (inactive dependency/provider/travel city)",
          content: { "application/json": { schema: error } },
        },
      },
    });
  }
};
