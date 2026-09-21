import { describe, expect, it } from "vitest";

import { businessCategoryKeys } from "../../src/modules/platform-settings/business-category.js";
import {
  ALL_BUSINESS_TAXONOMY_SUBCATEGORY_KEYS,
  BUSINESS_TAXONOMY,
  findTaxonomyCategory,
  findTaxonomySubcategory,
  getBusinessTaxonomyResponse,
  isValidSubcategoryOfCategory,
  resolveCanonicalCategorySelection,
  resolveLegacySubcategoryLabels,
} from "../../src/modules/platform-settings/business-taxonomy.js";

// The exact product-supplied taxonomy — verbatim labels, verbatim counts. This test
// deliberately hardcodes the target shape so any accidental drift (a renamed/removed/added
// category or subcategory) fails loudly, instead of "correcting" itself silently.
const EXPECTED_CATEGORY_LABELS: Record<string, string> = {
  BEAUTY_WELLNESS: "Beauty & Wellness",
  HEALTH_FITNESS: "Health & Fitness",
  SPORTS_ACTIVITIES: "Sports & Activities",
  EXPERIENCES_TOURS: "Experience & Tours",
  ENTERTAINMENT_EVENTS: "Entertainment & Events",
  CREATIVE_EDUCATION: "Creative & Education",
  PETS_HOME: "Pets & Home",
  AUTOMOTIVE: "Automotive",
  PROFESSIONAL_SERVICES_CONSULTING_COACHING: "Professional Services/ Consulting & Coaching",
};

const EXPECTED_SUBCATEGORY_COUNTS: Record<string, number> = {
  BEAUTY_WELLNESS: 16,
  HEALTH_FITNESS: 12,
  SPORTS_ACTIVITIES: 18,
  EXPERIENCES_TOURS: 11,
  ENTERTAINMENT_EVENTS: 10,
  CREATIVE_EDUCATION: 6,
  PETS_HOME: 8,
  AUTOMOTIVE: 6,
  PROFESSIONAL_SERVICES_CONSULTING_COACHING: 6,
};

describe("BUSINESS_TAXONOMY", () => {
  it("has exactly 9 parent categories", () => {
    expect(BUSINESS_TAXONOMY).toHaveLength(9);
  });

  it("has exactly one entry per businessCategoryKeys (same machine identity, reused)", () => {
    expect(BUSINESS_TAXONOMY.map((c) => c.key).sort()).toEqual([...businessCategoryKeys].sort());
  });

  it("has the exact canonical parent labels, verbatim (no silently corrected spelling)", () => {
    for (const category of BUSINESS_TAXONOMY) {
      expect(category.label).toBe(EXPECTED_CATEGORY_LABELS[category.key]);
    }
  });

  it("has the exact subcategory count per parent", () => {
    for (const category of BUSINESS_TAXONOMY) {
      expect(category.subcategories).toHaveLength(EXPECTED_SUBCATEGORY_COUNTS[category.key]!);
    }
  });

  it("preserves known odd/idiosyncratic labels exactly as supplied", () => {
    expect(findTaxonomySubcategory("BEAUTY_WELLNESS", "BEAUTY_WELLNESS__HAIR_SALOON")?.label).toBe(
      "Hair Saloon",
    );
    expect(
      findTaxonomySubcategory("SPORTS_ACTIVITIES", "SPORTS_ACTIVITIES__GO_KARTING")?.label,
    ).toBe("Go - Karting");
    expect(findTaxonomySubcategory("ENTERTAINMENT_EVENTS", "ENTERTAINMENT_EVENTS__DJ")?.label).toBe(
      "Dj",
    );
    expect(
      findTaxonomySubcategory("ENTERTAINMENT_EVENTS", "ENTERTAINMENT_EVENTS__CURICATURE_ARTIST")
        ?.label,
    ).toBe("Curicature Artist");
  });

  it("has no duplicate category keys", () => {
    const keys = BUSINESS_TAXONOMY.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has no duplicate subcategory keys across the entire taxonomy", () => {
    expect(new Set(ALL_BUSINESS_TAXONOMY_SUBCATEGORY_KEYS).size).toBe(
      ALL_BUSINESS_TAXONOMY_SUBCATEGORY_KEYS.length,
    );
  });

  it("resolves every subcategory key back through findTaxonomySubcategory", () => {
    for (const category of BUSINESS_TAXONOMY) {
      for (const sub of category.subcategories) {
        expect(findTaxonomySubcategory(category.key, sub.key)).toEqual(sub);
      }
    }
  });

  it("total subcategory count matches the product-supplied taxonomy (93)", () => {
    expect(ALL_BUSINESS_TAXONOMY_SUBCATEGORY_KEYS).toHaveLength(93);
  });
});

describe("isValidSubcategoryOfCategory", () => {
  it("accepts a real parent-child pairing", () => {
    expect(isValidSubcategoryOfCategory("BEAUTY_WELLNESS", "BEAUTY_WELLNESS__MASSAGE")).toBe(true);
  });

  it("rejects a subcategory that belongs to a different parent (the integrity gap the audit found)", () => {
    expect(isValidSubcategoryOfCategory("AUTOMOTIVE", "BEAUTY_WELLNESS__MASSAGE")).toBe(false);
  });

  it("rejects an unknown category key", () => {
    expect(isValidSubcategoryOfCategory("NOT_A_CATEGORY", "BEAUTY_WELLNESS__MASSAGE")).toBe(false);
  });

  it("rejects an unknown subcategory key", () => {
    expect(isValidSubcategoryOfCategory("BEAUTY_WELLNESS", "NOT_A_SUBCATEGORY")).toBe(false);
  });
});

describe("resolveCanonicalCategorySelection", () => {
  it("derives canonical labels from validated keys", () => {
    const resolved = resolveCanonicalCategorySelection({
      categoryKey: "AUTOMOTIVE",
      subcategoryKeys: ["AUTOMOTIVE__CAR_DETAILING", "AUTOMOTIVE__CAR_WASH"],
    });
    expect(resolved).toEqual({
      categoryKey: "AUTOMOTIVE",
      categoryLabel: "Automotive",
      subcategoryKeys: ["AUTOMOTIVE__CAR_DETAILING", "AUTOMOTIVE__CAR_WASH"],
      subcategoryLabels: ["Car Detailing", "Car Wash"],
    });
  });

  it("throws on an unknown category key rather than guessing", () => {
    expect(() =>
      resolveCanonicalCategorySelection({ categoryKey: "NOPE", subcategoryKeys: [] }),
    ).toThrow();
  });

  it("throws on a subcategory that does not belong to the given category", () => {
    expect(() =>
      resolveCanonicalCategorySelection({
        categoryKey: "AUTOMOTIVE",
        subcategoryKeys: ["BEAUTY_WELLNESS__MASSAGE"],
      }),
    ).toThrow();
  });
});

describe("resolveLegacySubcategoryLabels (Phase 14 legacy-draft compatibility)", () => {
  it("returns an empty array for old pseudo-subcategories (parent-category names reused)", () => {
    // This is the exact old broken behavior the audit found: "subcategories" were really just
    // other top-level category names. None of those ever validly match a real child label.
    expect(
      resolveLegacySubcategoryLabels("BEAUTY_WELLNESS", ["Automotive", "Pets & Home"]),
    ).toEqual([]);
  });

  it("matches a legacy subcategory label that happens to exactly equal a real child, case-insensitively", () => {
    expect(resolveLegacySubcategoryLabels("BEAUTY_WELLNESS", ["spa", "Massage"])).toEqual([
      { key: "BEAUTY_WELLNESS__SPA", label: "Spa" },
      { key: "BEAUTY_WELLNESS__MASSAGE", label: "Massage" },
    ]);
  });

  it("returns an empty array for an unknown category key", () => {
    expect(resolveLegacySubcategoryLabels("NOT_A_CATEGORY", ["Spa"])).toEqual([]);
  });
});

describe("getBusinessTaxonomyResponse", () => {
  it("returns plain serializable data shaped for the GET endpoint", () => {
    const response = getBusinessTaxonomyResponse();
    expect(response).toHaveLength(9);
    expect(response[0]).toEqual({
      key: expect.any(String),
      label: expect.any(String),
      subcategories: expect.any(Array),
    });
    // Not `as const` tuples — a plain mutable array/object, safe to JSON-serialize as-is.
    expect(Array.isArray(response)).toBe(true);
  });

  it("finds a known category and rejects an unknown one", () => {
    expect(findTaxonomyCategory("BEAUTY_WELLNESS")?.label).toBe("Beauty & Wellness");
    expect(findTaxonomyCategory("NOT_A_CATEGORY")).toBeUndefined();
  });
});
