import type { Types } from "mongoose";
import {
  addCalendarDays,
  utcToBusinessLocalDate,
  utcToBusinessLocalTime,
} from "../../common/time/business-clock.js";
import {
  PLATFORM_REPORTING_TIMEZONE,
  platformDayStartUtc,
} from "../../common/time/platform-reporting.js";
import { AvailabilityError } from "../availability/availability.errors.js";
import type { AvailabilityService } from "../availability/availability.service.js";
import type { BusinessCity } from "../business/business.types.js";
import type { BusinessMediaRepository } from "../business-media/business-media.repository.js";
import type { ServiceRepository } from "../services/service.repository.js";
import type { StorageService } from "../storage/storage.service.js";
import type {
  DiscoveryBusinessCardDto,
  DiscoveryListMeta,
  DiscoveryListResult,
  FoundingPartnerCardDto,
  HomeSectionsResultDto,
} from "./discovery.dto.js";
import type {
  DiscoveryAggregateRow,
  DiscoveryFilter,
  DiscoveryPagination,
  DiscoveryRankingContext,
  DiscoveryRepository,
} from "./discovery.repository.js";
import {
  DISCOVERY_AVAILABILITY_CANDIDATE_LIMIT,
  DISCOVERY_AVAILABILITY_CONCURRENCY,
  DISCOVERY_AVAILABILITY_SERVICE_LIMIT,
  DISCOVERY_TRENDING_WINDOW_DAYS,
  type DiscoveryAvailabilityWindow,
  type DiscoverySortOption,
  discoveryAvailabilityWindows,
  discoveryTrendingBookingStatuses,
} from "./discovery.types.js";

/** P2.2.3 — availability context for Explore: one Business-local date and a time window. */
export type DiscoveryAvailabilityQuery = {
  date: string;
  window: DiscoveryAvailabilityWindow;
  serviceQuery?: string | undefined;
};

/** Runs `task` over `items` with at most `limit` in flight; results keep input order. */
const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
};

/** Batch 16 — composes the real aggregation (`DiscoveryRepository.search`/`getCardsByIds`) with a
 * SECOND, batched (never per-card) lookup of each Business's cover photo — `getObjectUrl` is a
 * local signed-URL computation (no network round trip, see business.service.ts's own identical
 * pattern), so resolving N cover photos for a page of N cards costs zero extra queries beyond the
 * one already-batched `listProfileByBusinessIds` call. */
export class DiscoveryService {
  public constructor(
    private readonly discoveryRepository: DiscoveryRepository,
    private readonly businessMediaRepository: Pick<
      BusinessMediaRepository,
      "listProfileByBusinessIds"
    >,
    private readonly storageService?: Pick<StorageService, "getObjectUrl">,
    /** P2.2.3 — the existing booking availability engine (read-only use). */
    private readonly availabilityService?: Pick<AvailabilityService, "getAvailability">,
    private readonly serviceRepository?: Pick<ServiceRepository, "listActiveBookableByBusinessIds">,
  ) {}

  /**
   * Explore search. P2.2.3 adds:
   * - `recommended`: the Home "Recommended" ranking (signed-in Customer's own booked
   *   categories/cities, then quality); a public quality ranking otherwise.
   * - `trending`: confirmed Bookings created in the last 30 Cyprus days, then quality.
   * - origin/radius/`distance`: straight-line km to each Business's stored location.
   * - availability: Businesses with at least one bookable slot (existing AvailabilityService) on
   *   the chosen date and window, over a bounded best-ranked candidate set.
   */
  public async search(
    filter: DiscoveryFilter,
    sort: DiscoverySortOption,
    pagination: DiscoveryPagination,
    options: {
      customerUserId?: Types.ObjectId | undefined;
      availability?: DiscoveryAvailabilityQuery | undefined;
      now?: Date | undefined;
    } = {},
  ): Promise<DiscoveryListResult> {
    const now = options.now ?? new Date();
    const meta: DiscoveryListMeta = { sort };
    const context: DiscoveryRankingContext = {};

    if (sort === "recommended") {
      context.affinity = options.customerUserId
        ? await this.discoveryRepository.getCustomerAffinity(options.customerUserId)
        : { categories: [], cities: [] };
      meta.personalized =
        context.affinity.categories.length > 0 || context.affinity.cities.length > 0;
    }
    if (sort === "trending") {
      const today = utcToBusinessLocalDate(PLATFORM_REPORTING_TIMEZONE, now).dateStr;
      context.trendingSince = platformDayStartUtc(
        addCalendarDays(today, -(DISCOVERY_TRENDING_WINDOW_DAYS - 1)),
      );
      meta.trending = {
        from: context.trendingSince.toISOString(),
        to: now.toISOString(),
        timezone: PLATFORM_REPORTING_TIMEZONE,
        statuses: [...discoveryTrendingBookingStatuses],
      };
    }
    if (filter.origin) {
      meta.distance = {
        unit: "km",
        measure: "STRAIGHT_LINE_TO_BUSINESS_LOCATION",
        radiusKm: filter.radiusKm ?? null,
      };
    }

    if (!options.availability) {
      const { rows, total } = await this.discoveryRepository.search(
        filter,
        sort,
        pagination,
        context,
      );
      const businesses = await this.rowsToCards(rows);
      return {
        businesses,
        pagination: { page: pagination.page, limit: pagination.limit, total },
        meta,
      };
    }

    // Availability: check a bounded, best-ranked candidate set, then paginate the matches.
    const availability = options.availability;
    const candidates = await this.discoveryRepository.search(
      filter,
      sort,
      { page: 1, limit: DISCOVERY_AVAILABILITY_CANDIDATE_LIMIT },
      context,
    );
    const evaluation = await this.evaluateAvailability(candidates.rows, availability, filter, now);
    const matched = candidates.rows
      .map((row, index) => ({ row, found: evaluation.results[index] }))
      .filter(
        (entry): entry is { row: DiscoveryAggregateRow; found: NonNullable<typeof entry.found> } =>
          Boolean(entry.found),
      );
    const start = (pagination.page - 1) * pagination.limit;
    const page = matched.slice(start, start + pagination.limit);
    const cards = await this.rowsToCards(page.map((entry) => entry.row));
    meta.availability = {
      date: availability.date,
      window: availability.window,
      serviceQuery: availability.serviceQuery ?? null,
      candidatesChecked: candidates.rows.length,
      candidateLimitReached: candidates.total > candidates.rows.length,
      travelBusinessesNeedCity: evaluation.travelSkipped,
    };
    return {
      businesses: cards.map((card, index) => ({ ...card, availability: page[index]?.found })),
      pagination: { page: pagination.page, limit: pagination.limit, total: matched.length },
      meta,
    };
  }

  /** For each candidate, the earliest slot (any eligible Staff) of its first matching Service
   * that starts inside the window on the Business's own clock — straight from
   * AvailabilityService.getAvailability, which applies opening hours, Staff schedules,
   * recurring off-days, dated time off, closed periods, slot blocks, booking notice/advance
   * limits, DST and existing reservations. Read-only: nothing is reserved. */
  private async evaluateAvailability(
    rows: DiscoveryAggregateRow[],
    query: DiscoveryAvailabilityQuery,
    filter: DiscoveryFilter,
    now: Date,
  ): Promise<{
    results: Array<{ serviceId: string; serviceName: string; firstSlotStartAt: string } | null>;
    travelSkipped: number;
  }> {
    if (!this.availabilityService || !this.serviceRepository) {
      throw new Error("Availability filtering is not configured");
    }
    const availabilityService = this.availabilityService;
    const window = discoveryAvailabilityWindows[query.window];
    const customerCity = filter.city?.length === 1 ? filter.city[0] : undefined;
    const services = await this.serviceRepository.listActiveBookableByBusinessIds(
      rows.map((row) => row._id),
    );
    const pattern = query.serviceQuery
      ? new RegExp(query.serviceQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
      : undefined;
    let travelSkipped = 0;

    const results = await mapWithConcurrency(
      rows,
      DISCOVERY_AVAILABILITY_CONCURRENCY,
      async (row) => {
        if (row.visitType === "TRAVEL_TO_CUSTOMER" && !customerCity) {
          travelSkipped += 1;
          return null;
        }
        const candidates = services
          .filter((service) => String(service.businessId) === String(row._id))
          .filter((service) => !pattern || pattern.test(service.name))
          .slice(0, DISCOVERY_AVAILABILITY_SERVICE_LIMIT);
        for (const service of candidates) {
          try {
            const result = await availabilityService.getAvailability({
              businessId: String(row._id),
              serviceId: String(service._id),
              fromDate: query.date,
              toDate: query.date,
              customerCity,
            });
            const slot = (result.days[0]?.slots ?? [])
              .filter((candidate) => new Date(candidate.startAt) > now)
              .find((candidate) => {
                const local = utcToBusinessLocalTime(result.timezone, new Date(candidate.startAt));
                return local >= window.start && local < window.end;
              });
            if (slot) {
              return {
                serviceId: String(service._id),
                serviceName: service.name,
                firstSlotStartAt: slot.startAt,
              };
            }
          } catch (error) {
            // A Service/Business that cannot be offered (e.g. city not served) is simply not a
            // match; any other failure aborts the request so the client can Retry.
            if (!(error instanceof AvailabilityError)) throw error;
          }
        }
        return null;
      },
    );
    return { results, travelSkipped };
  }

  /** Enriches an explicit, already-ordered list of businessIds (e.g. a Favorites page) into the
   * same card DTO shape — never re-runs a full marketplace search. */
  public async getCardsByIds(businessIds: Types.ObjectId[]): Promise<DiscoveryBusinessCardDto[]> {
    const rows = await this.discoveryRepository.getCardsByIds(businessIds);
    const cardById = new Map((await this.rowsToCards(rows)).map((card) => [card.id, card]));
    // Preserve the caller's own order (favorited-at order) — `$in` does not guarantee it.
    return businessIds.map((id) => cardById.get(String(id))).filter((card) => card !== undefined);
  }

  public async listCategories(): Promise<string[]> {
    return this.discoveryRepository.listDistinctCategories();
  }

  /** Public landing founding-partners section. One filtered/projected DB query, then the SAME
   * batched cover-photo lookup `search` uses (never one signed-URL call per card beyond the
   * single `listProfileByBusinessIds`). */
  public async listFoundingPartners(): Promise<FoundingPartnerCardDto[]> {
    const rows = await this.discoveryRepository.listFoundingPartners();
    if (rows.length === 0) {
      return [];
    }

    const profileMedia = await this.businessMediaRepository.listProfileByBusinessIds(
      rows.map((row) => row._id),
    );
    const imageUrlByBusinessId = new Map(
      await Promise.all(
        profileMedia.map(async (media) => {
          const url =
            (await this.storageService?.getObjectUrl({ key: media.storageKey })) ?? undefined;
          return [String(media.businessId), url] as const;
        }),
      ),
    );

    return rows.map((row) => ({
      id: String(row._id),
      name: row.name,
      city: row.address.city,
      imageUrl: imageUrlByBusinessId.get(String(row._id)),
    }));
  }

  /**
   * Batch 17 — the homepage's three discovery rows. Each is a distinct real ranking (see
   * discovery.repository.ts); this method only orchestrates de-duplication and the single
   * batched cover-photo lookup shared across all three.
   *
   * De-dup: Recommended is built first, then Near You excluding it, then Popular excluding
   * both. A section that comes up short (small eligible inventory) is topped up with a second,
   * exclusion-relaxed ranked query — deterministic overlap, never random padding.
   *
   * `contextCategories` (the homepage category tile the visitor picked) is a hard eligibility
   * filter applied identically to all three rows — each row keeps its own ranking, just over
   * the businesses whose `Business.category` is in the list. Omitted / empty = every row
   * behaves exactly as before.
   */
  public async getHomeSections(params: {
    city?: BusinessCity | undefined;
    contextCategories?: string[] | undefined;
    customerUserId?: Types.ObjectId | undefined;
    limit: number;
  }): Promise<HomeSectionsResultDto> {
    const { limit } = params;

    const affinity = params.customerUserId
      ? await this.discoveryRepository.getCustomerAffinity(params.customerUserId)
      : { categories: [], cities: [] };
    const personalized = affinity.categories.length > 0 || affinity.cities.length > 0;

    // The picked homepage category tile (if any) — a hard eligibility filter for every row.
    const categoryFilter =
      params.contextCategories && params.contextCategories.length > 0
        ? params.contextCategories
        : undefined;

    const recommendedRows = await this.discoveryRepository.rankRecommended({
      affinity,
      contextCategories: categoryFilter,
      excludeIds: [],
      limit,
    });

    const nearYouRows = await this.fillSection(recommendedRows, limit, (excludeIds, take) =>
      this.discoveryRepository.rankNearYou({
        city: params.city,
        category: categoryFilter,
        excludeIds,
        limit: take,
      }),
    );

    const popularRows = await this.fillSection(
      [...recommendedRows, ...nearYouRows],
      limit,
      (excludeIds, take) =>
        this.discoveryRepository.rankByPopularity({
          category: categoryFilter,
          excludeIds,
          limit: take,
        }),
    );

    const imageUrlByBusinessId = await this.imageUrlByBusinessId([
      ...recommendedRows,
      ...nearYouRows,
      ...popularRows,
    ]);

    return {
      recommended: recommendedRows.map((row) => this.toCard(row, imageUrlByBusinessId)),
      nearYou: nearYouRows.map((row) => this.toCard(row, imageUrlByBusinessId)),
      popular: popularRows.map((row) => this.toCard(row, imageUrlByBusinessId)),
      meta: { personalized, nearYouCity: params.city ?? null },
    };
  }

  /** Run `rank` excluding everything already shown; if that leaves the section short, run it
   * once more excluding only what THIS section already has (so it backfills with
   * earlier-section Businesses) until it reaches `limit` or the ranking is exhausted. */
  private async fillSection(
    alreadyShown: DiscoveryAggregateRow[],
    limit: number,
    rank: (excludeIds: Types.ObjectId[], take: number) => Promise<DiscoveryAggregateRow[]>,
  ): Promise<DiscoveryAggregateRow[]> {
    const shownIds = alreadyShown.map((row) => row._id);
    const primary = await rank(shownIds, limit);
    if (primary.length >= limit) {
      return primary;
    }

    const have = new Set(primary.map((row) => String(row._id)));
    const backfill = await rank(
      primary.map((row) => row._id),
      limit - primary.length,
    );
    return [...primary, ...backfill.filter((row) => !have.has(String(row._id)))];
  }

  private async imageUrlByBusinessId(
    rows: DiscoveryAggregateRow[],
  ): Promise<Map<string, string | undefined>> {
    const uniqueIds = [...new Map(rows.map((row) => [String(row._id), row._id])).values()];
    const profileMedia = await this.businessMediaRepository.listProfileByBusinessIds(uniqueIds);
    return new Map(
      await Promise.all(
        profileMedia.map(async (media) => {
          const url =
            (await this.storageService?.getObjectUrl({ key: media.storageKey })) ?? undefined;
          return [String(media.businessId), url] as const;
        }),
      ),
    );
  }

  private toCard(
    row: DiscoveryAggregateRow,
    imageUrlByBusinessId: Map<string, string | undefined>,
  ): DiscoveryBusinessCardDto {
    return {
      id: String(row._id),
      name: row.name,
      category: row.category,
      subcategories: row.subcategories,
      city: row.city,
      visitType: row.visitType,
      averageRating: row.averageRating === null ? null : Math.round(row.averageRating * 10) / 10,
      reviewCount: row.reviewCount,
      startingPriceCents: row.startingPriceCents,
      startingPricingMode: row.startingPricingMode,
      imageUrl: imageUrlByBusinessId.get(String(row._id)),
      isAvailable: row.isAvailable,
      location: row.location,
      ...(row.distanceKm !== undefined ? { distanceKm: row.distanceKm } : {}),
    };
  }

  private async rowsToCards(rows: DiscoveryAggregateRow[]): Promise<DiscoveryBusinessCardDto[]> {
    const imageUrlByBusinessId = await this.imageUrlByBusinessId(rows);
    return rows.map((row) => this.toCard(row, imageUrlByBusinessId));
  }
}
