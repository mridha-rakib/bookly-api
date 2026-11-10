import type { Types } from "mongoose";

import { PLATFORM_REPORTING_TIMEZONE } from "../time/platform-reporting.js";

/**
 * P2.2.4 — Super Admin City and Day reporting dimensions.
 *
 * - City: the REGISTERED city (`Business.address.city`) of the Business an activity belongs to,
 *   resolved once into that city's Business ids. Never Customer location, appointment GPS or a
 *   service area.
 * - Day: the Monday–Sunday day of week of each metric's own established event timestamp
 *   (Bookings: `createdAt`; ledger revenue: ledger `createdAt`), in Europe/Nicosia.
 */
export const reportingDays = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;
export type ReportingDay = (typeof reportingDays)[number];

/** ISO day of week (Monday = 1 … Sunday = 7), as returned by MongoDB `$isoDayOfWeek`. */
export const isoDayOfWeekFor = (day: ReportingDay): number => reportingDays.indexOf(day) + 1;

export type PlatformReportingScope = {
  /** The selected city's Business ids (empty array = a city with no Businesses: matches nothing). */
  businessIds?: Types.ObjectId[] | undefined;
  /** ISO day of week in Europe/Nicosia. */
  isoDayOfWeek?: number | undefined;
};

/** Extra `$match` conditions for a scoped reporting query. `timestampField` is the metric's own
 * event time; `businessField` is how the collection references its Business (`businessId`, or
 * `_id` for the Business collection itself). Returns `{}` when no dimension is selected, so
 * unscoped queries are exactly unchanged. */
export const reportingScopeMatch = (
  scope: PlatformReportingScope | undefined,
  options: { timestampField?: string; businessField?: string } = {},
): Record<string, unknown> => {
  if (!scope) return {};
  const timestampField = options.timestampField ?? "createdAt";
  const businessField = options.businessField ?? "businessId";
  return {
    ...(scope.businessIds ? { [businessField]: { $in: scope.businessIds } } : {}),
    ...(scope.isoDayOfWeek
      ? {
          $expr: {
            $eq: [
              {
                $isoDayOfWeek: {
                  date: `$${timestampField}`,
                  timezone: PLATFORM_REPORTING_TIMEZONE,
                },
              },
              scope.isoDayOfWeek,
            ],
          },
        }
      : {}),
  };
};

export const hasReportingScope = (scope: PlatformReportingScope | undefined): boolean =>
  Boolean(scope && (scope.businessIds || scope.isoDayOfWeek));
