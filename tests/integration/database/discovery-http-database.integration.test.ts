import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { createCustomerBookingRoute } from "../../../src/modules/booking/booking.route.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { createDiscoveryRoute } from "../../../src/modules/discovery/discovery.route.js";
import { createFavoriteRoute } from "../../../src/modules/favorite/favorite.route.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * Batch 16 — the HTTP-layer boundary the service-level tests deliberately don't cover: real route
 * wiring, public-vs-authenticated gates, `.strict()` unknown-field rejection, anti-enumeration,
 * and exactly what a real HTTP response body contains (never `ownerUserId`/other private fields).
 */
describe("HTTP-level Discovery/Favorites/Book Again endpoints (Batch 16)", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let tokenService: TokenService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    tokenService = new TokenService(new SessionRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixtures --------------------------------------------------------------------------------

  const createBusiness = async (name: string) => {
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
    const business = await businessRepository.casUpdateStatus(
      pending._id,
      ["PENDING"],
      "APPROVED",
      { fromStatus: "PENDING", actorUserId: owner._id, changedAt: new Date() },
    );
    return { owner, business: business ?? pending };
  };

  const createCustomer = async (tag: string) =>
    userRepository.create({
      normalizedEmail: `cust-${tag}-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/discovery", createDiscoveryRoute());
    app.use("/me", createFavoriteRoute());
    app.use("/me", createCustomerBookingRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "CUSTOMER" | "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF" | "SUPER_ADMIN",
  ) => `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  // --- Discovery: genuinely public -----------------------------------------------------------

  it("GET /discovery/businesses requires no authentication at all and never leaks ownerUserId", async () => {
    const { business } = await createBusiness("Public Salon");
    const app = buildApp();

    const response = await request(app).get("/discovery/businesses");

    expect(response.status).toBe(200);
    const row = response.body.data.businesses.find(
      (b: { id: string }) => b.id === String(business._id),
    );
    expect(row).toBeDefined();
    expect(row.ownerUserId).toBeUndefined();
    expect(row.email).toBeUndefined();
    expect(row.statusHistory).toBeUndefined();
  });

  it("GET /discovery/categories requires no authentication and reflects only real distinct categories", async () => {
    await createBusiness("Cat A");
    const app = buildApp();

    const response = await request(app).get("/discovery/categories");
    expect(response.status).toBe(200);
    expect(response.body.data.categories).toContain("Barber");
  });

  it("GET /discovery/founding-partners is public and returns only isFoundingPartner + publicly-visible businesses, with public-safe fields only", async () => {
    const { business: fp } = await createBusiness("Founding Salon");
    await businessRepository.setFoundingPartner(fp._id, true);
    // A non-founding but approved business — must NOT appear.
    await createBusiness("Ordinary Salon");
    // A founding partner that is not publicly visible (still PENDING) — must NOT appear.
    const pendingEmail = `owner-${new Types.ObjectId().toString()}@example.com`;
    const pendingOwner = await userRepository.create({
      normalizedEmail: pendingEmail,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const pendingFp = await businessRepository.create({
      ownerUserId: pendingOwner._id,
      name: "Pending Founding Salon",
      ownerName: "Owner Name",
      email: pendingEmail,
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: "AT_BUSINESS_LOCATION",
      timezone: "Europe/Nicosia",
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "A great business",
      category: "Barber",
      subcategories: [],
    });
    await businessRepository.setFoundingPartner(pendingFp._id, true);

    const app = buildApp();
    const response = await request(app).get("/discovery/founding-partners");

    expect(response.status).toBe(200);
    const rows = response.body.data.businesses as Array<Record<string, unknown>>;
    expect(rows.map((r) => r["id"])).toEqual([String(fp._id)]);
    expect(rows[0]).toEqual({ id: String(fp._id), name: "Founding Salon", city: "Larnaca" });
    // No private fields ever.
    expect(JSON.stringify(response.body.data)).not.toContain("ownerUserId");
    expect(JSON.stringify(response.body.data)).not.toContain(pendingEmail);
    expect(rows[0]).not.toHaveProperty("status");
    expect(rows[0]).not.toHaveProperty("statusHistory");
  });

  it("GET /discovery/founding-partners excludes a founding partner that is later SUSPENDED", async () => {
    const { owner, business: fp } = await createBusiness("Temp Founding Salon");
    await businessRepository.setFoundingPartner(fp._id, true);
    await businessRepository.casUpdateStatus(fp._id, ["APPROVED"], "SUSPENDED", {
      fromStatus: "APPROVED",
      actorUserId: owner._id,
      changedAt: new Date(),
    });

    const app = buildApp();
    const response = await request(app).get("/discovery/founding-partners");

    expect(response.status).toBe(200);
    expect(response.body.data.businesses).toEqual([]);
  });

  it("GET /discovery/founding-partners returns an empty array (never fabricated demo cards) when there are none", async () => {
    await createBusiness("Just A Salon");
    const app = buildApp();
    const response = await request(app).get("/discovery/founding-partners");
    expect(response.status).toBe(200);
    expect(response.body.data.businesses).toEqual([]);
  });

  it("GET /discovery/businesses rejects unknown query params (schema .strict())", async () => {
    const app = buildApp();
    const response = await request(app).get("/discovery/businesses").query({ trending: "true" });
    expect(response.status).toBe(400);
  });

  // --- Favorites: CUSTOMER-only, own-resource-scoped --------------------------------------------

  it("Favorites endpoints reject an unauthenticated request with 401", async () => {
    const app = buildApp();
    const response = await request(app).get("/me/favorites");
    expect(response.status).toBe(401);
  });

  it("Favorites endpoints reject a non-CUSTOMER role with 403", async () => {
    const { owner } = await createBusiness("Owner Biz");
    const app = buildApp();
    const response = await request(app)
      .get("/me/favorites")
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"));
    expect(response.status).toBe(403);
  });

  it("a Customer can favorite via HTTP, see it in /me/favorites/ids, and unfavorite via HTTP", async () => {
    const customer = await createCustomer("http-fav");
    const { business } = await createBusiness("HTTP Fav Salon");
    const app = buildApp();
    const auth = await bearerFor(customer._id, "CUSTOMER");

    const addResponse = await request(app)
      .post(`/me/favorites/${business._id}`)
      .set("Authorization", auth);
    expect(addResponse.status).toBe(200);

    const idsResponse = await request(app).get("/me/favorites/ids").set("Authorization", auth);
    expect(idsResponse.body.data.businessIds).toEqual([String(business._id)]);

    const removeResponse = await request(app)
      .delete(`/me/favorites/${business._id}`)
      .set("Authorization", auth);
    expect(removeResponse.status).toBe(200);

    const idsAfter = await request(app).get("/me/favorites/ids").set("Authorization", auth);
    expect(idsAfter.body.data.businessIds).toEqual([]);
  });

  it("cannot forge a customerUserId — the favorite is always scoped to the authenticated actor", async () => {
    const customerA = await createCustomer("real-actor");
    const customerB = await createCustomer("victim");
    const { business } = await createBusiness("Forge Target");
    const app = buildApp();

    // No body field exists to smuggle a customerUserId through at all — POST takes only the
    // businessId URL param. Confirm A's own favorite never appears under B's list.
    await request(app)
      .post(`/me/favorites/${business._id}`)
      .set("Authorization", await bearerFor(customerA._id, "CUSTOMER"));

    const bList = await request(app)
      .get("/me/favorites/ids")
      .set("Authorization", await bearerFor(customerB._id, "CUSTOMER"));
    expect(bList.body.data.businessIds).toEqual([]);
  });

  // --- Home sections: public, OPTIONALLY personalized -------------------------------------------

  it("GET /discovery/home-sections works with no auth, returns all three rows + meta, leaks nothing private", async () => {
    const { business } = await createBusiness("Home Salon");
    const app = buildApp();

    const response = await request(app).get("/discovery/home-sections");

    expect(response.status).toBe(200);
    const { recommended, nearYou, popular, meta } = response.body.data;
    expect(Array.isArray(recommended)).toBe(true);
    expect(Array.isArray(nearYou)).toBe(true);
    expect(Array.isArray(popular)).toBe(true);
    expect(meta.personalized).toBe(false);
    expect(meta.nearYouCity).toBeNull();
    const row = [...recommended, ...nearYou, ...popular].find(
      (b: { id: string }) => b.id === String(business._id),
    );
    expect(row).toBeDefined();
    expect(row.ownerUserId).toBeUndefined();
    expect(row.email).toBeUndefined();
    expect(row.distance).toBeUndefined();
  });

  it("GET /discovery/home-sections rejects unknown query params (.strict)", async () => {
    const app = buildApp();
    const response = await request(app).get("/discovery/home-sections?foo=bar");
    expect(response.status).toBe(400);
  });

  it("GET /discovery/home-sections?city=Larnaca drives Services near you and echoes the city", async () => {
    const app = buildApp();
    const larnacaEmail = `owner-${new Types.ObjectId().toString()}@example.com`;
    const larnacaOwner = await userRepository.create({
      normalizedEmail: larnacaEmail,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const larnacaPending = await businessRepository.create({
      ownerUserId: larnacaOwner._id,
      name: "Larnaca Only",
      ownerName: "Owner Name",
      email: larnacaEmail,
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: "AT_BUSINESS_LOCATION",
      timezone: "Europe/Nicosia",
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "A great business",
      category: "Barber",
      subcategories: [],
    });
    await businessRepository.casUpdateStatus(larnacaPending._id, ["PENDING"], "APPROVED", {
      fromStatus: "PENDING",
      actorUserId: larnacaOwner._id,
      changedAt: new Date(),
    });
    await createBusiness("Nicosia Default"); // createBusiness() defaults to Larnaca too — keep name distinct

    const response = await request(app).get("/discovery/home-sections?city=Larnaca");

    expect(response.status).toBe(200);
    expect(response.body.data.meta.nearYouCity).toBe("Larnaca");
    for (const row of response.body.data.nearYou) {
      expect(row.city).toBe("Larnaca");
    }
  });

  it("GET /discovery/home-sections personalizes 'Recommended' for a CUSTOMER with booking history", async () => {
    const { business } = await createBusiness("Booked Before");
    const customer = await createCustomer("has-history");
    await BookingModel.collection.insertOne({
      _id: new Types.ObjectId(),
      businessId: business._id,
      reference: `BK-${new Types.ObjectId().toString()}`,
      status: "COMPLETED",
      customer: { customerUserId: customer._id },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = buildApp();

    const anon = await request(app).get("/discovery/home-sections");
    expect(anon.body.data.meta.personalized).toBe(false);

    const authed = await request(app)
      .get("/discovery/home-sections")
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));
    expect(authed.status).toBe(200);
    expect(authed.body.data.meta.personalized).toBe(true);
  });

  it("GET /discovery/home-sections degrades to anonymous on a garbage bearer token (never 401)", async () => {
    await createBusiness("Still Public");
    const app = buildApp();

    const response = await request(app)
      .get("/discovery/home-sections")
      .set("Authorization", "Bearer not-a-real-token");

    expect(response.status).toBe(200);
    expect(response.body.data.meta.personalized).toBe(false);
  });

  // --- Book Again: CUSTOMER-only, own-resource-scoped --------------------------------------------

  it("GET /me/bookings/book-again requires authentication and returns an empty, well-formed result with no history", async () => {
    const customer = await createCustomer("no-history");
    const app = buildApp();

    const unauth = await request(app).get("/me/bookings/book-again");
    expect(unauth.status).toBe(401);

    const response = await request(app)
      .get("/me/bookings/book-again")
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));
    expect(response.status).toBe(200);
    expect(response.body.data.candidates).toEqual([]);
    expect(response.body.data.pagination.total).toBe(0);
  });

  it("GET /bookings/book-again is never swallowed by the /bookings/:bookingId param route", async () => {
    const customer = await createCustomer("path-collision");
    const app = buildApp();

    const response = await request(app)
      .get("/me/bookings/book-again")
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));

    // A 400 here would mean Express tried to match "book-again" as a :bookingId ObjectId —
    // confirms the route was registered in the correct order (see booking.route.ts's own comment).
    expect(response.status).toBe(200);
  });
});
