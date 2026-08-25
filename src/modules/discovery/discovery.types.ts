/**
 * Batch 16 — Explore/Discovery. Scope is deliberately narrow to what the existing Explore page's
 * own UI has real evidence for (confirmed via investigation + explicit product answers):
 *
 *   - Search: Business name only (the existing search box's own filtering behavior).
 *   - Filters: city (real enum), visitType ("We came to you" toggle — real field), category
 *     (derived from the DISTINCT category strings actually present on visible Businesses — no
 *     invented taxonomy), minRating (real, backed by Batch 14's PUBLISHED-only Review aggregate).
 *   - Sort: exactly the four literal options the existing sort dropdown already offers.
 *
 * Deliberately NOT built in this batch (confirmed by the product owner): Recommended/Trending/
 * Popular ranking (no formula existed or was defined), distance/"near you" (no customer location
 * exists anywhere in the product), availability filter (would require an expensive per-card
 * per-service query with no defined aggregate meaning). These remain exactly as inert as they
 * already were — not removed, not faked.
 */

export const discoverySortOptions = [
  "mostRelevant",
  "ratingHighToLow",
  "priceLowToHigh",
  "priceHighToLow",
] as const;
export type DiscoverySortOption = (typeof discoverySortOptions)[number];

export const DISCOVERY_SEARCH_MAX_LENGTH = 100;
