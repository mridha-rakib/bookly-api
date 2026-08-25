import { z } from "zod";
import { promoScopes, promoStatuses, promoTypes } from "./promo.types.js";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const isoDateTimeSchema = z.string().datetime({ offset: true }).or(z.string().datetime());

export const promoIdParamsSchema = z.object({ promoId: objectIdSchema }).strict();

const promoWriteBodyBase = z
  .object({
    code: z.string().trim().min(1).max(40),
    type: z.enum(promoTypes),
    value: z.number().positive(),
    scope: z.enum(promoScopes),
    businessIds: z.array(objectIdSchema).max(200).default([]),
    startAt: isoDateTimeSchema.optional(),
    expiresAt: isoDateTimeSchema,
    totalUsageLimit: z.number().int().positive().optional(),
    perUserUsageLimit: z.number().int().positive().optional(),
  })
  .strict()
  .refine((value) => value.scope !== "SELECTED_BUSINESSES" || value.businessIds.length > 0, {
    message: "SELECTED_BUSINESSES scope requires at least one businessId",
    path: ["businessIds"],
  })
  .refine((value) => !value.startAt || new Date(value.startAt) < new Date(value.expiresAt), {
    message: "startAt must be before expiresAt",
    path: ["startAt"],
  });

export const createPromoBodySchema = promoWriteBodyBase.transform((value) => ({
  code: value.code,
  type: value.type,
  value: value.value,
  scope: value.scope,
  businessIds: value.businessIds,
  startAt: value.startAt ? new Date(value.startAt) : undefined,
  expiresAt: new Date(value.expiresAt),
  totalUsageLimit: value.totalUsageLimit,
  perUserUsageLimit: value.perUserUsageLimit,
}));

export const updatePromoBodySchema = z
  .object({
    code: z.string().trim().min(1).max(40).optional(),
    type: z.enum(promoTypes).optional(),
    value: z.number().positive().optional(),
    scope: z.enum(promoScopes).optional(),
    businessIds: z.array(objectIdSchema).max(200).optional(),
    startAt: isoDateTimeSchema.optional(),
    expiresAt: isoDateTimeSchema.optional(),
    totalUsageLimit: z.number().int().positive().optional(),
    perUserUsageLimit: z.number().int().positive().optional(),
  })
  .strict()
  .transform((value) => ({
    ...value,
    startAt: value.startAt ? new Date(value.startAt) : undefined,
    expiresAt: value.expiresAt ? new Date(value.expiresAt) : undefined,
  }));

export const setPromoStatusBodySchema = z.object({ status: z.enum(promoStatuses) }).strict();

const paginationQuerySchema = z.object({
  page: z.string().regex(/^\d+$/, "Invalid page").optional(),
  limit: z.string().regex(/^\d+$/, "Invalid limit").optional(),
});

export const listPromosQuerySchema = paginationQuerySchema
  .extend({
    status: z.enum(promoStatuses).optional(),
    q: z.string().trim().max(200).optional(),
  })
  .strict()
  .transform((value) => ({
    status: value.status,
    q: value.q,
    page: value.page ? Math.max(1, Number(value.page)) : 1,
    limit: value.limit ? Math.min(100, Math.max(1, Number(value.limit))) : 20,
  }));

export const listPromoRedemptionsQuerySchema = paginationQuerySchema
  .strict()
  .transform((value) => ({
    page: value.page ? Math.max(1, Number(value.page)) : 1,
    limit: value.limit ? Math.min(100, Math.max(1, Number(value.limit))) : 20,
  }));

export type PromoIdParams = z.infer<typeof promoIdParamsSchema>;
export type CreatePromoBody = z.infer<typeof createPromoBodySchema>;
export type UpdatePromoBody = z.infer<typeof updatePromoBodySchema>;
export type SetPromoStatusBody = z.infer<typeof setPromoStatusBodySchema>;
export type ListPromosQuery = z.infer<typeof listPromosQuerySchema>;
export type ListPromoRedemptionsQuery = z.infer<typeof listPromoRedemptionsQuerySchema>;
