import { type BusinessCategoryKey, businessCategoryKeys } from "./business-category.js";

/**
 * THE canonical Business Owner registration category + subcategory taxonomy.
 *
 * This is platform-owned, read-only data (no admin CRUD — see platform-settings.route.ts
 * `GET /platform/business-taxonomy`). It replaces every previously-independent hardcoded
 * category array across the codebase (professional/business-form, the category icon map, the
 * list-your-business marketing page). Display labels are reproduced EXACTLY as supplied by
 * product — including known-odd spelling/spacing ("Hair Saloon", "Go - Karting", "Dj",
 * "Curicature Artist") — never silently corrected here.
 *
 * Parent-category keys are the SAME `BusinessCategoryKey` machine identity already used for
 * platform business rules (`business-category.ts` / no-show eligibility) — reused, not
 * duplicated, per product direction. Subcategory keys are namespaced with their parent key
 * (`<CATEGORY_KEY>__<SUBCATEGORY>`) purely so they are trivially guaranteed globally unique;
 * parent/child membership is still checked structurally below, never by parsing the key string.
 *
 * Keys are fixed literals, chosen by hand — they must never be derived from label text at
 * runtime, so a future label correction never changes stored machine identity.
 */
export const BUSINESS_TAXONOMY = [
  {
    key: "BEAUTY_WELLNESS",
    label: "Beauty & Wellness",
    subcategories: [
      { key: "BEAUTY_WELLNESS__HAIR_REMOVAL", label: "Hair Removal (Waxing & Threadings)" },
      { key: "BEAUTY_WELLNESS__TANNING", label: "Tanning" },
      { key: "BEAUTY_WELLNESS__LASER_ADVANCED_TREATMENTS", label: "Laser & Advanced Treatments" },
      { key: "BEAUTY_WELLNESS__SPA", label: "Spa" },
      { key: "BEAUTY_WELLNESS__MASSAGE", label: "Massage" },
      { key: "BEAUTY_WELLNESS__FACIAL", label: "Facial" },
      { key: "BEAUTY_WELLNESS__NAILS", label: "Nails" },
      { key: "BEAUTY_WELLNESS__EYEBROWS_LASHES", label: "Eyebrows & Lashes" },
      { key: "BEAUTY_WELLNESS__BEAUTY_THERAPIST", label: "Beauty Therapist" },
      { key: "BEAUTY_WELLNESS__HAIR_SALOON", label: "Hair Saloon" },
      { key: "BEAUTY_WELLNESS__BARBER", label: "Barber" },
      { key: "BEAUTY_WELLNESS__AESTHETICS", label: "Aesthetics" },
      { key: "BEAUTY_WELLNESS__MAKEUP_ARTIST", label: "Makeup Artist" },
      { key: "BEAUTY_WELLNESS__TATTOO_PIERCINGS", label: "Tattoo & Piercings" },
      { key: "BEAUTY_WELLNESS__NAIL_TECHNICIAN_MOBILE", label: "Nail Technician (Mobile)" },
      {
        key: "BEAUTY_WELLNESS__MICROBLADING_PERMANENT_MAKEUP",
        label: "Microblading & Permanent Makeup",
      },
    ],
  },
  {
    key: "HEALTH_FITNESS",
    label: "Health & Fitness",
    subcategories: [
      { key: "HEALTH_FITNESS__PHYSIOTHERAPIST", label: "Physiotherapist" },
      { key: "HEALTH_FITNESS__PSYCHOLOGIST_THERAPIST", label: "Psychologist & Therapist" },
      {
        key: "HEALTH_FITNESS__SPEECH_OCCUPATIONAL_THERAPIST",
        label: "Speech & Occupational Therapist",
      },
      { key: "HEALTH_FITNESS__PODIATRIST", label: "Podiatrist" },
      { key: "HEALTH_FITNESS__LIFE_COACH", label: "Life Coach" },
      { key: "HEALTH_FITNESS__NUTRITIONIST_DIETITIAN", label: "Nutritionist & Dietitian" },
      { key: "HEALTH_FITNESS__SWIMMING_COACH", label: "Swimming Coach" },
      { key: "HEALTH_FITNESS__YOGA_PILATES", label: "Yoga & Pilates" },
      { key: "HEALTH_FITNESS__PERSONAL_TRAINER", label: "Personal Trainer" },
      {
        key: "HEALTH_FITNESS__SPORTS_MASSAGE_THERAPIST",
        label: "Sports Massage Therapist",
      },
      { key: "HEALTH_FITNESS__ACUPUNCTURIST", label: "Acupuncturist" },
      { key: "HEALTH_FITNESS__OSTEOPATH_CHIROPRACTOR", label: "Osteopath & Chiropractor" },
    ],
  },
  {
    key: "SPORTS_ACTIVITIES",
    label: "Sports & Activities",
    subcategories: [
      { key: "SPORTS_ACTIVITIES__ARCHERY", label: "Archery" },
      { key: "SPORTS_ACTIVITIES__GO_KARTING", label: "Go - Karting" },
      { key: "SPORTS_ACTIVITIES__LASER_TAG", label: "Laser Tag" },
      { key: "SPORTS_ACTIVITIES__PAINTBALL", label: "Paintball" },
      {
        key: "SPORTS_ACTIVITIES__HORSE_RIDING_EQUESTRIAN",
        label: "Horse Riding & Equestrian",
      },
      { key: "SPORTS_ACTIVITIES__SHOOTING_RANGE", label: "Shooting Range" },
      { key: "SPORTS_ACTIVITIES__GOLF", label: "Golf" },
      { key: "SPORTS_ACTIVITIES__SNORKELLING", label: "Snorkelling" },
      { key: "SPORTS_ACTIVITIES__SQUASH", label: "Squash" },
      { key: "SPORTS_ACTIVITIES__CYCLING_TOUR", label: "Cycling Tour" },
      { key: "SPORTS_ACTIVITIES__CLIMBING_WALL", label: "Climbing Wall" },
      { key: "SPORTS_ACTIVITIES__AXE_THROWING", label: "Axe Throwing" },
      { key: "SPORTS_ACTIVITIES__BOWLING", label: "Bowling" },
      { key: "SPORTS_ACTIVITIES__PADEL", label: "Padel" },
      {
        key: "SPORTS_ACTIVITIES__WAKEBOARDING_WATER_SPORTS",
        label: "Wakeboarding & Water Sports",
      },
      { key: "SPORTS_ACTIVITIES__TENNIS", label: "Tennis" },
      {
        key: "SPORTS_ACTIVITIES__FOOTBALL_FIVE_A_SIDE",
        label: "Football & Five-a-side",
      },
      { key: "SPORTS_ACTIVITIES__ESCAPE_ROOM", label: "Escape Room" },
    ],
  },
  {
    key: "EXPERIENCES_TOURS",
    label: "Experience & Tours",
    subcategories: [
      { key: "EXPERIENCE_TOURS__CITY_CULTURAL_TOURS", label: "City & Cultural Tours" },
      { key: "EXPERIENCE_TOURS__PRIVATE_YACHT_CHARTER", label: "Private Yacht Charter" },
      { key: "EXPERIENCE_TOURS__COOKING_CLASS", label: "Cooking Class" },
      { key: "EXPERIENCE_TOURS__PRIVATE_GUIDED_TOURS", label: "Private Guided Tours" },
      { key: "EXPERIENCE_TOURS__SCUBA_DIVING", label: "Scuba Diving" },
      { key: "EXPERIENCE_TOURS__SNORKELLING_TOUR", label: "Snorkelling Tour" },
      { key: "EXPERIENCE_TOURS__BOAT_TRIPS", label: "Boat Trips" },
      { key: "EXPERIENCE_TOURS__WINE_TASTING", label: "Wine Tasting" },
      {
        key: "EXPERIENCE_TOURS__JEEP_SAFARI_OFF_ROAD_TOURS",
        label: "Jeep Safari & Off-Road Tours",
      },
      { key: "EXPERIENCE_TOURS__POTTERY_CRAFT_WORKSHOP", label: "Pottery & Craft Workshop" },
      { key: "EXPERIENCE_TOURS__SUNSET_CRUISE", label: "Sunset Cruise" },
    ],
  },
  {
    key: "ENTERTAINMENT_EVENTS",
    label: "Entertainment & Events",
    subcategories: [
      { key: "ENTERTAINMENT_EVENTS__DJ", label: "Dj" },
      { key: "ENTERTAINMENT_EVENTS__MAGICIAN", label: "Magician" },
      {
        key: "ENTERTAINMENT_EVENTS__CHILDRENS_ENTERTAINER",
        label: "Children's Entertainer",
      },
      { key: "ENTERTAINMENT_EVENTS__FACE_PAINTER", label: "Face Painter" },
      { key: "ENTERTAINMENT_EVENTS__EVENT_PHOTOGRAPHER", label: "Event Photographer" },
      { key: "ENTERTAINMENT_EVENTS__PHOTO_BOOTH_HIRE", label: "Photo Booth Hire" },
      {
        key: "ENTERTAINMENT_EVENTS__MOBILE_BAR_COCKTAIL_SERVICE",
        label: "Mobile Bar & Cocktail Service",
      },
      {
        key: "ENTERTAINMENT_EVENTS__INFLATABLE_CASTLE_SOFT_PLAY_HIRE",
        label: "Inflatable Castle & Soft Play Hire",
      },
      { key: "ENTERTAINMENT_EVENTS__CURICATURE_ARTIST", label: "Curicature Artist" },
      { key: "ENTERTAINMENT_EVENTS__BALLOON_ARTIST", label: "Balloon Artist" },
    ],
  },
  {
    key: "CREATIVE_EDUCATION",
    label: "Creative & Education",
    subcategories: [
      { key: "CREATIVE_EDUCATION__PHOTOGRAPHER", label: "Photographer" },
      { key: "CREATIVE_EDUCATION__VIDEOGRAPHER", label: "Videographer" },
      { key: "CREATIVE_EDUCATION__MUSIC_LESSONS", label: "Music Lessons" },
      { key: "CREATIVE_EDUCATION__DANCE_CLASSES", label: "Dance Classes" },
      { key: "CREATIVE_EDUCATION__LANGUAGE_TUTOR", label: "Language Tutor" },
      { key: "CREATIVE_EDUCATION__PRIVATE_ART_TUTOR", label: "Private Art Tutor" },
    ],
  },
  {
    key: "PETS_HOME",
    label: "Pets & Home",
    subcategories: [
      { key: "PETS_HOME__DOG_TRAINER", label: "Dog Trainer" },
      { key: "PETS_HOME__MOBILE_PET_GROOMER", label: "Mobile Pet Groomer" },
      { key: "PETS_HOME__PET_SITTING", label: "Pet Sitting" },
      { key: "PETS_HOME__PET_WALKER", label: "Pet Walker" },
      { key: "PETS_HOME__PET_PHOTOGRAPHY", label: "Pet Photography" },
      { key: "PETS_HOME__VETERINARY_HOME_VISIT", label: "Veterinary Home Visit" },
      { key: "PETS_HOME__DOG_DAY_CARE", label: "Dog Day Care" },
      { key: "PETS_HOME__PET_GROOMING", label: "Pet Grooming" },
    ],
  },
  {
    key: "AUTOMOTIVE",
    label: "Automotive",
    subcategories: [
      { key: "AUTOMOTIVE__CAR_DETAILING", label: "Car Detailing" },
      { key: "AUTOMOTIVE__CAR_WASH", label: "Car Wash" },
      { key: "AUTOMOTIVE__WINDOW_TINTING", label: "Window Tinting" },
      { key: "AUTOMOTIVE__VEHICLE_WRAPPING", label: "Vehicle Wrapping" },
      { key: "AUTOMOTIVE__MOBILE_CAR_MECHANIC", label: "Mobile Car Mechanic" },
      { key: "AUTOMOTIVE__WINDSCREEN_REPAIR", label: "Windscreen Repair" },
    ],
  },
  {
    key: "PROFESSIONAL_SERVICES_CONSULTING_COACHING",
    label: "Professional Services/ Consulting & Coaching",
    subcategories: [
      {
        key: "PROFESSIONAL_SERVICES__BUSINESS_CONSULTANT",
        label: "Business Consultant",
      },
      {
        key: "PROFESSIONAL_SERVICES__LIFE_BUSINESS_COACHES",
        label: "Life & Business Coaches",
      },
      { key: "PROFESSIONAL_SERVICES__CAREER_ADVISORS", label: "Career Advisors" },
      {
        key: "PROFESSIONAL_SERVICES__TUTORS_ACADEMIC_COACHES",
        label: "Tutors & Academic Coaches",
      },
      {
        key: "PROFESSIONAL_SERVICES__FINANCIAL_ADVISORS_LIMITED_SCOPE",
        label: "Financial Advisors (limited scope)",
      },
      {
        key: "PROFESSIONAL_SERVICES__LEGAL_CONSULTATION_LIMITED_SCOPE",
        label: "Legal Consultation (limited scope)",
      },
    ],
  },
] as const satisfies ReadonlyArray<{
  key: BusinessCategoryKey;
  label: string;
  subcategories: ReadonlyArray<{ key: string; label: string }>;
}>;

export type BusinessTaxonomyCategory = (typeof BUSINESS_TAXONOMY)[number];
export type BusinessTaxonomySubcategory = BusinessTaxonomyCategory["subcategories"][number];
export type BusinessTaxonomySubcategoryKey = BusinessTaxonomySubcategory["key"];

/** Every parent key in `BUSINESS_TAXONOMY`, in canonical/display order — a subset-in-spirit of
 * `businessCategoryKeys` (same values), kept local so callers iterating the taxonomy don't need
 * a second import. */
export const BUSINESS_TAXONOMY_CATEGORY_KEYS = BUSINESS_TAXONOMY.map(
  (c) => c.key,
) as ReadonlyArray<BusinessCategoryKey>;

/** Flat list of every subcategory key across all 9 categories — used to build the Zod enum for
 * the onboarding submission contract. */
export const ALL_BUSINESS_TAXONOMY_SUBCATEGORY_KEYS: readonly string[] = BUSINESS_TAXONOMY.flatMap(
  (category) => category.subcategories.map((sub) => sub.key),
);

const CATEGORY_BY_KEY = new Map<string, BusinessTaxonomyCategory>(
  BUSINESS_TAXONOMY.map((category) => [category.key, category]),
);

export const findTaxonomyCategory = (
  categoryKey: string | null | undefined,
): BusinessTaxonomyCategory | undefined =>
  categoryKey ? CATEGORY_BY_KEY.get(categoryKey) : undefined;

export const isBusinessTaxonomyCategoryKey = (value: string): value is BusinessCategoryKey =>
  CATEGORY_BY_KEY.has(value);

export const findTaxonomySubcategory = (
  categoryKey: string,
  subcategoryKey: string,
): BusinessTaxonomySubcategory | undefined =>
  findTaxonomyCategory(categoryKey)?.subcategories.find((sub) => sub.key === subcategoryKey);

/** True only when `subcategoryKey` is a real child of `categoryKey` in the canonical taxonomy —
 * the parent-child integrity check the previous free-text system never had. */
export const isValidSubcategoryOfCategory = (
  categoryKey: string,
  subcategoryKey: string,
): boolean => findTaxonomySubcategory(categoryKey, subcategoryKey) !== undefined;

/**
 * Resolve a fully-validated `{ categoryKey, subcategoryKeys }` selection into its canonical
 * display labels. Callers (the onboarding service) must validate membership FIRST (the Zod
 * schema already does) — this throws if given an invalid combination rather than guessing,
 * because by the time this runs the input is expected to already be trustworthy.
 */
export const resolveCanonicalCategorySelection = (input: {
  categoryKey: string;
  subcategoryKeys: string[];
}): {
  categoryKey: BusinessCategoryKey;
  categoryLabel: string;
  subcategoryKeys: string[];
  subcategoryLabels: string[];
} => {
  const category = findTaxonomyCategory(input.categoryKey);
  if (!category) {
    throw new Error(
      `resolveCanonicalCategorySelection: unknown category key "${input.categoryKey}"`,
    );
  }

  const subcategories = input.subcategoryKeys.map((key) => {
    const sub = category.subcategories.find((candidate) => candidate.key === key);
    if (!sub) {
      throw new Error(
        `resolveCanonicalCategorySelection: "${key}" does not belong to category "${category.key}"`,
      );
    }
    return sub;
  });

  return {
    categoryKey: category.key,
    categoryLabel: category.label,
    subcategoryKeys: subcategories.map((sub) => sub.key),
    subcategoryLabels: subcategories.map((sub) => sub.label),
  };
};

/**
 * Best-effort legacy compatibility (Phase 14 of the audit): given a resolved legacy parent
 * category and the free-text pseudo-subcategory strings an old draft/business stored, return
 * only the ones that happen to exactly match (case-insensitively) a REAL subcategory label
 * under that parent. Deliberately conservative — old "subcategories" were actually just other
 * top-level category names reused, so this will almost always return an empty array, which is
 * the correct, safe outcome (never silently invent a parent-child relationship).
 */
export const resolveLegacySubcategoryLabels = (
  categoryKey: string,
  legacyLabels: readonly string[],
): BusinessTaxonomySubcategory[] => {
  const category = findTaxonomyCategory(categoryKey);
  if (!category) {
    return [];
  }
  const wanted = new Set(legacyLabels.map((label) => label.trim().toLowerCase()));
  return category.subcategories.filter((sub) => wanted.has(sub.label.trim().toLowerCase()));
};

/** Wire/API shape for `GET /platform/business-taxonomy` — plain data, no `as const` literals. */
export type BusinessTaxonomyResponse = Array<{
  key: BusinessCategoryKey;
  label: string;
  subcategories: Array<{ key: string; label: string }>;
}>;

export const getBusinessTaxonomyResponse = (): BusinessTaxonomyResponse =>
  BUSINESS_TAXONOMY.map((category) => ({
    key: category.key,
    label: category.label,
    subcategories: category.subcategories.map((sub) => ({ key: sub.key, label: sub.label })),
  }));

// Defensive, run-once structural guards — fail fast (at module load, i.e. process boot / test
// import) rather than ever serving a malformed taxonomy. Not a substitute for the dedicated
// taxonomy tests, which assert the exact product-supplied shape.
(() => {
  if (BUSINESS_TAXONOMY.length !== businessCategoryKeys.length) {
    throw new Error(
      "business-taxonomy.ts: BUSINESS_TAXONOMY must have exactly one entry per businessCategoryKeys",
    );
  }
  const seenCategoryKeys = new Set<string>();
  const seenSubcategoryKeys = new Set<string>();
  for (const category of BUSINESS_TAXONOMY) {
    if (seenCategoryKeys.has(category.key)) {
      throw new Error(`business-taxonomy.ts: duplicate category key "${category.key}"`);
    }
    seenCategoryKeys.add(category.key);
    for (const sub of category.subcategories) {
      if (seenSubcategoryKeys.has(sub.key)) {
        throw new Error(`business-taxonomy.ts: duplicate subcategory key "${sub.key}"`);
      }
      seenSubcategoryKeys.add(sub.key);
    }
  }
})();
