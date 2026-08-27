import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessMediaRepository } from "../../../src/modules/business-media/business-media.repository.js";
import { DiscoveryRepository } from "../../../src/modules/discovery/discovery.repository.js";
import { DiscoveryService } from "../../../src/modules/discovery/discovery.service.js";
import { FavoriteModel } from "../../../src/modules/favorite/favorite.model.js";
import { ReviewModel } from "../../../src/modules/review/review.model.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * Batch 17 — the homepage's three discovery rows (Recommended / Services near you / Popular).
 * Every Business/Service/Review/Booking/Favorite is created through real primitives (or a raw
 * insert of exactly the fields the ranking reads) — never a fixture asserting against itself.
 */
describe("database-backed home discovery sections (Batch 17)", () => {
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
    const approved = await businessRepository.casUpdateStatus(
      pending._id,
      ["PENDING"],
      "APPROVED",
      {
        fromStatus: "PENDING",
        actorUserId: owner._id,
        changedAt: new Date(),
      },
    );
    let current = approved ?? pending;
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

  const createActiveService = async (businessId: Types.ObjectId, priceCents: number) =>
    serviceRepository.create({
      businessId,
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: false,
      category: "Barber",
      name: "Haircut",
      pricingMode: "FIXED",
      fixedPricing: { priceCents, durationMin: 60, bookingIntervalMin: 60 },
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities: [],
      assignedStaffMembershipIds: [],
    });

  const createPublishedReviews = async (businessId: Types.ObjectId, ratings: number[]) => {
    for (const rating of ratings) {
      const customer = await userRepository.create({
        normalizedEmail: `cust-${new Types.ObjectId().toString()}@example.com`,
        passwordHash: "hash",
        role: "CUSTOMER",
        status: "ACTIVE",
      });
      await ReviewModel.create({
        bookingId: new Types.ObjectId(),
        businessId,
        customerUserId: customer._id,
        reviewerDisplayName: "Test C.",
        rating,
        status: "PUBLISHED",
        moderationHistory: [],
      });
    }
  };

  /** Raw insert of only the fields the discovery aggregation reads — a full Booking aggregate
   * is irrelevant to a ranking test and carries dozens of unrelated required fields. */
  const insertBookings = async (
    businessId: Types.ObjectId,
    status: string,
    count: number,
    customerUserId?: Types.ObjectId,
  ) => {
    for (let i = 0; i < count; i += 1) {
      await BookingModel.collection.insertOne({
        _id: new Types.ObjectId(),
        businessId,
        // `bookings.reference` carries a unique index — needs a distinct value per raw insert.
        reference: `BK-${new Types.ObjectId().toString()}`,
        status,
        customer: customerUserId ? { customerUserId } : {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  };

  const favorite = async (businessId: Types.ObjectId, count: number) => {
    for (let i = 0; i < count; i += 1) {
      const customer = await userRepository.create({
        normalizedEmail: `fav-${new Types.ObjectId().toString()}@example.com`,
        passwordHash: "hash",
        role: "CUSTOMER",
        status: "ACTIVE",
      });
      await FavoriteModel.create({ customerUserId: customer._id, businessId });
    }
  };

  const names = (cards: { name: string }[]) => cards.map((c) => c.name);

  // --- Visibility (shared with Explore) ------------------------------------------------------

  it("every section shows only APPROVED/WARNING Businesses — PENDING and SUSPENDED never appear", async () => {
    const { business: approved } = await createBusiness({ name: "Approved", status: "APPROVED" });
    const { business: warning } = await createBusiness({ name: "Warning", status: "WARNING" });
    await createBusiness({ name: "Pending", status: "PENDING" });
    await createBusiness({ name: "Suspended", status: "SUSPENDED" });
    // give the suspended one lots of fake-popular signal to prove status wins
    const { business: suspended } = await createBusiness({
      name: "Suspended2",
      status: "SUSPENDED",
    });
    await insertBookings(suspended._id, "COMPLETED", 20);
    await favorite(suspended._id, 20);

    const result = await discoveryService.getHomeSections({ limit: 6 });
    const allIds = [...result.recommended, ...result.nearYou, ...result.popular].map((c) => c.id);

    expect(new Set(allIds)).toEqual(new Set([String(approved._id), String(warning._id)]));
  });

  // --- Recommended -------------------------------------------------------------------------

  it("Recommended (no session) is a deterministic pure-quality ranking — no seeded order", async () => {
    const { business: strong } = await createBusiness({ name: "Strong" });
    await createPublishedReviews(strong._id, [5, 5, 5, 5]);
    const { business: ok } = await createBusiness({ name: "Ok" });
    await createPublishedReviews(ok._id, [4]);
    const { business: unrated } = await createBusiness({ name: "Unrated" });

    const first = await discoveryService.getHomeSections({ limit: 6 });
    const second = await discoveryService.getHomeSections({ limit: 6 });

    expect(names(first.recommended)).toEqual(["Strong", "Ok", "Unrated"]);
    expect(names(second.recommended)).toEqual(names(first.recommended)); // deterministic
    expect(first.meta.personalized).toBe(false);
    void unrated;
  });

  it("Recommended personalizes from the Customer's real booking history (category + city affinity)", async () => {
    // Two Businesses of equal (zero) review quality; the Customer has only ever booked a
    // Barber in Nicosia.
    const { business: matches } = await createBusiness({
      name: "Booked Barber Nicosia",
      category: "Barber",
      city: "Nicosia",
    });
    const { business: other } = await createBusiness({
      name: "Unrelated Spa Paphos",
      category: "Spa",
      city: "Paphos",
    });

    const customer = await userRepository.create({
      normalizedEmail: `me-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    await insertBookings(matches._id, "COMPLETED", 1, customer._id);

    const anon = await discoveryService.getHomeSections({ limit: 6 });
    const personalized = await discoveryService.getHomeSections({
      limit: 6,
      customerUserId: customer._id,
    });

    // Anonymous: deterministic _id order (both zero quality) — not guaranteed to match affinity.
    expect(anon.meta.personalized).toBe(false);
    // Personalized: the really-booked category/city Business is lifted to the top.
    expect(personalized.meta.personalized).toBe(true);
    expect(personalized.recommended[0]?.name).toBe("Booked Barber Nicosia");
    void other;
  });

  // --- Services near you ------------------------------------------------------------------

  it("Services near you is a hard filter on the picked city and never carries a distance", async () => {
    const { business: larnaca } = await createBusiness({ name: "Larnaca Co", city: "Larnaca" });
    await createBusiness({ name: "Limassol Co", city: "Limassol" });
    await createBusiness({ name: "Paphos Co", city: "Paphos" });

    const result = await discoveryService.getHomeSections({ limit: 6, city: "Larnaca" });

    expect(names(result.nearYou)).toEqual(["Larnaca Co"]);
    expect(result.meta.nearYouCity).toBe("Larnaca");
    expect(result.nearYou[0]).not.toHaveProperty("distance");
    void larnaca;
  });

  it("Services near you with no city falls back to TRAVEL_TO_CUSTOMER Businesses first", async () => {
    await createBusiness({ name: "Fixed A", visitType: "AT_BUSINESS_LOCATION" });
    const { business: travels } = await createBusiness({
      name: "Mobile B",
      visitType: "TRAVEL_TO_CUSTOMER",
    });
    await createBusiness({ name: "Fixed C", visitType: "AT_BUSINESS_LOCATION" });

    const result = await discoveryService.getHomeSections({ limit: 6 });

    expect(result.nearYou[0]?.name).toBe("Mobile B");
    expect(result.meta.nearYouCity).toBeNull();
    void travels;
  });

  // --- Popular --------------------------------------------------------------------------

  it("Popular ranks by real activity: completed bookings > favorites > reviews > nothing", async () => {
    const { business: bookings } = await createBusiness({ name: "Most Booked" });
    await insertBookings(bookings._id, "COMPLETED", 5);

    const { business: faved } = await createBusiness({ name: "Most Faved" });
    await favorite(faved._id, 5);

    const { business: reviewed } = await createBusiness({ name: "Most Reviewed" });
    await createPublishedReviews(reviewed._id, [5, 5, 5, 5, 5, 5]);

    const { business: quiet } = await createBusiness({ name: "No Activity" });

    const result = await discoveryService.getHomeSections({ limit: 6 });

    // completed*3 (=15) > favorites*2 (=10) > reviewCount*1 (=6) > 0
    expect(names(result.popular)).toEqual([
      "Most Booked",
      "Most Faved",
      "Most Reviewed",
      "No Activity",
    ]);
    void quiet;
  });

  it("Popular only counts COMPLETED bookings — cancelled/upcoming bookings do not inflate rank", async () => {
    const { business: real } = await createBusiness({ name: "Real Demand" });
    await insertBookings(real._id, "COMPLETED", 2);

    const { business: noise } = await createBusiness({ name: "Cancelled Noise" });
    await insertBookings(noise._id, "CANCELLED_BY_CUSTOMER", 20);
    await insertBookings(noise._id, "UPCOMING", 20);

    const result = await discoveryService.getHomeSections({ limit: 6 });

    expect(result.popular[0]?.name).toBe("Real Demand");
    void noise;
  });

  it("Popular with zero activity anywhere is a deterministic _id order, never a fabricated rank", async () => {
    const a = await createBusiness({ name: "AAA" });
    const b = await createBusiness({ name: "BBB" });

    const run1 = await discoveryService.getHomeSections({ limit: 6 });
    const run2 = await discoveryService.getHomeSections({ limit: 6 });

    const expected = [a.business._id, b.business._id]
      .sort((x, y) => (x.toString() < y.toString() ? -1 : 1))
      .map(String);
    expect(run1.popular.map((c) => c.id)).toEqual(expected);
    expect(run2.popular.map((c) => c.id)).toEqual(run1.popular.map((c) => c.id));
  });

  // --- Cross-section de-duplication ----------------------------------------------------

  it("with enough inventory the three sections share no Businesses", async () => {
    for (let i = 0; i < 24; i += 1) {
      const { business } = await createBusiness({
        name: `Biz ${String(i).padStart(2, "0")}`,
        city: i % 2 === 0 ? "Larnaca" : "Limassol",
      });
      await createPublishedReviews(business._id, [((i % 5) + 1) as number]);
      if (i % 3 === 0) await insertBookings(business._id, "COMPLETED", i);
    }

    const result = await discoveryService.getHomeSections({ limit: 6 });

    const rec = new Set(result.recommended.map((c) => c.id));
    const near = new Set(result.nearYou.map((c) => c.id));
    const pop = new Set(result.popular.map((c) => c.id));
    expect(result.recommended).toHaveLength(6);
    expect(result.nearYou).toHaveLength(6);
    expect(result.popular).toHaveLength(6);
    for (const id of near) expect(rec.has(id)).toBe(false);
    for (const id of pop) expect(rec.has(id) || near.has(id)).toBe(false);
  });

  it("with tiny inventory sections deterministically fall back to overlap rather than going empty", async () => {
    const { business: a } = await createBusiness({ name: "Only A" });
    const { business: b } = await createBusiness({ name: "Only B" });

    const run1 = await discoveryService.getHomeSections({ limit: 6 });
    const run2 = await discoveryService.getHomeSections({ limit: 6 });

    const two = new Set([String(a._id), String(b._id)]);
    expect(new Set(run1.recommended.map((c) => c.id))).toEqual(two);
    expect(new Set(run1.nearYou.map((c) => c.id))).toEqual(two);
    expect(new Set(run1.popular.map((c) => c.id))).toEqual(two);
    // fully deterministic across runs
    expect(run2.recommended.map((c) => c.id)).toEqual(run1.recommended.map((c) => c.id));
    expect(run2.nearYou.map((c) => c.id)).toEqual(run1.nearYou.map((c) => c.id));
    expect(run2.popular.map((c) => c.id)).toEqual(run1.popular.map((c) => c.id));
  });

  // --- Card payload ------------------------------------------------------------------

  it("card values are the real persisted rating / review count / starting price", async () => {
    const { business } = await createBusiness({ name: "Full Card" });
    await createActiveService(business._id, 4500);
    await createPublishedReviews(business._id, [5, 4]); // avg 4.5, count 2

    const result = await discoveryService.getHomeSections({ limit: 6 });
    const card = result.recommended.find((c) => c.id === String(business._id));

    expect(card?.averageRating).toBe(4.5);
    expect(card?.reviewCount).toBe(2);
    expect(card?.startingPriceCents).toBe(4500);
  });
});
