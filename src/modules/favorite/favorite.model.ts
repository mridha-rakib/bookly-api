import { model, Schema, type Types } from "mongoose";

/**
 * Batch 16 — a Customer's saved Business (confirmed scope: the app has no addressable Service
 * detail view separate from its owning Business — `/venue?id=` only ever resolves a Business —
 * so a "favorite" can only ever coherently point back to a Business). Deliberately minimal: no
 * folders, notes, tags, or sharing (none evidenced, none requested).
 */
export type FavoriteDocument = {
  _id: Types.ObjectId;
  customerUserId: Types.ObjectId;
  businessId: Types.ObjectId;
  createdAt: Date;
};

const favoriteSchema = new Schema<FavoriteDocument>(
  {
    customerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// DB-level duplicate protection — a Customer cannot favorite the same Business twice, enforced
// here (not just at the application layer) so a concurrent double-toggle can never create two
// rows (see favorite.repository.ts's `add`, which treats a resulting E11000 as an idempotent
// no-op success, not an error).
favoriteSchema.index({ customerUserId: 1, businessId: 1 }, { unique: true });
// "My Favorites" list — a Customer's own saved Businesses, newest first.
favoriteSchema.index({ customerUserId: 1, createdAt: -1 });
// Batch 17 — the home "Popular" ranking counts favorites-per-Business (a real engagement
// signal); this keeps that correlated aggregation lookup off a collection scan.
favoriteSchema.index({ businessId: 1 });

export const FavoriteModel = model<FavoriteDocument>("Favorite", favoriteSchema);
