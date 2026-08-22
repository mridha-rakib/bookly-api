import { z } from "zod";

import { businessCities } from "../business/business.types.js";
import { ANY_STAFF } from "./availability.types.js";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a YYYY-MM-DD date");

export const availabilityParamsSchema = z
  .object({ businessId: objectIdSchema, serviceId: objectIdSchema })
  .strict();

export const getAvailabilityQuerySchema = z
  .object({
    fromDate: isoDateSchema,
    toDate: isoDateSchema,
    staffMembershipId: z.union([objectIdSchema, z.literal(ANY_STAFF)]).optional(),
    partySize: z.coerce.number().int().min(1).max(1000).optional(),
    customerCity: z.enum(businessCities).optional(),
  })
  .strict();

export type AvailabilityParams = z.infer<typeof availabilityParamsSchema>;
export type GetAvailabilityQuery = z.infer<typeof getAvailabilityQuerySchema>;
