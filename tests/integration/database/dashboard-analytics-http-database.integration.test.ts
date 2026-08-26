import express, { Router } from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../../../src/modules/auth/auth.middleware.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { createDashboardAnalyticsRoute } from "../../../src/modules/dashboard-analytics/dashboard-analytics.route.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const TIMEZONE = "Europe/Nicosia";

/**
 * HTTP-level authorization boundary for the Dashboard Analytics route — mirrors
 * dashboard-overview-http-database.integration.test.ts's own rationale: service-level tests
 * already cover the scoping/aggregation logic (see
 * dashboard-analytics-database.integration.test.ts); this file exercises the real
 * `requireRoles`/`authenticate` chain this route is actually mounted behind.
 *
 * createDashboardAnalyticsRoute() carries NO auth middleware of its own (see its own comment —
 * it is mounted INSIDE business.route.ts, underneath that router's blanket
 * `requireRoles(["BUSINESS_OWNER"])` gate, exactly like createFinanceRoute()). This test
 * reconstructs that exact gate (authenticate + requireActiveUser + requireRoles(["BUSINESS_
 * OWNER"])) in front of it, rather than pulling in the full createBusinessRoute() (which wires
 * up unrelated storage/email-OTP dependencies this test has no need of).
 */
describe("HTTP-level Dashboard Analytics authorization", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let staffRepository: StaffRepository;
  let tokenService: TokenService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    staffRepository = new StaffRepository();
    tokenService = new TokenService(new SessionRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const createBusiness = async () => {
    const owner = await userRepository.create({
      normalizedEmail: `owner-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const business = await businessRepository.create({
      ownerUserId: owner._id,
      name: "Ledra Barbers",
      ownerName: "Owner Name",
      email: owner.normalizedEmail,
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: "AT_BUSINESS_LOCATION",
      timezone: TIMEZONE,
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "A great business",
      category: "Barber",
      subcategories: ["Haircut"],
    });
    return { owner, business };
  };

  const createStaff = async (
    businessId: Types.ObjectId,
    role: "STAFF" | "SUPERVISOR" = "STAFF",
  ) => {
    const user = await userRepository.create({
      normalizedEmail: `staff-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role,
      status: "ACTIVE",
    });
    const membership = await staffRepository.create({
      userId: user._id,
      businessId,
      role,
      createdByUserId: user._id,
    });
    return { user, membership };
  };

  const buildApp = () => {
    const app = express();
    app.use(express.json());

    const authenticate = createAuthenticateAccessTokenMiddleware(tokenService, userRepository);
    const router = Router();
    // Reconstructs business.route.ts's own gate exactly (see this file's own top comment) —
    // never a looser/different gate than what Analytics is actually mounted behind in
    // production.
    router.use(authenticate, requireActiveUser(), requireRoles(["BUSINESS_OWNER"]));
    router.use(createDashboardAnalyticsRoute());

    app.use("/businesses", router);
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "CUSTOMER" | "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF",
  ) => `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  it("an Owner can read their own Business's Analytics via the real HTTP route", async () => {
    const { owner, business } = await createBusiness();
    const app = buildApp();

    const response = await request(app)
      .get(`/businesses/${business._id}/dashboard/analytics`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"));

    expect(response.status).toBe(200);
    expect(response.body.data.period).toBe("MONTH");
    expect(response.body.data.totalBookingsCount).toBe(0);
  });

  it("accepts an explicit ?period=YEAR/ALL query", async () => {
    const { owner, business } = await createBusiness();
    const app = buildApp();

    const yearResponse = await request(app)
      .get(`/businesses/${business._id}/dashboard/analytics?period=YEAR`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"));
    expect(yearResponse.status).toBe(200);
    expect(yearResponse.body.data.period).toBe("YEAR");

    const allResponse = await request(app)
      .get(`/businesses/${business._id}/dashboard/analytics?period=ALL`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"));
    expect(allResponse.status).toBe(200);
    expect(allResponse.body.data.period).toBe("ALL");
  });

  it("rejects a SUPERVISOR token — Analytics is Owner-only, unlike Dashboard Overview (403)", async () => {
    const { business } = await createBusiness();
    const { user: supervisor } = await createStaff(business._id, "SUPERVISOR");
    const app = buildApp();

    const response = await request(app)
      .get(`/businesses/${business._id}/dashboard/analytics`)
      .set("Authorization", await bearerFor(supervisor._id, "SUPERVISOR"));

    expect(response.status).toBe(403);
  });

  it("rejects a STAFF token (403)", async () => {
    const { business } = await createBusiness();
    const { user: staffUser } = await createStaff(business._id, "STAFF");
    const app = buildApp();

    const response = await request(app)
      .get(`/businesses/${business._id}/dashboard/analytics`)
      .set("Authorization", await bearerFor(staffUser._id, "STAFF"));

    expect(response.status).toBe(403);
  });

  it("rejects a CUSTOMER token outright (403)", async () => {
    const { business } = await createBusiness();
    const customer = await userRepository.create({
      normalizedEmail: `cust-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    const app = buildApp();

    const response = await request(app)
      .get(`/businesses/${business._id}/dashboard/analytics`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));

    expect(response.status).toBe(403);
  });

  it("rejects with no Authorization header at all (401)", async () => {
    const { business } = await createBusiness();
    const app = buildApp();

    const response = await request(app).get(`/businesses/${business._id}/dashboard/analytics`);

    expect(response.status).toBe(401);
  });

  it("an Owner of Business A cannot read Business B's Analytics by editing the URL businessId (anti-enumeration 404)", async () => {
    const { owner: ownerA } = await createBusiness();
    const { business: businessB } = await createBusiness();
    const app = buildApp();

    const response = await request(app)
      .get(`/businesses/${businessB._id}/dashboard/analytics`)
      .set("Authorization", await bearerFor(ownerA._id, "BUSINESS_OWNER"));

    expect(response.status).toBe(404);
  });
});
