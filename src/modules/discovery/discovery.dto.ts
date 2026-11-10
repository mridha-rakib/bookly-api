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
  /** Real persisted `Business.location`, never fabricated/geocoded here — undefined when the
   * Business has no valid stored coordinate. Frontend must not invent a marker position when
   * this is absent. */
  location?: { lat: number; lng: number } | undefined;
  /** Always `true` for an Explore search result (the query itself only ever returns visible
   * Businesses). Can be `false` for a Favorites-list row — a Favorite relationship is never
   * deleted just because the Business later became PENDING/SUSPENDED (confirmed rule: removing a
   * Favorite must never be an automatic side effect of something else) — the frontend uses this
   * to degrade the card (e.g. disable "View") without pretending it's normally bookable. */
  isAvailable: boolean;
  /** P2.2.3 — straight-line km from the visitor-supplied origin to this Business's stored
   * location (one decimal). Only present when an origin was sent and a location is stored. */
  distanceKm?: number | undefined;
  /** P2.2.3 — present only under the availability filter: the earliest bookable start found by
   * the AvailabilityService for the chosen date/window, and the Service it belongs to. A
   * discovery-time indication only; booking still runs final admission. */
  availability?: { serviceId: string; serviceName: string; firstSlotStartAt: string } | undefined;
};

/** P2.2.3 — how the result set was produced, so the client can label it truthfully. */
export type DiscoveryListMeta = {
  sort: string;
  /** `sort=recommended`: true when ranked by the signed-in Customer's own booking history. */
  personalized?: boolean | undefined;
  trending?: { from: string; to: string; timezone: string; statuses: string[] } | undefined;
  distance?:
    | { unit: "km"; measure: "STRAIGHT_LINE_TO_BUSINESS_LOCATION"; radiusKm: number | null }
    | undefined;
  availability?:
    | {
        date: string;
        window: string;
        serviceQuery: string | null;
        candidatesChecked: number;
        /** More Businesses matched the other filters than were checked (best-ranked first). */
        candidateLimitReached: boolean;
        /** Mobile (travel-to-customer) Businesses skipped because exactly one city is needed to
         * check where they travel. */
        travelBusinessesNeedCity: number;
      }
    | undefined;
};

export type DiscoveryListResult = {
  businesses: DiscoveryBusinessCardDto[];
  pagination: { page: number; limit: number; total: number };
  meta?: DiscoveryListMeta | undefined;
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
