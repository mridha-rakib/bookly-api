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

/**
 * Batch 17 — the homepage's three discovery rows in one response (one HTTP round trip, one
 * batched media lookup for all three). Each array is already ranked and de-duplicated against
 * the ones above it; see discovery.types.ts for the exact ranking of each. Card shape is the
 * SAME `DiscoveryBusinessCardDto` Explore uses — no distance field, because the product stores
 * no visitor coordinates and none is fabricated.
 */
export type HomeSectionsResultDto = {
  recommended: DiscoveryBusinessCardDto[];
  nearYou: DiscoveryBusinessCardDto[];
  popular: DiscoveryBusinessCardDto[];
  meta: {
    /** true only when a logged-in Customer's real booking history shaped `recommended`. */
    personalized: boolean;
    /** The hero-search city that drove `nearYou`, echoed back; null when none was supplied. */
    nearYouCity: BusinessCity | null;
  };
};

/** Public landing "Trusted by local businesses" card — only the fields that section renders.
 * No owner/contact/status/finance data is ever included. `imageUrl` is undefined when the
 * Business has no stored cover photo (the frontend falls back to its own placeholder — a logo is
 * never fabricated). */
export type FoundingPartnerCardDto = {
  id: string;
  name: string;
  city: BusinessCity;
  imageUrl?: string | undefined;
};
