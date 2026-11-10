import { z } from "zod";
import { addCalendarDays, utcToBusinessLocalDate } from "../../common/time/business-clock.js";
import { PLATFORM_REPORTING_TIMEZONE } from "../../common/time/platform-reporting.js";
import { businessCities, businessVisitTypes } from "../business/business.types.js";
import {
  DISCOVERY_AVAILABILITY_MAX_DAYS_AHEAD,
  DISCOVERY_MAX_RADIUS_KM,
  DISCOVERY_MIN_RADIUS_KM,
  DISCOVERY_SEARCH_MAX_LENGTH,
  type DiscoveryAvailabilityWindow,
  discoveryAvailabilityWindowKeys,
  discoverySortOptions,
  HOME_SECTION_DEFAULT_LIMIT,
  HOME_SECTION_MAX_LIMIT,
} from "./discovery.types.js";

const coordinate = (min: number, max: number) => z.coerce.number().min(min).max(max);

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
    // P2.2.3 — explicit visitor origin (never stored, never inferred from a city), radius.
    nearLat: coordinate(-90, 90).optional(),
    nearLng: coordinate(-180, 180).optional(),
    radiusKm: z.coerce
      .number()
      .min(DISCOVERY_MIN_RADIUS_KM)
      .max(DISCOVERY_MAX_RADIUS_KM)
      .optional(),
    // P2.2.3 — availability context: one Business-local date, a time window, optional service text.
    availDate: z.string().date().optional(),
    availWindow: z.enum(discoveryAvailabilityWindowKeys as [string, ...string[]]).optional(),
    availService: z.string().trim().min(1).max(DISCOVERY_SEARCH_MAX_LENGTH).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasOrigin = value.nearLat !== undefined && value.nearLng !== undefined;
    if ((value.nearLat === undefined) !== (value.nearLng === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["nearLat"],
        message: "nearLat and nearLng go together",
      });
    }
    if (!hasOrigin && (value.radiusKm !== undefined || value.sort === "distance")) {
      context.addIssue({
        code: "custom",
        path: ["nearLat"],
        message: "A location is required for distance",
      });
    }
    if (!value.availDate && (value.availWindow || value.availService)) {
      context.addIssue({
        code: "custom",
        path: ["availDate"],
        message: "Choose a date to check availability",
      });
    }
    if (value.availDate) {
      const today = utcToBusinessLocalDate(PLATFORM_REPORTING_TIMEZONE, new Date()).dateStr;
      const yesterday = addCalendarDays(today, -1); // tolerate a Business-local day behind Cyprus
      const latest = addCalendarDays(today, DISCOVERY_AVAILABILITY_MAX_DAYS_AHEAD);
      if (value.availDate < yesterday || value.availDate > latest) {
        context.addIssue({
          code: "custom",
          path: ["availDate"],
          message: "Choose a date from today onwards",
        });
      }
    }
  })
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
    origin:
      value.nearLat !== undefined && value.nearLng !== undefined
        ? { lat: value.nearLat, lng: value.nearLng }
        : undefined,
    radiusKm: value.radiusKm,
    availability: value.availDate
      ? {
          date: value.availDate,
          window: (value.availWindow ?? "ANY") as DiscoveryAvailabilityWindow,
          serviceQuery: value.availService,
        }
      : undefined,
  }));

export type ListDiscoveryBusinessesQuery = z.infer<typeof listDiscoveryBusinessesQuerySchema>;

/**
 * Batch 17 — homepage discovery sections. `city` (single, real enum) is the hero search bar's
 * picked city and drives "Services near you". `category` (comma-separated real
 * `Business.category` strings — the homepage category tile the visitor picked) is an optional
 * hard eligibility filter applied to all three rows; each row keeps its own ranking within it.
 * Both are optional — with neither, every section still returns an honest, unfiltered ranking.
 */
export const homeSectionsQuerySchema = z
  .object({
    city: z.enum(businessCities).optional(),
    category: z.string().optional(),
    limit: z.string().regex(/^\d+$/, "Invalid limit").optional(),
  })
  .strict()
  .transform((value) => ({
    city: value.city,
    category: value.category
      ? value.category
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c.length > 0)
      : undefined,
    limit: value.limit
      ? Math.min(HOME_SECTION_MAX_LIMIT, Math.max(1, Number(value.limit)))
      : HOME_SECTION_DEFAULT_LIMIT,
  }));

export type HomeSectionsQuery = z.infer<typeof homeSectionsQuerySchema>;
