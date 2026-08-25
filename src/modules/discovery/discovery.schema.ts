import { z } from "zod";

import { businessCities, businessVisitTypes } from "../business/business.types.js";
import { DISCOVERY_SEARCH_MAX_LENGTH, discoverySortOptions } from "./discovery.types.js";

export const listDiscoveryBusinessesQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(DISCOVERY_SEARCH_MAX_LENGTH).optional(),
    // Comma-separated — matches the existing multi-select checkbox UI for both facets (same
    // split-and-filter convention as booking.schema.ts's `status`/`source`).
    city: z.string().optional(),
    visitType: z.enum(businessVisitTypes).optional(),
    category: z.string().optional(),
    minRating: z.coerce.number().min(1).max(5).optional(),
    sort: z.enum(discoverySortOptions).optional(),
    page: z.string().regex(/^\d+$/, "Invalid page").optional(),
    limit: z.string().regex(/^\d+$/, "Invalid limit").optional(),
  })
  .strict()
  .transform((value) => ({
    q: value.q,
    city: value.city
      ? (value.city
          .split(",")
          .filter((c) =>
            (businessCities as readonly string[]).includes(c),
          ) as (typeof businessCities)[number][])
      : undefined,
    visitType: value.visitType,
    category: value.category
      ? value.category
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c.length > 0)
      : undefined,
    minRating: value.minRating,
    sort: value.sort ?? "mostRelevant",
    page: value.page ? Math.max(1, Number(value.page)) : 1,
    limit: value.limit ? Math.min(50, Math.max(1, Number(value.limit))) : 20,
  }));

export type ListDiscoveryBusinessesQuery = z.infer<typeof listDiscoveryBusinessesQuerySchema>;
