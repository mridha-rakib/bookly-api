import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessMediaRepository } from "../../../src/modules/business-media/business-media.repository.js";
import { DiscoveryRepository } from "../../../src/modules/discovery/discovery.repository.js";
import { DiscoveryService } from "../../../src/modules/discovery/discovery.service.js";
import { ReviewModel } from "../../../src/modules/review/review.model.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * Batch 16 — Explore's real backend, domain-level correctness. Every Business/Service/Review used
 * here is created through the REAL repository primitives (never a fixture asserting against
 * itself, matching this codebase's established discipline — see review-database.integration.test.ts).
 */
describe("database-backed Discovery domain (Batch 16)", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let serviceRepository: ServiceRepository;
  let discoveryService: DiscoveryService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    serviceRepository = new ServiceRepository();
    discoveryService = new DiscoveryService(
      new DiscoveryRepository(),
      new BusinessMediaRepository(),
      undefined,
    );
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixtures --------------------------------------------------------------------------------

  const createBusiness = async (
    overrides: Partial<{
      name: string;
      status: "PENDING" | "APPROVED" | "WARNING" | "SUSPENDED";
      city: "Larnaca" | "Limassol" | "Nicosia" | "Paphos" | "Ayia Napa" | "Protaras";
      visitType: "AT_BUSINESS_LOCATION" | "TRAVEL_TO_CUSTOMER";
      category: string;
    }> = {},
  ) => {
    const email = `owner-${new Types.ObjectId().toString()}@example.com`;
    const owner = await userRepository.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const pending = await businessRepository.create({
      ownerUserId: owner._id,
      name: overrides.name ?? "Salon Discovery",
      ownerName: "Owner Name",
      email,
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: overrides.visitType ?? "AT_BUSINESS_LOCATION",
      timezone: "Europe/Nicosia",
      address: {
        city: overrides.city ?? "Larnaca",
        area: "Center",
        streetName: "Main",
        streetNumber: "1",
      },
      briefDescription: "A great business",
      category: overrides.category ?? "Barber",
      subcategories: ["Haircut"],
    });

    const targetStatus = overrides.status ?? "APPROVED";
    if (targetStatus === "PENDING") {
      return { owner, business: pending };
    }
    const business = await businessRepository.casUpdateStatus(
      pending._id,
      ["PENDING"],
      "APPROVED",
      { fromStatus: "PENDING", actorUserId: owner._id, changedAt: new Date() },
    );
    let current = business ?? pending;
    if (targetStatus === "WARNING" || targetStatus === "SUSPENDED") {
      const next = await businessRepository.casUpdateStatus(
        current._id,
        ["APPROVED"],
        targetStatus,
        {
          fromStatus: "APPROVED",
          actorUserId: owner._id,
          changedAt: new Date(),
        },
      );
      current = next ?? current;
    }
    return { owner, business: current };
  };

  const createActiveService = async (
    businessId: Types.ObjectId,
    overrides: Partial<{
      priceCents: number;
      status: "DRAFT" | "ACTIVE" | "INACTIVE" | "ARCHIVED";
      isPackageDeal: boolean;
    }> = {},
  ) =>
    serviceRepository.create({
      businessId,
      status: overrides.status ?? "ACTIVE",
      isFeatured: false,
      isPackageDeal: overrides.isPackageDeal ?? false,
      category: "Barber",
      name: "Haircut",
      pricingMode: "FIXED",
      fixedPricing: {
        priceCents: overrides.priceCents ?? 8000,
        durationMin: 60,
        bookingIntervalMin: 60,
      },
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities: [],
      assignedStaffMembershipIds: [],
    });

  const createPublishedReview = async (businessId: Types.ObjectId, rating: number) => {
    const customer = await userRepository.create({
      normalizedEmail: `cust-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    return ReviewModel.create({
      bookingId: new Types.ObjectId(),
      businessId,
      customerUserId: customer._id,
      reviewerDisplayName: "Test C.",
      rating,
      status: "PUBLISHED",
      moderationHistory: [],
    });
  };

  // --- Visibility ------------------------------------------------------------------------------

  it("[1][2][3] only APPROVED/WARNING Businesses appear — PENDING and SUSPENDED are excluded", async () => {
    const { business: approved } = await createBusiness({
      name: "Approved Biz",
      status: "APPROVED",
    });
    await createBusiness({ name: "Pending Biz", status: "PENDING" });
    await createBusiness({ name: "Suspended Biz", status: "SUSPENDED" });
    const { business: warning } = await createBusiness({ name: "Warning Biz", status: "WARNING" });

    const result = await discoveryService.search({}, "mostRelevant", { page: 1, limit: 20 });
    const ids = result.businesses.map((b) => b.id);

    expect(ids).toContain(String(approved._id));
    expect(ids).toContain(String(warning._id));
    expect(ids).not.toContain(undefined);
    expect(result.businesses.map((b) => b.name).sort()).toEqual(["Approved Biz", "Warning Biz"]);
  });

  // --- Service visibility / pricing --------------------------------------------------------------

  it("[4][5] starting price only considers ACTIVE, non-package Services — ARCHIVED/INACTIVE/PACKAGE excluded", async () => {
    const { business } = await createBusiness({ name: "Priced Biz" });
    await createActiveService(business._id, { priceCents: 15000, status: "ARCHIVED" });
    await createActiveService(business._id, { priceCents: 12000, status: "INACTIVE" });
    await createActiveService(business._id, { priceCents: 5000, isPackageDeal: true });
    await createActiveService(business._id, { priceCents: 9000 }); // the only real, visible price

    const result = await discoveryService.search({}, "mostRelevant", { page: 1, limit: 20 });
    const card = result.businesses.find((b) => b.id === String(business._id));

    expect(card?.startingPriceCents).toBe(9000);
  });

  it("a Business with no ACTIVE non-package Service shows a null starting price, never a fabricated one", async () => {
    const { business } = await createBusiness({ name: "No Services Biz" });

    const result = await discoveryService.search({}, "mostRelevant", { page: 1, limit: 20 });
    const card = result.businesses.find((b) => b.id === String(business._id));

    expect(card?.startingPriceCents).toBeNull();
    expect(card?.startingPricingMode).toBeNull();
  });

  // --- Ratings -------------------------------------------------------------------------------

  it("[9][10][11] rating comes from real PUBLISHED Reviews only — HIDDEN/REMOVED excluded, zero-review is truthful", async () => {
    const { business: rated } = await createBusiness({ name: "Rated Biz" });
    await createPublishedReview(rated._id, 5);
    await createPublishedReview(rated._id, 3);
    const hidden = await createPublishedReview(rated._id, 1);
    await ReviewModel.updateOne({ _id: hidden._id }, { $set: { status: "HIDDEN" } }).exec();

    const { business: unrated } = await createBusiness({ name: "Unrated Biz" });

    const result = await discoveryService.search({}, "mostRelevant", { page: 1, limit: 20 });
    const ratedCard = result.businesses.find((b) => b.id === String(rated._id));
    const unratedCard = result.businesses.find((b) => b.id === String(unrated._id));

    expect(ratedCard?.averageRating).toBe(4); // (5+3)/2, HIDDEN excluded
    expect(ratedCard?.reviewCount).toBe(2);
    expect(unratedCard?.averageRating).toBeNull();
    expect(unratedCard?.reviewCount).toBe(0);
  });

  it("minRating filter excludes Businesses below the threshold, including zero-review Businesses", async () => {
    const { business: highRated } = await createBusiness({ name: "High Rated" });
    await createPublishedReview(highRated._id, 5);
    const { business: lowRated } = await createBusiness({ name: "Low Rated" });
    await createPublishedReview(lowRated._id, 3);
    await createBusiness({ name: "No Reviews" });

    const result = await discoveryService.search({ minRating: 4 }, "mostRelevant", {
      page: 1,
      limit: 20,
    });

    expect(result.businesses.map((b) => b.name)).toEqual(["High Rated"]);
  });

  // --- Search / filters ------------------------------------------------------------------------

  it("[6] search matches Business name (bounded, case-insensitive)", async () => {
    await createBusiness({ name: "Soho Vintage Barbers" });
    await createBusiness({ name: "Glam Nails Studio" });

    const result = await discoveryService.search({ q: "soho" }, "mostRelevant", {
      page: 1,
      limit: 20,
    });

    expect(result.businesses.map((b) => b.name)).toEqual(["Soho Vintage Barbers"]);
  });

  it("[7] city and visitType filters are real and server-side", async () => {
    await createBusiness({ name: "Larnaca Salon", city: "Larnaca" });
    await createBusiness({ name: "Limassol Salon", city: "Limassol" });
    await createBusiness({
      name: "Travels To You",
      visitType: "TRAVEL_TO_CUSTOMER",
      city: "Nicosia",
    });

    const cityResult = await discoveryService.search({ city: ["Larnaca"] }, "mostRelevant", {
      page: 1,
      limit: 20,
    });
    expect(cityResult.businesses.map((b) => b.name)).toEqual(["Larnaca Salon"]);

    const travelResult = await discoveryService.search(
      { visitType: "TRAVEL_TO_CUSTOMER" },
      "mostRelevant",
      { page: 1, limit: 20 },
    );
    expect(travelResult.businesses.map((b) => b.name)).toEqual(["Travels To You"]);
  });

  it("category filter matches the real, stored Business.category exactly", async () => {
    await createBusiness({ name: "Barber Shop", category: "Barber" });
    await createBusiness({ name: "Nail Bar", category: "Nails" });

    const result = await discoveryService.search({ category: ["Nails"] }, "mostRelevant", {
      page: 1,
      limit: 20,
    });
    expect(result.businesses.map((b) => b.name)).toEqual(["Nail Bar"]);
  });

  it("city/category filters accept multiple values (matches the multi-select checkbox UI)", async () => {
    await createBusiness({ name: "Larnaca Shop", city: "Larnaca", category: "Barber" });
    await createBusiness({ name: "Nicosia Shop", city: "Nicosia", category: "Nails" });
    await createBusiness({ name: "Paphos Shop", city: "Paphos", category: "Spa" });

    const result = await discoveryService.search({ city: ["Larnaca", "Nicosia"] }, "mostRelevant", {
      page: 1,
      limit: 20,
    });
    expect(result.businesses.map((b) => b.name).sort()).toEqual(["Larnaca Shop", "Nicosia Shop"]);

    const categoryResult = await discoveryService.search(
      { category: ["Barber", "Spa"] },
      "mostRelevant",
      { page: 1, limit: 20 },
    );
    expect(categoryResult.businesses.map((b) => b.name).sort()).toEqual([
      "Larnaca Shop",
      "Paphos Shop",
    ]);
  });

  it("categories are derived from the DISTINCT category strings actually present on visible Businesses only", async () => {
    await createBusiness({ name: "A", category: "Barber" });
    await createBusiness({ name: "B", category: "Nails" });
    await createBusiness({ name: "C", category: "Barber" }); // duplicate — must not repeat
    await createBusiness({ name: "D", category: "Hidden Pending", status: "PENDING" });

    const categories = await discoveryService.listCategories();

    expect(categories).toEqual(["Barber", "Nails"]);
  });

  // --- Sorting ---------------------------------------------------------------------------------

  it("[8] sort: ratingHighToLow puts the highest real rating first, zero-review Businesses last", async () => {
    const { business: a } = await createBusiness({ name: "A" });
    await createPublishedReview(a._id, 3);
    const { business: b } = await createBusiness({ name: "B" });
    await createPublishedReview(b._id, 5);
    await createBusiness({ name: "C" }); // no reviews

    const result = await discoveryService.search({}, "ratingHighToLow", { page: 1, limit: 20 });

    expect(result.businesses.map((x) => x.name)).toEqual(["B", "A", "C"]);
  });

  it("sort: priceLowToHigh / priceHighToLow order by the real starting price, nulls last on both", async () => {
    const { business: cheap } = await createBusiness({ name: "Cheap" });
    await createActiveService(cheap._id, { priceCents: 3000 });
    const { business: pricey } = await createBusiness({ name: "Pricey" });
    await createActiveService(pricey._id, { priceCents: 9000 });
    await createBusiness({ name: "NoPrice" });

    const low = await discoveryService.search({}, "priceLowToHigh", { page: 1, limit: 20 });
    expect(low.businesses.map((x) => x.name)).toEqual(["Cheap", "Pricey", "NoPrice"]);

    const high = await discoveryService.search({}, "priceHighToLow", { page: 1, limit: 20 });
    expect(high.businesses.map((x) => x.name)).toEqual(["Pricey", "Cheap", "NoPrice"]);
  });

  it("sort: mostRelevant falls back to a stable, deterministic name order (no invented ranking)", async () => {
    await createBusiness({ name: "Zebra Salon" });
    await createBusiness({ name: "Alpha Salon" });

    const result = await discoveryService.search({}, "mostRelevant", { page: 1, limit: 20 });

    expect(result.businesses.map((b) => b.name)).toEqual(["Alpha Salon", "Zebra Salon"]);
  });

  // --- Pagination --------------------------------------------------------------------------------

  it("[12] pagination is bounded and has no duplicates/missing boundary items", async () => {
    for (let i = 0; i < 5; i += 1) {
      await createBusiness({ name: `Business ${i}` });
    }

    const page1 = await discoveryService.search({}, "mostRelevant", { page: 1, limit: 2 });
    const page2 = await discoveryService.search({}, "mostRelevant", { page: 2, limit: 2 });
    const page3 = await discoveryService.search({}, "mostRelevant", { page: 3, limit: 2 });

    expect(page1.pagination.total).toBe(5);
    expect(page1.businesses).toHaveLength(2);
    expect(page2.businesses).toHaveLength(2);
    expect(page3.businesses).toHaveLength(1);

    const allNames = [...page1.businesses, ...page2.businesses, ...page3.businesses].map(
      (b) => b.name,
    );
    expect(new Set(allNames).size).toBe(5); // no duplicates across pages
  });

  // --- getCardsByIds (Favorites enrichment path) ------------------------------------------------

  it("getCardsByIds preserves caller order and marks a SUSPENDED Business unavailable rather than omitting it", async () => {
    const { business: visible, owner } = await createBusiness({ name: "Visible" });
    const { business: suspended } = await createBusiness({
      name: "Suspended",
      status: "SUSPENDED",
    });
    void owner;

    const cards = await discoveryService.getCardsByIds([suspended._id, visible._id]);

    expect(cards.map((c) => c.id)).toEqual([String(suspended._id), String(visible._id)]);
    expect(cards[0]?.isAvailable).toBe(false);
    expect(cards[1]?.isAvailable).toBe(true);
  });
});
