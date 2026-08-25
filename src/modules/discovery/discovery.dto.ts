import type { BusinessCity, BusinessVisitType } from "../business/business.types.js";
import type { ServicePricingMode } from "../services/service.types.js";

/** The Explore card DTO — only what the existing `Recommendation`-shaped card actually displays
 * (confirmed by investigation), never a raw Business/Service document. No distance, no
 * availability text, no Recommended/Trending/Popular flag — none of those have a real backing
 * (see discovery.types.ts). */
export type DiscoveryBusinessCardDto = {
  id: string;
  name: string;
  category: string;
  subcategories: string[];
  city: BusinessCity;
  visitType: BusinessVisitType;
  averageRating: number | null;
  reviewCount: number;
  /** null when the Business has no ACTIVE, non-package Service at all — never a fabricated
   * price. */
  startingPriceCents: number | null;
  startingPricingMode: ServicePricingMode | null;
  imageUrl?: string | undefined;
  /** Always `true` for an Explore search result (the query itself only ever returns visible
   * Businesses). Can be `false` for a Favorites-list row — a Favorite relationship is never
   * deleted just because the Business later became PENDING/SUSPENDED (confirmed rule: removing a
   * Favorite must never be an automatic side effect of something else) — the frontend uses this
   * to degrade the card (e.g. disable "View") without pretending it's normally bookable. */
  isAvailable: boolean;
};

export type DiscoveryListResult = {
  businesses: DiscoveryBusinessCardDto[];
  pagination: { page: number; limit: number; total: number };
};
