import type { Types } from "mongoose";
import type { BusinessMediaRepository } from "../business-media/business-media.repository.js";
import type { StorageService } from "../storage/storage.service.js";
import type { DiscoveryBusinessCardDto, DiscoveryListResult } from "./discovery.dto.js";
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

  private async rowsToCards(rows: DiscoveryAggregateRow[]): Promise<DiscoveryBusinessCardDto[]> {
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
    }));
  }
}
