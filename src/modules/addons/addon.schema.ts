import { z } from "zod";

import { editableAddonStatuses } from "./addon.types.js";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const addonBusinessParamsSchema = z.object({ businessId: objectIdSchema }).strict();

export const addonIdParamsSchema = z
  .object({ businessId: objectIdSchema, addonId: objectIdSchema })
  .strict();

export const listAddonsQuerySchema = z
  .object({
    status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]).optional(),
    archived: z.enum(["true", "false"]).optional(),
  })
  .strict()
  .transform((value) => ({
    status: value.status,
    archived: value.archived === "true",
  }));

// --- Add-on (create/update share one full-object shape — PATCH is full-replace semantics,
// mirroring service.schema.ts, including the Service assignment set) ------------------------
//
// Validation is status-aware, same rationale as Service: DRAFT only requires `name` +
// `status`; ACTIVE/INACTIVE must satisfy every field the catalogue relies on (Figma-required:
// name, price, category, at least one assigned Service), enforced in the superRefine below.

const centsSchema = z.number().int().min(0);

const baseAddonBodySchema = z.object({
  status: z.enum(editableAddonStatuses),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  // Flat fee only, integer cents (no hourly/per-person/package variants for Add-ons).
  priceCents: centsSchema.optional(),
  customServiceCategoryId: objectIdSchema.optional(),
  assignedServiceIds: z.array(objectIdSchema).max(500).optional(),
});

const strictAddonBodySchema = baseAddonBodySchema.strict();

const addonBodySchema = strictAddonBodySchema.superRefine((body, context) => {
  // DRAFT allows incomplete data — name/status are the only unconditional requirements.
  if (body.status === "DRAFT") {
    return;
  }

  if (body.priceCents === undefined) {
    context.addIssue({
      code: "custom",
      path: ["priceCents"],
      message: "Required unless the Add-on is saved as a draft",
    });
  }
  if (body.customServiceCategoryId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["customServiceCategoryId"],
      message: "Required unless the Add-on is saved as a draft",
    });
  }
  if (!body.assignedServiceIds || body.assignedServiceIds.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["assignedServiceIds"],
      message: "At least one Service must be assigned unless the Add-on is saved as a draft",
    });
  }
});

export const createAddonBodySchema = addonBodySchema;
export const updateAddonBodySchema = addonBodySchema;

export const updateAddonStatusBodySchema = z
  .object({ status: z.enum(["ACTIVE", "INACTIVE"]) })
  .strict();

export const restoreAddonBodySchema = z.object({ status: z.enum(["ACTIVE", "INACTIVE"]) }).strict();

export type AddonBusinessParams = z.infer<typeof addonBusinessParamsSchema>;
export type AddonIdParams = z.infer<typeof addonIdParamsSchema>;
export type ListAddonsQuery = z.infer<typeof listAddonsQuerySchema>;
export type CreateAddonBody = z.infer<typeof baseAddonBodySchema>;
export type UpdateAddonBody = z.infer<typeof baseAddonBodySchema>;
export type UpdateAddonStatusBody = z.infer<typeof updateAddonStatusBodySchema>;
export type RestoreAddonBody = z.infer<typeof restoreAddonBodySchema>;
