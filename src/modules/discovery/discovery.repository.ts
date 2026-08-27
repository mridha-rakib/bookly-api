import type { PipelineStage, Types } from "mongoose";

import { BookingModel } from "../booking/booking.model.js";
import { BusinessModel } from "../business/business.model.js";
import {
  type BusinessCity,
  type BusinessVisitType,
  businessCities,
} from "../business/business.types.js";
import type { ServicePricingMode } from "../services/service.types.js";
import {
  type DiscoverySortOption,
  HOME_POPULAR_WEIGHT_COMPLETED_BOOKING,
  HOME_POPULAR_WEIGHT_FAVORITE,
  HOME_POPULAR_WEIGHT_REVIEW,
  HOME_RECOMMENDED_AFFINITY_BOOKING_SAMPLE,
  HOME_RECOMMENDED_AFFINITY_CATEGORY_RANK,
  HOME_RECOMMENDED_AFFINITY_CITY_RANK,
  homeSectionBookingPopularityStatuses,
} from "./discovery.types.js";

export type DiscoveryFilter = {
  q?: string | undefined;
  /** Array to match the existing Explore sidebar's own multi-select checkbox UI (city/category
   * are both checkbox groups, never single-select radios) — `$in`, never a single equality. */
  city?: BusinessCity[] | undefined;
  visitType?: BusinessVisitType | undefined;
  category?: string[] | undefined;
  minRating?: number | undefined;
};

export type DiscoveryPagination = { page: number; limit: number };

export type DiscoveryAggregateRow = {
  _id: Types.ObjectId;
  name: string;
  category: string;
  subcategories: string[];
  city: BusinessCity;
  visitType: BusinessVisitType;
  averageRating: number | null;
  reviewCount: number;
  startingPriceCents: number | null;
  startingPricingMode: ServicePricingMode | null;
  isAvailable: boolean;
};

export type FoundingPartnerRow = {
  _id: Types.ObjectId;
  name: string;
  address: { city: BusinessCity };
};

type RawAggregateRow = {
  _id: Types.ObjectId;
  name: string;
  category: string;
  subcategories: string[];
  address: { city: BusinessCity };
  visitType: BusinessVisitType;
  status: string;
  averageRating: number | null;
  reviewCount: number;
  startingPriceCents: number | null;
  startingPricingMode: ServicePricingMode | null;
};

/** The rating + cheapest-Service lookup stages shared by both `search` (Explore) and
 * `getCardsByIds` (Favorites enrichment) — one definition, never duplicated aggregation logic. */
const ratingAndPriceLookupStages: PipelineStage[] = [
  {
    $lookup: {
      from: "reviews",
      let: { businessId: "$_id" },
      pipeline: [
        { $match: { $expr: { $eq: ["$businessId", "$$businessId"] }, status: "PUBLISHED" } },
        { $group: { _id: null, averageRating: { $avg: "$rating" }, reviewCount: { $sum: 1 } } },
      ],
      as: "ratingAgg",
    },
  },
  {
    $lookup: {
      from: "services",
      let: { businessId: "$_id" },
      pipeline: [
        {
          $match: {
            $expr: { $eq: ["$businessId", "$$businessId"] },
            status: "ACTIVE",
            isPackageDeal: false,
          },
        },
        {
          $project: {
            pricingMode: 1,
            priceCents: {
              // MongoDB's $switch operator requires the literal "then" key below — not a
              // real thenable, just this pipeline stage's own required syntax.
              $switch: {
                branches: [
                  {
                    case: { $eq: ["$pricingMode", "FIXED"] },
                    // biome-ignore lint/suspicious/noThenProperty: required $switch branch key
                    then: "$fixedPricing.priceCents",
                  },
                  {
                    case: { $eq: ["$pricingMode", "HOURLY"] },
                    // biome-ignore lint/suspicious/noThenProperty: required $switch branch key
                    then: "$hourlyPricing.ratePerHourCents",
                  },
                  {
                    case: { $eq: ["$pricingMode", "PER_PERSON"] },
                    // biome-ignore lint/suspicious/noThenProperty: required $switch branch key
                    then: "$perPersonPricing.ratePerPersonCents",
                  },
                ],
                default: null,
              },
            },
          },
        },
        { $match: { priceCents: { $ne: null } } },
        { $sort: { priceCents: 1 } },
        { $limit: 1 },
      ],
      as: "cheapestService",
    },
  },
  {
    $addFields: {
      averageRating: { $arrayElemAt: ["$ratingAgg.averageRating", 0] },
      reviewCount: { $ifNull: [{ $arrayElemAt: ["$ratingAgg.reviewCount", 0] }, 0] },
      startingPriceCents: { $arrayElemAt: ["$cheapestService.priceCents", 0] },
      startingPricingMode: { $arrayElemAt: ["$cheapestService.pricingMode", 0] },
    },
  },
];

const cardProjection = {
  _id: 1,
  name: 1,
  category: 1,
  subcategories: 1,
  "address.city": 1,
  visitType: 1,
  status: 1,
  averageRating: 1,
  reviewCount: 1,
  startingPriceCents: 1,
  startingPricingMode: 1,
};

/** Batch 17 — the null-safe sort scaffolding every home-section ranking shares. `qualityScore`
 * is `avg(rating) * log10(reviewCount + 1)` — a Business with zero PUBLISHED reviews scores
 * exactly 0 (log10(1)) and sinks, but is never removed (small-inventory rows must still show). */
const homeSortFieldsStage: PipelineStage = {
  $addFields: {
    averageRatingSortValue: { $ifNull: ["$averageRating", 0] },
    reviewCountSortValue: { $ifNull: ["$reviewCount", 0] },
    qualityScore: {
      $multiply: [
        { $ifNull: ["$averageRating", 0] },
        { $log10: { $add: [{ $ifNull: ["$reviewCount", 0] }, 1] } },
      ],
    },
  },
};

export type HomeRankParams = {
  /** Businesses already placed in an earlier section — excluded unless backfilling. */
  excludeIds: Types.ObjectId[];
  limit: number;
};

export type CustomerAffinity = { categories: string[]; cities: BusinessCity[] };

const homeVisibilityMatch = (excludeIds: Types.ObjectId[]): Record<string, unknown> => ({
  status: { $in: PUBLICLY_VISIBLE_STATUSES },
  ...(excludeIds.length > 0 ? { _id: { $nin: excludeIds } } : {}),
});

const toAggregateRow = (row: RawAggregateRow): DiscoveryAggregateRow => ({
  _id: row._id,
  name: row.name,
  category: row.category,
  subcategories: row.subcategories ?? [],
  city: row.address.city,
  visitType: row.visitType,
  averageRating: row.averageRating === undefined ? null : row.averageRating,
  reviewCount: row.reviewCount,
  startingPriceCents: row.startingPriceCents === undefined ? null : row.startingPriceCents,
  startingPricingMode: row.startingPricingMode === undefined ? null : row.startingPricingMode,
  isAvailable: PUBLICLY_VISIBLE_STATUSES.includes(
    row.status as (typeof PUBLICLY_VISIBLE_STATUSES)[number],
  ),
});

// The Business statuses a Customer-facing surface may ever see — matches
// `requireApprovedBusiness`'s own pass-through logic exactly (PENDING/SUSPENDED both blocked
// there); this is the SAME visibility semantics, not a second interpretation of "public Business".
const PUBLICLY_VISIBLE_STATUSES = ["APPROVED", "WARNING"] as const;

const sortStageFor = (sort: DiscoverySortOption): Record<string, 1 | -1> => {
  switch (sort) {
    case "ratingHighToLow":
      // MongoDB sorts `null` FIRST even in a descending numeric sort, which would put
      // zero-review Businesses at the very top of "Rating (High to Low)" — sorts against the
      // null-safe substitute field instead (added below), never the raw nullable value.
      return { averageRatingSortValue: -1, _id: 1 };
    case "priceLowToHigh":
      // hasStartingPrice sorts ascending FIRST (0 = has a real price, 1 = none) so a
      // no-price Business always lands last, regardless of the chosen direction — never
      // "the most expensive" just because MAX_SAFE_INTEGER was used as its null substitute.
      return { hasNoStartingPrice: 1, startingPriceSortValue: 1, _id: 1 };
    case "priceHighToLow":
      return { hasNoStartingPrice: 1, startingPriceSortValue: -1, _id: 1 };
    default:
      // No ranking formula exists for "relevance" (confirmed — nothing invented here); falls
      // back to a stable, deterministic order.
      return { name: 1, _id: 1 };
  }
};

/**
 * Batch 16 — Explore's real backend. A single aggregation pipeline (Business visibility/filters
 * -> batched Review rating lookup -> batched cheapest-ACTIVE-Service price lookup -> optional
 * rating filter -> deterministic sort -> paginated facet) so an Explore page of N cards costs
 * exactly one query, never N. Business media (profile image) is intentionally NOT joined here —
 * URL signing is a local JS computation the aggregation pipeline can't perform; see
 * discovery.service.ts's batched follow-up lookup.
 */
export class DiscoveryRepository {
  public async search(
    filter: DiscoveryFilter,
    sort: DiscoverySortOption,
    pagination: DiscoveryPagination,
  ): Promise<{ rows: DiscoveryAggregateRow[]; total: number }> {
    const match: Record<string, unknown> = { status: { $in: PUBLICLY_VISIBLE_STATUSES } };
    if (filter.city && filter.city.length > 0) match["address.city"] = { $in: filter.city };
    if (filter.visitType) match["visitType"] = filter.visitType;
    if (filter.category && filter.category.length > 0) match["category"] = { $in: filter.category };
    if (filter.q) {
      const escaped = filter.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      match["name"] = new RegExp(escaped, "i");
    }

    const skip = (pagination.page - 1) * pagination.limit;

    const pipeline: PipelineStage[] = [
      { $match: match },
      ...ratingAndPriceLookupStages,
      ...(filter.minRating !== undefined
        ? [{ $match: { averageRating: { $gte: filter.minRating } } }]
        : []),
      {
        $addFields: {
          averageRatingSortValue: { $ifNull: ["$averageRating", -1] },
          startingPriceSortValue: { $ifNull: ["$startingPriceCents", Number.MAX_SAFE_INTEGER] },
          // Checked against `cheapestService`'s own array size (present or absent, never
          // ambiguous) rather than `$eq` against the derived `startingPriceCents` field — a
          // MISSING field is not reliably `$eq` to a literal `null` in aggregation expressions,
          // which silently broke this check when first written (caught by the "nulls last on
          // both price sort directions" integration test).
          hasNoStartingPrice: { $cond: [{ $eq: [{ $size: "$cheapestService" }, 0] }, 1, 0] },
        },
      },
      {
        $facet: {
          data: [
            { $sort: sortStageFor(sort) },
            { $skip: skip },
            { $limit: pagination.limit },
            { $project: cardProjection },
          ],
          totalCount: [{ $count: "count" }],
        },
      },
    ];

    const [result] = await BusinessModel.aggregate<{
      data: RawAggregateRow[];
      totalCount: Array<{ count: number }>;
    }>(pipeline).exec();

    return {
      rows: (result?.data ?? []).map(toAggregateRow),
      total: result?.totalCount[0]?.count ?? 0,
    };
  }

  /** Favorites-list enrichment — the SAME rating/price lookup logic as `search`, but matched by
   * an explicit id set (any status, not just publicly-visible — see `isAvailable` on the DTO) and
   * with no pagination/sort of its own: the caller (FavoriteRepository.listByCustomer) already
   * paginated by favorited-at order, this only hydrates that exact page's cards. Order is NOT
   * guaranteed by `$in` — the caller re-orders by its own id list. */
  public async getCardsByIds(businessIds: Types.ObjectId[]): Promise<DiscoveryAggregateRow[]> {
    if (businessIds.length === 0) {
      return [];
    }

    const pipeline: PipelineStage[] = [
      { $match: { _id: { $in: businessIds } } },
      ...ratingAndPriceLookupStages,
      { $project: cardProjection },
    ];

    const rows = await BusinessModel.aggregate<RawAggregateRow>(pipeline).exec();
    return rows.map(toAggregateRow);
  }

  // --- Batch 17: homepage discovery sections -------------------------------------------------
  //
  // Three genuinely different rankings over the SAME publicly-visible set (APPROVED/WARNING).
  // Each is ONE aggregation: the shared rating/cheapest-price lookups, then a section-specific
  // score, then a fully-deterministic sort (every tie broken down to `_id`), then the same
  // `cardProjection` Explore returns. Cover-photo signing stays a batched follow-up in the
  // service, exactly like `search`.

  /** "Recommended". `affinity` (a logged-in Customer's really-booked categories/cities) tiers
   * the results — category match outranks city match — with quality ordering inside each tier.
   * Empty affinity (logged-out / no history) collapses to pure quality, optionally narrowed to
   * a real `contextCategories` list. Never reads a stored recommendation/score. */
  public async rankRecommended(
    params: HomeRankParams & {
      affinity: CustomerAffinity;
      contextCategories?: string[] | undefined;
    },
  ): Promise<DiscoveryAggregateRow[]> {
    const match = homeVisibilityMatch(params.excludeIds);
    if (params.contextCategories && params.contextCategories.length > 0) {
      match["category"] = { $in: params.contextCategories };
    }

    const pipeline: PipelineStage[] = [
      { $match: match },
      ...ratingAndPriceLookupStages,
      homeSortFieldsStage,
      {
        $addFields: {
          affinityRank: {
            $add: [
              {
                $cond: [
                  { $in: ["$category", params.affinity.categories] },
                  HOME_RECOMMENDED_AFFINITY_CATEGORY_RANK,
                  0,
                ],
              },
              {
                $cond: [
                  { $in: ["$address.city", params.affinity.cities] },
                  HOME_RECOMMENDED_AFFINITY_CITY_RANK,
                  0,
                ],
              },
            ],
          },
        },
      },
      {
        $sort: {
          affinityRank: -1,
          qualityScore: -1,
          reviewCountSortValue: -1,
          averageRatingSortValue: -1,
          _id: 1,
        },
      },
      { $limit: params.limit },
      { $project: cardProjection },
    ];

    const rows = await BusinessModel.aggregate<RawAggregateRow>(pipeline).exec();
    return rows.map(toAggregateRow);
  }

  /** "Services near you". `city` is the hero-search city the visitor picked — the only real
   * geographic signal the product has. With a city it is a hard filter (quality-ordered
   * within). With no city it falls back to "can serve you anywhere": TRAVEL_TO_CUSTOMER
   * Businesses first, then quality. No coordinates, no distance — ever. */
  public async rankNearYou(
    params: HomeRankParams & { city?: BusinessCity | undefined },
  ): Promise<DiscoveryAggregateRow[]> {
    const match = homeVisibilityMatch(params.excludeIds);
    if (params.city) {
      match["address.city"] = params.city;
    }
    const travelFirst = !params.city;

    const pipeline: PipelineStage[] = [
      { $match: match },
      ...ratingAndPriceLookupStages,
      homeSortFieldsStage,
      ...(travelFirst
        ? [
            {
              $addFields: {
                travelRank: {
                  $cond: [{ $eq: ["$visitType", "TRAVEL_TO_CUSTOMER"] }, 0, 1],
                },
              },
            } satisfies PipelineStage,
          ]
        : []),
      {
        $sort: {
          ...(travelFirst ? { travelRank: 1 } : {}),
          qualityScore: -1,
          reviewCountSortValue: -1,
          averageRatingSortValue: -1,
          _id: 1,
        },
      },
      { $limit: params.limit },
      { $project: cardProjection },
    ];

    const rows = await BusinessModel.aggregate<RawAggregateRow>(pipeline).exec();
    return rows.map(toAggregateRow);
  }

  /** "Popular" — `completedBookings*3 + favorites*2 + publishedReviewCount`. Every term is a
   * live COUNT resolved here, never a stored `popularityScore`/`viewCount`/seeded rank. A
   * Business with no activity at all scores 0 and falls to a deterministic `_id` tail. */
  public async rankByPopularity(params: HomeRankParams): Promise<DiscoveryAggregateRow[]> {
    const pipeline: PipelineStage[] = [
      { $match: homeVisibilityMatch(params.excludeIds) },
      ...ratingAndPriceLookupStages,
      homeSortFieldsStage,
      {
        $lookup: {
          from: "bookings",
          let: { businessId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$businessId", "$$businessId"] },
                status: { $in: [...homeSectionBookingPopularityStatuses] },
              },
            },
            { $count: "count" },
          ],
          as: "completedBookingAgg",
        },
      },
      {
        $lookup: {
          from: "favorites",
          let: { businessId: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$businessId", "$$businessId"] } } },
            { $count: "count" },
          ],
          as: "favoriteAgg",
        },
      },
      {
        $addFields: {
          completedBookings: {
            $ifNull: [{ $arrayElemAt: ["$completedBookingAgg.count", 0] }, 0],
          },
          favoritesCount: { $ifNull: [{ $arrayElemAt: ["$favoriteAgg.count", 0] }, 0] },
        },
      },
      {
        $addFields: {
          popularityScore: {
            $add: [
              { $multiply: ["$completedBookings", HOME_POPULAR_WEIGHT_COMPLETED_BOOKING] },
              { $multiply: ["$favoritesCount", HOME_POPULAR_WEIGHT_FAVORITE] },
              { $multiply: ["$reviewCountSortValue", HOME_POPULAR_WEIGHT_REVIEW] },
            ],
          },
        },
      },
      {
        $sort: {
          popularityScore: -1,
          completedBookings: -1,
          favoritesCount: -1,
          reviewCountSortValue: -1,
          averageRatingSortValue: -1,
          _id: 1,
        },
      },
      { $limit: params.limit },
      { $project: cardProjection },
    ];

    const rows = await BusinessModel.aggregate<RawAggregateRow>(pipeline).exec();
    return rows.map(toAggregateRow);
  }

  /** The real personalization signal for "Recommended": the DISTINCT `category` / `address.city`
   * of the Businesses this Customer has actually booked (any Booking status — a cancelled
   * booking still expresses interest), capped to their most recent bookings. Empty for a
   * Customer who has never booked. */
  public async getCustomerAffinity(customerUserId: Types.ObjectId): Promise<CustomerAffinity> {
    const [row] = await BookingModel.aggregate<{ categories: string[]; cities: string[] }>([
      { $match: { "customer.customerUserId": customerUserId } },
      { $sort: { createdAt: -1 } },
      { $limit: HOME_RECOMMENDED_AFFINITY_BOOKING_SAMPLE },
      {
        $lookup: {
          from: "businesses",
          localField: "businessId",
          foreignField: "_id",
          as: "business",
        },
      },
      { $unwind: "$business" },
      {
        $group: {
          _id: null,
          categories: { $addToSet: "$business.category" },
          cities: { $addToSet: "$business.address.city" },
        },
      },
    ]).exec();

    return {
      categories: row?.categories ?? [],
      cities: ((row?.cities ?? []) as BusinessCity[]).filter((c) =>
        (businessCities as readonly string[]).includes(c),
      ),
    };
  }

  /** Public landing "Trusted by local businesses across Cyprus" — founding partners that are
   * ALSO publicly visible (same `PUBLICLY_VISIBLE_STATUSES` as Explore). Filtered + projected at
   * the DB level via the `{isFoundingPartner:1, status:1}` index; returns only the public-safe
   * fields the landing card renders (id/name/city). Cover-photo signing is a separate batched
   * step in the service, exactly like `search`. */
  public async listFoundingPartners(): Promise<FoundingPartnerRow[]> {
    return BusinessModel.find(
      { isFoundingPartner: true, status: { $in: PUBLICLY_VISIBLE_STATUSES } },
      { _id: 1, name: 1, "address.city": 1 },
    )
      .sort({ name: 1 })
      .lean<FoundingPartnerRow[]>()
      .exec();
  }

  /** Category filter options — derived from the DISTINCT category strings actually present on
   * currently-visible Businesses (confirmed product decision: no invented taxonomy). */
  public async listDistinctCategories(): Promise<string[]> {
    const categories = await BusinessModel.distinct("category", {
      status: { $in: PUBLICLY_VISIBLE_STATUSES },
    }).exec();
    return (categories as string[])
      .map((c) => c.trim())
      .filter((c) => c.length > 0)
      .sort((a, b) => a.localeCompare(b));
  }
}
