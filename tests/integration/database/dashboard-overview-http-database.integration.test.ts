import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { createDashboardOverviewRoute } from "../../../src/modules/dashboard-overview/dashboard-overview.route.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import { buildBooking } from "../../unit/stage-b-fixtures.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const TIMEZONE = "Europe/Nicosia";

/**
 * HTTP-level authorization boundary for the Dashboard Overview route — mirrors
 * manual-booking-http-database.integration.test.ts's own rationale: service-level tests already
 * cover the scoping/aggregation logic (see dashboard-overview-database.integration.test.ts);
 * this file closes the gap of actually exercising `requireRoles`/`authenticate` through the real
 * Express route, including the roles (STAFF) no other route in this codebase has ever granted
 * before.
 */
describe("HTTP-level Dashboard Overview authorization", () => {
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
    app.use("/businesses", createDashboardOverviewRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "CUSTOMER" | "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF",
  ) => `Bearer ${await issueTestAccessToken(tokenService, { userId, role })}`;

  it("an Owner can read their own Business's Overview via the real HTTP route", async () => {
    const { owner, business } = await createBusiness();
    const app = buildApp();

    const response = await request(app)
      .get(`/businesses/${business._id}/dashboard/overview`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"));

    expect(response.status).toBe(200);
    expect(response.body.data.scope).toBe("FULL");
    expect(response.body.data.financials).toEqual(
      expect.objectContaining({
        monthlyRevenueCents: expect.any(Number),
        recentActivity: expect.any(Array),
      }),
    );
  });

  it("an active Supervisor receives operational overview without Owner financial aggregates", async () => {
    const { business } = await createBusiness();
    const { user: supervisor } = await createStaff(business._id, "SUPERVISOR");
    const app = buildApp();

    const response = await request(app)
      .get(`/businesses/${business._id}/dashboard/overview`)
      .set("Authorization", await bearerFor(supervisor._id, "SUPERVISOR"));

    expect(response.status).toBe(200);
    expect(response.body.data.scope).toBe("FULL");
    expect(response.body.data.financials).toBeNull();
    expect(response.body.data.noShowCount).toEqual(expect.any(Number));
    expect(response.body.data.schedule).toEqual(expect.any(Array));
    expect(response.body.data.timeline).toEqual(expect.any(Array));
  });

  it("a Staff member can read a scoped-down Overview of their own Business (no financials)", async () => {
    const { business } = await createBusiness();
    const { user: staffUser } = await createStaff(business._id, "STAFF");
    const app = buildApp();

    const response = await request(app)
      .get(`/businesses/${business._id}/dashboard/overview`)
      .set("Authorization", await bearerFor(staffUser._id, "STAFF"));

    expect(response.status).toBe(200);
    expect(response.body.data.scope).toBe("STAFF_SCOPED");
    expect(response.body.data.financials).toBeNull();
  });

  it("Staff overview exposes only assigned lines and no booking financial details", async () => {
    const { business } = await createBusiness();
    const me = await createStaff(business._id);
    const colleague = await createStaff(business._id);
    const booking = buildBooking({
      businessId: business._id,
      schedule: {
        timezone: TIMEZONE,
        startAt: new Date("2030-08-20T07:00:00Z"),
        endAt: new Date("2030-08-20T08:00:00Z"),
      },
    } as never);
    const original = booking.serviceLines[0]!;
    booking.serviceLines = [
      {
        ...original,
        responsibleStaffMembershipId: colleague.membership._id,
        serviceSnapshot: { ...original.serviceSnapshot, name: "Private colleague service" },
        staffSnapshot: { firstName: "Private", lastName: "Colleague" },
      },
      {
        ...original,
        responsibleStaffMembershipId: me.membership._id,
        serviceSnapshot: { ...original.serviceSnapshot, name: "My service" },
      },
    ];
    await BookingModel.collection.insertOne(booking as never);
    const unverified = buildBooking({
      businessId: business._id,
      reference: "BK-UNVERIFIED",
      schedule: {
        timezone: TIMEZONE,
        startAt: new Date("2030-08-20T09:00:00Z"),
        endAt: new Date("2030-08-20T10:00:00Z"),
      },
    } as never);
    unverified.serviceLines[0]!.responsibleStaffMembershipId = me.membership._id;
    unverified.serviceLines[0]!.pricingInput.packageItemId = new Types.ObjectId();
    await BookingModel.collection.insertOne(unverified as never);
    const response = await request(buildApp())
      .get(
        `/businesses/${business._id}/dashboard/overview?range=Custom&fromDate=2030-08-20&toDate=2030-08-20`,
      )
      .set("Authorization", await bearerFor(me.user._id, "STAFF"))
      .expect(200);
    expect(response.body.data.todayBookingsCount).toBe(1);
    expect(response.body.data.schedule[0].serviceName).toBe("My service");
    expect(response.body.data.timeline[0].detail).toBe("My service");
    expect(response.body.data.timeline[0].durationMin).toBe(original.serviceSnapshot.durationMin);
    const json = JSON.stringify(response.body.data);
    for (const forbidden of [
      "Private colleague",
      "totalPaymentCents",
      "platformFeeCents",
      "remainingFeeCents",
      "staffName",
      "leadType",
    ])
      expect(json).not.toContain(forbidden);
    expect(response.body.data.financials).toBeNull();
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
      .get(`/businesses/${business._id}/dashboard/overview`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));

    expect(response.status).toBe(403);
  });

  it("rejects with no Authorization header at all (401)", async () => {
    const { business } = await createBusiness();
    const app = buildApp();

    const response = await request(app).get(`/businesses/${business._id}/dashboard/overview`);

    expect(response.status).toBe(401);
  });

  it("an Owner of Business A cannot read Business B's Overview by editing the URL businessId (anti-enumeration 404)", async () => {
    const { owner: ownerA } = await createBusiness();
    const { business: businessB } = await createBusiness();
    const app = buildApp();

    const response = await request(app)
      .get(`/businesses/${businessB._id}/dashboard/overview`)
      .set("Authorization", await bearerFor(ownerA._id, "BUSINESS_OWNER"));

    expect(response.status).toBe(404);
  });
});
