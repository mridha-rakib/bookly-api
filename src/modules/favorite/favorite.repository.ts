import type { Types } from "mongoose";
import { type FavoriteDocument, FavoriteModel } from "./favorite.model.js";

export type FavoritePagination = { page: number; limit: number };

export class FavoriteRepository {
  /** Idempotent: a second `add` for the same (customerUserId, businessId) pair returns the
   * EXISTING row rather than erroring — relies entirely on the unique compound index (never a
   * read-then-write existence check), matching this codebase's established
   * generate-then-catch-E11000 convention. */
  public async add(
    customerUserId: Types.ObjectId,
    businessId: Types.ObjectId,
  ): Promise<FavoriteDocument> {
    try {
      return await new FavoriteModel({ customerUserId, businessId }).save();
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        const existing = await FavoriteModel.findOne({ customerUserId, businessId }).exec();
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
  }

  /** Idempotent: removing a Favorite that doesn't exist (already removed, or never existed) is
   * a silent no-op — never an error — matching "safe toggle behavior" (confirmed rule). */
  public async remove(customerUserId: Types.ObjectId, businessId: Types.ObjectId): Promise<void> {
    await FavoriteModel.deleteOne({ customerUserId, businessId }).exec();
  }

  public async isFavorite(
    customerUserId: Types.ObjectId,
    businessId: Types.ObjectId,
  ): Promise<boolean> {
    const found = await FavoriteModel.exists({ customerUserId, businessId }).exec();
    return found !== null;
  }

  /** Every businessId the Customer has favorited — unbounded by count is acceptable here (this
   * mirrors the confirmed UI need: know which of the CURRENT page's cards should render a filled
   * heart), never a full favorited-business-DETAIL list (see `listByCustomer` for that, which IS
   * paginated). */
  public async listBusinessIdsByCustomer(
    customerUserId: Types.ObjectId,
  ): Promise<Types.ObjectId[]> {
    const rows = await FavoriteModel.find({ customerUserId }, { businessId: 1 }).exec();
    return rows.map((row) => row.businessId);
  }

  public async listByCustomer(
    customerUserId: Types.ObjectId,
    pagination: FavoritePagination,
  ): Promise<{ favorites: FavoriteDocument[]; total: number }> {
    const filter = { customerUserId };
    const skip = (pagination.page - 1) * pagination.limit;
    const [favorites, total] = await Promise.all([
      FavoriteModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pagination.limit).exec(),
      FavoriteModel.countDocuments(filter).exec(),
    ]);
    return { favorites, total };
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: number }).code === 11000
    );
  }
}
