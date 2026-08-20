import express from "express";
import type { Types } from "mongoose";
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
import { BusinessOpeningHoursModel } from "../../../src/modules/business-hours/business-hours.model.js";
import { BusinessHoursRepository } from "../../../src/modules/business-hours/business-hours.repository.js";
import { createBusinessHoursRoute } from "../../../src/modules/business-hours/business-hours.route.js";
import { BusinessHoursService } from "../../../src/modules/business-hours/business-hours.service.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

type DbIndex = { name?: string; key: Record<string, unknown>; unique?: boolean };

const businessInput = (ownerUserId: import("mongoose").Types.ObjectId) => ({
  ownerUserId,
  name: "Sea Breeze Spa",
  ownerName: "Owner Name",
  email: "owner@example.com",
  phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
  visitType: "AT_BUSINESS_LOCATION" as const,
  address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
  briefDescription: "A great business",
  category: "Wellness",
  subcategories: ["Massage"],
});

describe("database-backed BusinessOpeningHours integration", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let businessHoursRepository: BusinessHoursRepository;
  let service: BusinessHoursService;
  let tokenService: TokenService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    businessHoursRepository = new BusinessHoursRepository();
    service = new BusinessHoursService(businessHoursRepository, businessRepository);
    tokenService = new TokenService(new SessionRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const createOwnerAndBusiness = async () => {
    const user = await userRepository.create({
      normalizedEmail: "owner@example.com",
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const business = await businessRepository.create(businessInput(user._id));
    return { user, business };
  };

  /** Mirrors business.route.ts's real auth + owner-only role gate, exactly as the module is
   * actually mounted in production (see business.route.ts: `router.use(authenticate,
   * requireActiveUser(), requireRoles(["BUSINESS_OWNER"]))` sits in front of every sub-router,
   * including createBusinessHoursRoute()). */
  const buildBusinessHoursApp = () => {
    const app = express();
    app.use(express.json());
    app.use(
      createAuthenticateAccessTokenMiddleware(tokenService, userRepository),
      requireActiveUser(),
      requireRoles(["BUSINESS_OWNER"]),
    );
    app.use("/businesses", createBusinessHoursRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF",
  ) => `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  it("enforces one BusinessOpeningHours document per Business at the database level", async () => {
    const indexes = (await BusinessOpeningHoursModel.collection.indexes()) as DbIndex[];
    expect(indexes.some((index) => index.key["businessId"] === 1 && index.unique === true)).toBe(
      true,
    );

    const { business } = await createOwnerAndBusiness();
    await BusinessOpeningHoursModel.create({ businessId: business._id, days: [] });

    await expect(
      BusinessOpeningHoursModel.create({ businessId: business._id, days: [] }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("a fresh Business has no opening-hours document — never fabricated as always-open", async () => {
    const { business } = await createOwnerAndBusiness();
    const found = await BusinessOpeningHoursModel.findOne({ businessId: business._id }).exec();
    expect(found).toBeNull();

    const dto = await service.getOpeningHours(String(business.ownerUserId), String(business._id));
    expect(dto).toEqual({ businessId: String(business._id), configured: false, days: [] });
  });

  it("persists a real weekly schedule with multiple slots on one day, end to end", async () => {
    const { business } = await createOwnerAndBusiness();

    await service.putOpeningHours(String(business.ownerUserId), String(business._id), [
      {
        dayOfWeek: "MONDAY",
        isOpen: true,
        slots: [
          { startTime: "09:00", endTime: "13:00" },
          { startTime: "15:00", endTime: "19:00" },
        ],
      },
      { dayOfWeek: "SUNDAY", isOpen: false, slots: [] },
    ]);

    const stored = await BusinessOpeningHoursModel.findOne({ businessId: business._id }).orFail();
    const monday = stored.days.find((day) => day.dayOfWeek === "MONDAY");
    expect(monday?.slots).toHaveLength(2);

    const dto = await service.getOpeningHours(String(business.ownerUserId), String(business._id));
    expect(dto.configured).toBe(true);
  });

  it("rejects an open day with zero slots at the Mongoose layer (defense in depth beyond Zod)", async () => {
    const { business } = await createOwnerAndBusiness();

    await expect(
      BusinessOpeningHoursModel.create({
        businessId: business._id,
        days: [{ dayOfWeek: "MONDAY", isOpen: true, slots: [] }],
      }),
    ).rejects.toThrow();
  });

  it("rejects a closed day that still carries slots at the Mongoose layer", async () => {
    const { business } = await createOwnerAndBusiness();

    await expect(
      BusinessOpeningHoursModel.create({
        businessId: business._id,
        days: [
          {
            dayOfWeek: "TUESDAY",
            isOpen: false,
            slots: [{ startTime: "09:00", endTime: "12:00" }],
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it("rejects a slot where start does not precede end at the Mongoose layer", async () => {
    const { business } = await createOwnerAndBusiness();

    await expect(
      BusinessOpeningHoursModel.create({
        businessId: business._id,
        days: [
          {
            dayOfWeek: "WEDNESDAY",
            isOpen: true,
            slots: [{ startTime: "12:00", endTime: "09:00" }],
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it("Supervisor and BusinessAccess-linked users cannot write opening hours (owner-only, no Supervisor/linked grant)", async () => {
    const { business } = await createOwnerAndBusiness();
    const otherUser = await userRepository.create({
      normalizedEmail: "supervisor@example.com",
      passwordHash: "hash",
      role: "SUPERVISOR",
      status: "ACTIVE",
    });

    await expect(
      service.putOpeningHours(String(otherUser._id), String(business._id), [
        { dayOfWeek: "MONDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "17:00" }] },
      ]),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.getOpeningHours(String(otherUser._id), String(business._id)),
    ).rejects.toMatchObject({ statusCode: 404 });

    // Confirms the write never happened.
    expect(await BusinessOpeningHoursModel.countDocuments({ businessId: business._id })).toBe(0);
  });

  // --- Real HTTP boundary (auth middleware + role gate + Zod + route mounting) --------------

  it("a Business Owner can GET and PUT opening hours through the real HTTP route", async () => {
    const { user, business } = await createOwnerAndBusiness();
    const app = buildBusinessHoursApp();
    const token = await bearerFor(user._id, "BUSINESS_OWNER");

    const notConfigured = await request(app)
      .get(`/businesses/${business._id}/opening-hours`)
      .set("Authorization", token);
    expect(notConfigured.status).toBe(200);
    expect(notConfigured.body.data).toMatchObject({ configured: false, days: [] });

    const put = await request(app)
      .put(`/businesses/${business._id}/opening-hours`)
      .set("Authorization", token)
      .send({
        days: [
          { dayOfWeek: "MONDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "17:00" }] },
        ],
      });
    expect(put.status).toBe(200);
    expect(put.body.data.configured).toBe(true);

    const getAfter = await request(app)
      .get(`/businesses/${business._id}/opening-hours`)
      .set("Authorization", token);
    expect(getAfter.body.data.days).toHaveLength(1);
  });

  it("rejects a SUPERVISOR at the router's blanket owner-only gate before the service is ever reached", async () => {
    const { business } = await createOwnerAndBusiness();
    const supervisorUser = await userRepository.create({
      normalizedEmail: "supervisor@example.com",
      passwordHash: "hash",
      role: "SUPERVISOR",
      status: "ACTIVE",
    });
    const app = buildBusinessHoursApp();
    const token = await bearerFor(supervisorUser._id, "SUPERVISOR");

    const response = await request(app)
      .put(`/businesses/${business._id}/opening-hours`)
      .set("Authorization", token)
      .send({ days: [] });

    // 403 (PORTAL_MISMATCH from requireRoles), not the service's 404 — proves this is rejected
    // by business.route.ts's router-wide gate, one layer before BusinessHoursService is called.
    expect(response.status).toBe(403);
  });

  it("rejects a request with no Authorization header at all", async () => {
    const { business } = await createOwnerAndBusiness();
    const app = buildBusinessHoursApp();

    const response = await request(app).get(`/businesses/${business._id}/opening-hours`);
    expect(response.status).toBe(401);
  });

  it("rejects malformed bodies at the Zod boundary: bad time format, open day with no slots, duplicate day", async () => {
    const { user, business } = await createOwnerAndBusiness();
    const app = buildBusinessHoursApp();
    const token = await bearerFor(user._id, "BUSINESS_OWNER");

    const badTime = await request(app)
      .put(`/businesses/${business._id}/opening-hours`)
      .set("Authorization", token)
      .send({
        days: [
          { dayOfWeek: "MONDAY", isOpen: true, slots: [{ startTime: "9am", endTime: "17:00" }] },
        ],
      });
    expect(badTime.status).toBe(400);

    const emptySlots = await request(app)
      .put(`/businesses/${business._id}/opening-hours`)
      .set("Authorization", token)
      .send({ days: [{ dayOfWeek: "MONDAY", isOpen: true, slots: [] }] });
    expect(emptySlots.status).toBe(400);

    const duplicateDay = await request(app)
      .put(`/businesses/${business._id}/opening-hours`)
      .set("Authorization", token)
      .send({
        days: [
          { dayOfWeek: "MONDAY", isOpen: false, slots: [] },
          { dayOfWeek: "MONDAY", isOpen: false, slots: [] },
        ],
      });
    expect(duplicateDay.status).toBe(400);

    expect(await BusinessOpeningHoursModel.countDocuments({ businessId: business._id })).toBe(0);
  });

  it("rejects unknown/injected fields via the strict Zod schema", async () => {
    const { user, business } = await createOwnerAndBusiness();
    const app = buildBusinessHoursApp();
    const token = await bearerFor(user._id, "BUSINESS_OWNER");

    const response = await request(app)
      .put(`/businesses/${business._id}/opening-hours`)
      .set("Authorization", token)
      .send({ days: [], businessId: "000000000000000000000000", ownerUserId: "attacker" });

    expect(response.status).toBe(400);
  });
});
