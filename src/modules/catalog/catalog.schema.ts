import { z } from "zod";
import { ANY_STAFF } from "../availability/availability.types.js";
import { businessCities } from "../business/business.types.js";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a YYYY-MM-DD date");

export const catalogBusinessParamsSchema = z.object({ businessId: objectIdSchema }).strict();

export const catalogServiceParamsSchema = z
  .object({ businessId: objectIdSchema, serviceId: objectIdSchema })
  .strict();

// Reuses the exact same shape as availability.schema.ts's getAvailabilityQuerySchema (Owner-
// facing) — same query contract, different (Customer) authorization, never a re-derived one.
export const catalogAvailabilityQuerySchema = z
  .object({
    fromDate: isoDateSchema,
    toDate: isoDateSchema,
    staffMembershipId: z.union([objectIdSchema, z.literal(ANY_STAFF)]).optional(),
    partySize: z.coerce.number().int().min(1).max(1000).optional(),
    customerCity: z.enum(businessCities).optional(),
  })
  .strict();

export type CatalogBusinessParams = z.infer<typeof catalogBusinessParamsSchema>;
export type CatalogServiceParams = z.infer<typeof catalogServiceParamsSchema>;
export type CatalogAvailabilityQuery = z.infer<typeof catalogAvailabilityQuerySchema>;
