import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessMediaRepository } from "../../../src/modules/business-media/business-media.repository.js";
import { DiscoveryRepository } from "../../../src/modules/discovery/discovery.repository.js";
import { DiscoveryService } from "../../../src/modules/discovery/discovery.service.js";
import { FavoriteModel } from "../../../src/modules/favorite/favorite.model.js";
import { FavoriteRepository } from "../../../src/modules/favorite/favorite.repository.js";
import { FavoriteService } from "../../../src/modules/favorite/favorite.service.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * Batch 16 — Favorites, domain-level correctness. A Favorite always points at a real, persisted
 * Business (created through the real BusinessRepository, never a fixture asserting against
 * itself) — matching this codebase's established fixture discipline.
 */
describe("database-backed Favorite domain (Batch 16)", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let favoriteService: FavoriteService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    favoriteService = new FavoriteService(
      new FavoriteRepository(),
      businessRepository,
      new DiscoveryService(new DiscoveryRepository(), new BusinessMediaRepository(), undefined),
    );
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixtures --------------------------------------------------------------------------------

  const createBusiness = async (
    name: string,
    status: "PENDING" | "APPROVED" | "SUSPENDED" = "APPROVED",
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
      name,
      ownerName: "Owner Name",
      email,
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: "AT_BUSINESS_LOCATION",
      timezone: "Europe/Nicosia",
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "A great business",
      category: "Barber",
      subcategories: [],
    });
    if (status === "PENDING") return { owner, business: pending };
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
    if (status === "SUSPENDED") {
      const suspended = await businessRepository.casUpdateStatus(
        current._id,
        ["APPROVED"],
        "SUSPENDED",
        { fromStatus: "APPROVED", actorUserId: owner._id, changedAt: new Date() },
      );
      current = suspended ?? current;
    }
    return { owner, business: current };
  };

  const createCustomer = async (tag: string) =>
    userRepository.create({
      normalizedEmail: `cust-${tag}-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });

  // --- Add / remove / idempotency ---------------------------------------------------------------

  it("[1][2] a Customer can favorite an eligible Business, and it persists", async () => {
    const customer = await createCustomer("add");
    const { business } = await createBusiness("Favorite Me");

    await favoriteService.add(String(customer._id), String(business._id));

    const ids = await favoriteService.listBusinessIds(String(customer._id));
    expect(ids).toEqual([String(business._id)]);
  });

  it("[3] adding the same Favorite twice never creates a duplicate — idempotent, DB-enforced", async () => {
    const customer = await createCustomer("dup");
    const { business } = await createBusiness("Once Only");

    await favoriteService.add(String(customer._id), String(business._id));
    await favoriteService.add(String(customer._id), String(business._id));

    const count = await FavoriteModel.countDocuments({
      customerUserId: customer._id,
      businessId: business._id,
    }).exec();
    expect(count).toBe(1);
  });

  it("[10] a concurrent double-add does not create duplicates (DB unique index is the real guard)", async () => {
    const customer = await createCustomer("race");
    const { business } = await createBusiness("Race Target");

    await Promise.all([
      favoriteService.add(String(customer._id), String(business._id)),
      favoriteService.add(String(customer._id), String(business._id)),
    ]);

    const count = await FavoriteModel.countDocuments({
      customerUserId: customer._id,
      businessId: business._id,
    }).exec();
    expect(count).toBe(1);
  });

  it("[4] a Customer can unfavorite, and it's genuinely removed", async () => {
    const customer = await createCustomer("remove");
    const { business } = await createBusiness("Remove Me");
    await favoriteService.add(String(customer._id), String(business._id));

    await favoriteService.remove(String(customer._id), String(business._id));

    const ids = await favoriteService.listBusinessIds(String(customer._id));
    expect(ids).toEqual([]);
  });

  it("removing a Favorite that was never added is a silent, safe no-op (never an error)", async () => {
    const customer = await createCustomer("remove-noop");
    const { business } = await createBusiness("Never Favorited");

    await expect(
      favoriteService.remove(String(customer._id), String(business._id)),
    ).resolves.toBeUndefined();
  });

  it("favoriting a nonexistent Business is rejected (404)", async () => {
    const customer = await createCustomer("bad-business");

    await expect(
      favoriteService.add(String(customer._id), String(new Types.ObjectId())),
    ).rejects.toThrow();
  });

  // --- Cross-customer isolation ------------------------------------------------------------------

  it("[5][6] Customer A's Favorites are never visible to or mutable by Customer B", async () => {
    const customerA = await createCustomer("owner-a");
    const customerB = await createCustomer("stranger-b");
    const { business } = await createBusiness("A's Favorite");
    await favoriteService.add(String(customerA._id), String(business._id));

    // B never sees A's favorite.
    const bIds = await favoriteService.listBusinessIds(String(customerB._id));
    expect(bIds).toEqual([]);

    // B "removing" A's favorite (the only mutation surface not gated by ownership at the DB
    // query level) does not affect A's real row — the delete filter is always {customerUserId:
    // actor, businessId}, so it simply matches nothing for B.
    await favoriteService.remove(String(customerB._id), String(business._id));
    const aIdsAfter = await favoriteService.listBusinessIds(String(customerA._id));
    expect(aIdsAfter).toEqual([String(business._id)]);
  });

  // --- List enrichment / degradation --------------------------------------------------------------

  it("[7][8] Favorites list is paginated and enriched with real Discovery card data", async () => {
    const customer = await createCustomer("list");
    const { business: b1 } = await createBusiness("Fav One");
    const { business: b2 } = await createBusiness("Fav Two");
    await favoriteService.add(String(customer._id), String(b1._id));
    await favoriteService.add(String(customer._id), String(b2._id));

    const result = await favoriteService.list(String(customer._id), { page: 1, limit: 1 });

    expect(result.pagination.total).toBe(2);
    expect(result.favorites).toHaveLength(1);
    // Newest-favorited-first (b2 was favorited after b1).
    expect(result.favorites[0]?.name).toBe("Fav Two");
    expect(result.favorites[0]?.isAvailable).toBe(true);
  });

  it("[9] a Favorite for a since-SUSPENDED Business degrades safely — stays in the list, marked unavailable, never silently dropped", async () => {
    const customer = await createCustomer("degrade");
    const { business } = await createBusiness("Later Suspended", "APPROVED");
    await favoriteService.add(String(customer._id), String(business._id));

    await businessRepository.casUpdateStatus(business._id, ["APPROVED"], "SUSPENDED", {
      fromStatus: "APPROVED",
      actorUserId: business.ownerUserId,
      changedAt: new Date(),
    });

    const result = await favoriteService.list(String(customer._id), { page: 1, limit: 10 });

    expect(result.favorites).toHaveLength(1);
    expect(result.favorites[0]?.isAvailable).toBe(false);

    // The relationship itself is untouched — removing a Favorite is never an automatic side
    // effect of the Business's own lifecycle.
    const ids = await favoriteService.listBusinessIds(String(customer._id));
    expect(ids).toEqual([String(business._id)]);
  });

  it("removing a Favorite never touches the Business itself", async () => {
    const customer = await createCustomer("no-side-effect");
    const { business } = await createBusiness("Untouched Business");
    await favoriteService.add(String(customer._id), String(business._id));

    await favoriteService.remove(String(customer._id), String(business._id));

    const stillExists = await businessRepository.findById(business._id);
    expect(stillExists?.status).toBe("APPROVED");
  });
});
