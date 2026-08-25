import { Types } from "mongoose";

import type { BusinessRepository } from "../business/business.repository.js";
import type { DiscoveryBusinessCardDto } from "../discovery/discovery.dto.js";
import type { DiscoveryService } from "../discovery/discovery.service.js";
import { FavoriteError } from "./favorite.errors.js";
import type { FavoriteDocument } from "./favorite.model.js";
import type { FavoritePagination, FavoriteRepository } from "./favorite.repository.js";

export type FavoriteListResult = {
  favorites: DiscoveryBusinessCardDto[];
  pagination: { page: number; limit: number; total: number };
};

/** Batch 16 — a Customer's saved Businesses. `customerUserId` is always taken from the
 * authenticated actor (`req.auth.userId`) by the controller — never accepted as a body/param
 * value (confirmed rule: "Never trust customerUserId from the frontend"). */
export class FavoriteService {
  public constructor(
    private readonly favoriteRepository: FavoriteRepository,
    private readonly businessRepository: BusinessRepository,
    private readonly discoveryService: DiscoveryService,
  ) {}

  public async add(customerUserId: string, businessId: string): Promise<FavoriteDocument> {
    if (!Types.ObjectId.isValid(businessId)) {
      throw new FavoriteError("FAVORITE_BUSINESS_NOT_FOUND", 404);
    }
    const business = await this.businessRepository.findById(businessId);
    if (!business) {
      throw new FavoriteError("FAVORITE_BUSINESS_NOT_FOUND", 404);
    }
    return this.favoriteRepository.add(
      new Types.ObjectId(customerUserId),
      new Types.ObjectId(businessId),
    );
  }

  /** Idempotent — removing a Favorite that isn't there (already removed, never existed, or an
   * invalid id) is a silent success, never an error (matches "safe toggle behavior"). */
  public async remove(customerUserId: string, businessId: string): Promise<void> {
    if (!Types.ObjectId.isValid(businessId)) {
      return;
    }
    await this.favoriteRepository.remove(
      new Types.ObjectId(customerUserId),
      new Types.ObjectId(businessId),
    );
  }

  public async listBusinessIds(customerUserId: string): Promise<string[]> {
    const ids = await this.favoriteRepository.listBusinessIdsByCustomer(
      new Types.ObjectId(customerUserId),
    );
    return ids.map((id) => String(id));
  }

  public async list(
    customerUserId: string,
    pagination: FavoritePagination,
  ): Promise<FavoriteListResult> {
    const { favorites, total } = await this.favoriteRepository.listByCustomer(
      new Types.ObjectId(customerUserId),
      pagination,
    );
    const cards = await this.discoveryService.getCardsByIds(favorites.map((f) => f.businessId));
    return {
      favorites: cards,
      pagination: { page: pagination.page, limit: pagination.limit, total },
    };
  }
}
