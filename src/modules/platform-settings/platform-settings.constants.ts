import {
  DEPOSIT_MAX_CENTS,
  DEPOSIT_MIN_CENTS,
  DEPOSIT_PERCENT,
  NO_SHOW_RESOLUTION_WINDOW_MINUTES,
} from "../booking/booking.types.js";
import {
  CANCELLATION_PERCENTAGE_MAX,
  CANCELLATION_PERCENTAGE_MIN,
  cancellationTiers,
} from "../business-cancellation-policy/business-cancellation-policy.model.js";
import {
  BUSINESS_CATEGORY_LABELS,
  type BusinessCategoryKey,
  businessCategoryKeys,
} from "./business-category.js";

/**
 * Product default: the number of service lines a single booking may contain. Super Admin
 * editable (PlatformSettings.maxServicesPerBooking). Confirmed default for this phase = 5.
 */
export const DEFAULT_MAX_SERVICES_PER_BOOKING = 5;

/**
 * Technical / abuse ceiling — NOT the product rule. The Zod structural schema
 * (booking.schema.ts `serviceLines.max(...)`) keeps rejecting anything above this regardless
 * of the (lower) configured product limit; the configured limit is enforced separately at the
 * service layer. Kept intentionally distinct so raising the product limit later never means
 * touching the structural guard, and vice-versa.
 */
export const STRUCTURAL_MAX_SERVICES_PER_BOOKING = 20;

export const MIN_MAX_SERVICES_PER_BOOKING = 1;

export type NoShowCategoryWindow = {
  categoryKey: BusinessCategoryKey;
  opensAfterMinutes: number;
  closesAfterMinutes: number;
};

/**
 * Initial editable defaults for the per-category no-show eligibility window. The 90-minute
 * no-show RESOLUTION timer is global (NO_SHOW_RESOLUTION_WINDOW_MINUTES) and is deliberately
 * NOT stored per row.
 */
export const DEFAULT_NO_SHOW_CATEGORY_WINDOWS: NoShowCategoryWindow[] = [
  { categoryKey: "BEAUTY_WELLNESS", opensAfterMinutes: 15, closesAfterMinutes: 120 },
  { categoryKey: "HEALTH_FITNESS", opensAfterMinutes: 15, closesAfterMinutes: 120 },
  { categoryKey: "SPORTS_ACTIVITIES", opensAfterMinutes: 15, closesAfterMinutes: 120 },
  { categoryKey: "AUTOMOTIVE", opensAfterMinutes: 15, closesAfterMinutes: 180 },
  { categoryKey: "PETS_HOME", opensAfterMinutes: 15, closesAfterMinutes: 45 },
  { categoryKey: "EXPERIENCES_TOURS", opensAfterMinutes: 15, closesAfterMinutes: 360 },
  { categoryKey: "ENTERTAINMENT_EVENTS", opensAfterMinutes: 15, closesAfterMinutes: 1440 },
  { categoryKey: "CREATIVE_EDUCATION", opensAfterMinutes: 15, closesAfterMinutes: 120 },
];

export const defaultNoShowWindowFor = (categoryKey: BusinessCategoryKey): NoShowCategoryWindow => {
  const found = DEFAULT_NO_SHOW_CATEGORY_WINDOWS.find((w) => w.categoryKey === categoryKey);
  // DEFAULT_NO_SHOW_CATEGORY_WINDOWS covers every businessCategoryKeys entry; the fallback is
  // defensive only.
  return found ? { ...found } : { categoryKey, opensAfterMinutes: 15, closesAfterMinutes: 120 };
};

/**
 * Fixed, non-editable platform rules — served straight from the canonical backend constants,
 * never persisted in Mongo (the single source of truth stays in code). The Super Admin GET
 * serializes this so the frontend renders real values instead of JSX literals.
 */
export const getFixedPlatformRules = () => ({
  depositPercent: DEPOSIT_PERCENT,
  depositMinCents: DEPOSIT_MIN_CENTS,
  depositMaxCents: DEPOSIT_MAX_CENTS,
  cancellationPercentageMin: CANCELLATION_PERCENTAGE_MIN,
  cancellationPercentageMax: CANCELLATION_PERCENTAGE_MAX,
  noShowResolutionMinutes: NO_SHOW_RESOLUTION_WINDOW_MINUTES,
  cancellationTiers: [...cancellationTiers],
});

export const platformCategoryList = (): Array<{ key: BusinessCategoryKey; label: string }> =>
  businessCategoryKeys.map((key) => ({ key, label: BUSINESS_CATEGORY_LABELS[key] }));
