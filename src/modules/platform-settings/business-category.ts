/**
 * Canonical business-category identity for platform business rules (this phase).
 *
 * The 8 keys below are the STABLE machine identity used by every business-rule lookup
 * (currently: the no-show eligibility window). The human labels are display-only and must
 * never be used as a lookup key. The list is expected to change in a future phase — callers
 * depend on `businessCategoryKeys` / `resolveBusinessCategoryKey`, never on hard-coded strings.
 *
 * `Business.category` historically stores a free-form display string (see business.model.ts).
 * `resolveBusinessCategoryKey` is the compatibility layer: it maps known historical / form
 * label variations (case, `&` vs `and`, singular/plural, spacing) onto a canonical key, or
 * returns `null` when it cannot safely decide — callers then fall back to legacy behavior
 * rather than guessing (see BookingCreationService.resolveNoShowEligibilitySnapshot).
 */

export const businessCategoryKeys = [
  "BEAUTY_WELLNESS",
  "HEALTH_FITNESS",
  "SPORTS_ACTIVITIES",
  "AUTOMOTIVE",
  "PETS_HOME",
  "EXPERIENCES_TOURS",
  "ENTERTAINMENT_EVENTS",
  "CREATIVE_EDUCATION",
] as const;

export type BusinessCategoryKey = (typeof businessCategoryKeys)[number];

export const BUSINESS_CATEGORY_LABELS: Record<BusinessCategoryKey, string> = {
  BEAUTY_WELLNESS: "Beauty & Wellness",
  HEALTH_FITNESS: "Health & Fitness",
  SPORTS_ACTIVITIES: "Sports & Activities",
  AUTOMOTIVE: "Automotive",
  PETS_HOME: "Pets & Home",
  EXPERIENCES_TOURS: "Experiences & Tours",
  ENTERTAINMENT_EVENTS: "Entertainment & Events",
  CREATIVE_EDUCATION: "Creative & Education",
};

/** lowercase, `&` -> `and`, every run of non-alphanumerics -> single space, trimmed. */
const normalize = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

/**
 * Known aliases keyed by their normalized form. Built from: the 8 canonical labels, the
 * professional business-form list (frontend/src/app/professional/business-form/page.tsx —
 * singular "Experience & Tours"), the list-your-business page, and real stored data
 * (a live read of `businesses.category` at implementation time returned exactly
 * `"HEALTH & FITNESS"`). Anything not here resolves to `null`.
 */
const ALIASES: Record<string, BusinessCategoryKey> = {
  "beauty and wellness": "BEAUTY_WELLNESS",
  "beauty wellness": "BEAUTY_WELLNESS",
  "health and fitness": "HEALTH_FITNESS",
  "health fitness": "HEALTH_FITNESS",
  "sports and activities": "SPORTS_ACTIVITIES",
  "sport and activities": "SPORTS_ACTIVITIES",
  "sports activities": "SPORTS_ACTIVITIES",
  automotive: "AUTOMOTIVE",
  "pets and home": "PETS_HOME",
  "pet and home": "PETS_HOME",
  "pets home": "PETS_HOME",
  "experiences and tours": "EXPERIENCES_TOURS",
  "experience and tours": "EXPERIENCES_TOURS",
  "experiences tours": "EXPERIENCES_TOURS",
  "experience tours": "EXPERIENCES_TOURS",
  "entertainment and events": "ENTERTAINMENT_EVENTS",
  "entertainment events": "ENTERTAINMENT_EVENTS",
  "creative and education": "CREATIVE_EDUCATION",
  "creative education": "CREATIVE_EDUCATION",
};

const CANONICAL_KEY_SET = new Set<string>(businessCategoryKeys);

/**
 * Resolve a stored/display category string to a canonical key, or `null` when it cannot be
 * safely mapped. Also accepts an already-canonical key verbatim.
 */
export const resolveBusinessCategoryKey = (
  raw: string | null | undefined,
): BusinessCategoryKey | null => {
  if (!raw) {
    return null;
  }

  const asKey = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
  if (CANONICAL_KEY_SET.has(asKey)) {
    return asKey as BusinessCategoryKey;
  }

  const normalized = normalize(raw);
  return ALIASES[normalized] ?? null;
};
