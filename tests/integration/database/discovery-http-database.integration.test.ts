import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
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
