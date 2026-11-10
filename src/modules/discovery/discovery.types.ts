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

/**
 * Batch 17 — the homepage's three discovery rows (Recommended / Services near you / Popular),
 * now real. Each is a genuinely different ranking over the SAME public-visibility set Explore
 * uses (APPROVED/WARNING only):
 *
 *   - Recommended: relevance/quality. For a logged-in Customer with booking history it is
 *     tiered by affinity — Businesses whose `category` and/or `address.city` the Customer has
 *     actually booked before rank first (category match outweighs city match), quality-ordered
 *     within each tier. With no history (logged-out, or a Customer who has never booked) it
 *     falls back to pure quality, optionally narrowed to a real category context. "Quality" is
 *     `avg(PUBLISHED review rating) * log10(reviewCount + 1)` — never a stored score.
 *   - Services near you: proximity by the ONE real geographic signal the product has — the
 *     city the visitor picked in the hero search bar (`Business.address.city`). No coordinates
 *     and no distance are ever computed or displayed (the product stores no visitor location).
 *     With no city picked it falls back to "can serve you anywhere" — TRAVEL_TO_CUSTOMER
 *     Businesses first — then quality.
 *   - Popular: real platform activity only —
 *     `completedBookings*3 + favorites*2 + publishedReviewCount`. Every input is a live count;
 *     nothing is seeded. A brand-new platform with no activity yields a deterministic _id order
 *     (honest "nothing is popular yet"), never a fabricated ranking.
 *
 * De-duplication: the sections are built in the order above, each excluding Businesses already
 * shown; only if a section would otherwise be short does it deterministically backfill with
 * already-shown Businesses (never randomised).
 */
export const homeSectionBookingPopularityStatuses = ["COMPLETED"] as const;

/** Weights for the Popular score — all three inputs are real, live counts. */
export const HOME_POPULAR_WEIGHT_COMPLETED_BOOKING = 3;
export const HOME_POPULAR_WEIGHT_FAVORITE = 2;
export const HOME_POPULAR_WEIGHT_REVIEW = 1;

/** Recommended affinity tiers (higher = ranked first). Category match dominates city match. */
export const HOME_RECOMMENDED_AFFINITY_CATEGORY_RANK = 2;
export const HOME_RECOMMENDED_AFFINITY_CITY_RANK = 1;

/** How many of the Customer's most recent Bookings feed the affinity signal. */
export const HOME_RECOMMENDED_AFFINITY_BOOKING_SAMPLE = 50;

export const HOME_SECTION_DEFAULT_LIMIT = 6;
export const HOME_SECTION_MAX_LIMIT = 12;

export const discoverySortOptions = [
  "mostRelevant",
  "ratingHighToLow",
  "priceLowToHigh",
  "priceHighToLow",
  // P2.2.3 — Explore quick actions / location sort (see DiscoveryRepository.search).
  "recommended",
  "trending",
  "distance",
] as const;
export type DiscoverySortOption = (typeof discoverySortOptions)[number];

export const DISCOVERY_SEARCH_MAX_LENGTH = 100;

// --- P2.2.3: Explore Recommended / Trending / distance / availability ----------------------------

/** Trending = confirmed Booking activity: Bookings CREATED in the last N Cyprus calendar days
 * (today included) whose current status is one of these. PENDING (not yet confirmed), every
 * cancellation and every no-show outcome are excluded. */
export const DISCOVERY_TRENDING_WINDOW_DAYS = 30;
export const discoveryTrendingBookingStatuses = ["UPCOMING", "COMPLETED"] as const;

/** Straight-line (great-circle) distance in kilometres; mean Earth radius (IUGG). */
export const DISCOVERY_EARTH_RADIUS_KM = 6371.0088;
export const DISCOVERY_MIN_RADIUS_KM = 1;
export const DISCOVERY_MAX_RADIUS_KM = 200;

/** Availability filter bounds: one Business-local date, a bounded candidate set (best matches of
 * the other filters/sort first), a bounded number of Services per Business and bounded
 * concurrency against the AvailabilityService. */
export const DISCOVERY_AVAILABILITY_CANDIDATE_LIMIT = 60;
export const DISCOVERY_AVAILABILITY_SERVICE_LIMIT = 8;
export const DISCOVERY_AVAILABILITY_CONCURRENCY = 6;
export const DISCOVERY_AVAILABILITY_MAX_DAYS_AHEAD = 180;

/** Time windows on the Business's own local clock: [start, end) "HH:mm". */
export const discoveryAvailabilityWindows = {
  ANY: { start: "00:00", end: "24:00" },
  MORNING: { start: "06:00", end: "12:00" },
  AFTERNOON: { start: "12:00", end: "17:00" },
  EVENING: { start: "17:00", end: "24:00" },
} as const;
export type DiscoveryAvailabilityWindow = keyof typeof discoveryAvailabilityWindows;
export const discoveryAvailabilityWindowKeys = Object.keys(
  discoveryAvailabilityWindows,
) as DiscoveryAvailabilityWindow[];
