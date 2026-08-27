import type { Types } from "mongoose";
import type { BusinessCity } from "../business/business.types.js";
import type { BusinessMediaRepository } from "../business-media/business-media.repository.js";
import type { StorageService } from "../storage/storage.service.js";
import type {
  DiscoveryBusinessCardDto,
  DiscoveryListResult,
  FoundingPartnerCardDto,
  HomeSectionsResultDto,
} from "./discovery.dto.js";
import type {
  DiscoveryAggregateRow,
  DiscoveryFilter,
  DiscoveryPagination,
  DiscoveryRepository,
} from "./discovery.repository.js";
import type { DiscoverySortOption } from "./discovery.types.js";

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
  ) {}

  public async search(
    filter: DiscoveryFilter,
    sort: DiscoverySortOption,
    pagination: DiscoveryPagination,
  ): Promise<DiscoveryListResult> {
    const { rows, total } = await this.discoveryRepository.search(filter, sort, pagination);
    const businesses = await this.rowsToCards(rows);
    return { businesses, pagination: { page: pagination.page, limit: pagination.limit, total } };
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

    const recommendedRows = await this.discoveryRepository.rankRecommended({
      affinity,
      // A logged-out category context only narrows when we have nothing personal to go on.
      contextCategories: personalized ? undefined : params.contextCategories,
      excludeIds: [],
      limit,
    });

    const nearYouRows = await this.fillSection(recommendedRows, limit, (excludeIds, take) =>
      this.discoveryRepository.rankNearYou({ city: params.city, excludeIds, limit: take }),
    );

    const popularRows = await this.fillSection(
      [...recommendedRows, ...nearYouRows],
      limit,
      (excludeIds, take) => this.discoveryRepository.rankByPopularity({ excludeIds, limit: take }),
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
    };
  }

  private async rowsToCards(rows: DiscoveryAggregateRow[]): Promise<DiscoveryBusinessCardDto[]> {
    const imageUrlByBusinessId = await this.imageUrlByBusinessId(rows);
    return rows.map((row) => this.toCard(row, imageUrlByBusinessId));
  }
}
