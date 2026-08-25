import type { PipelineStage, Types } from "mongoose";

import { BusinessModel } from "../business/business.model.js";
import type { BusinessCity, BusinessVisitType } from "../business/business.types.js";
import type { ServicePricingMode } from "../services/service.types.js";
import type { DiscoverySortOption } from "./discovery.types.js";

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
