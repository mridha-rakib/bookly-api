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
import type { CancellationTierRule } from "../../../src/modules/business-cancellation-policy/business-cancellation-policy.model.js";
import { BusinessCancellationPolicyModel } from "../../../src/modules/business-cancellation-policy/business-cancellation-policy.model.js";
import { BusinessCancellationPolicyRepository } from "../../../src/modules/business-cancellation-policy/business-cancellation-policy.repository.js";
import { createBusinessCancellationPolicyRoute } from "../../../src/modules/business-cancellation-policy/business-cancellation-policy.route.js";
import { BusinessCancellationPolicyService } from "../../../src/modules/business-cancellation-policy/business-cancellation-policy.service.js";
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

const fullValidTiers = (): CancellationTierRule[] => [
  { tier: "MORE_THAN_72_HOURS", mode: "FREE" },
  { tier: "BETWEEN_24_AND_72_HOURS", mode: "FREE" },
  { tier: "BETWEEN_12_AND_24_HOURS", mode: "PERCENTAGE", percentage: 50 },
  { tier: "BETWEEN_2_AND_12_HOURS", mode: "PERCENTAGE", percentage: 75 },
  { tier: "UNDER_2_HOURS", mode: "PERCENTAGE", percentage: 100 },
];

describe("database-backed BusinessCancellationPolicy integration", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let cancellationPolicyRepository: BusinessCancellationPolicyRepository;
  let service: BusinessCancellationPolicyService;
  let tokenService: TokenService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    cancellationPolicyRepository = new BusinessCancellationPolicyRepository();
    service = new BusinessCancellationPolicyService(
      cancellationPolicyRepository,
      businessRepository,
    );
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
   * actually mounted in production. */
  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use(
      createAuthenticateAccessTokenMiddleware(tokenService, userRepository),
      requireActiveUser(),
      requireRoles(["BUSINESS_OWNER"]),
    );
    app.use("/businesses", createBusinessCancellationPolicyRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF",
  ) => `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  it("enforces one BusinessCancellationPolicy document per Business at the database level", async () => {
    const indexes = (await BusinessCancellationPolicyModel.collection.indexes()) as DbIndex[];
    expect(indexes.some((index) => index.key["businessId"] === 1 && index.unique === true)).toBe(
      true,
    );

    const { business } = await createOwnerAndBusiness();
    await BusinessCancellationPolicyModel.create({
      businessId: business._id,
      tiers: fullValidTiers(),
      noShowPercentage: 20,
    });

    await expect(
      BusinessCancellationPolicyModel.create({
        businessId: business._id,
        tiers: fullValidTiers(),
        noShowPercentage: 20,
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("a fresh Business has no cancellation policy document — never fabricated as a default fee", async () => {
    const { business } = await createOwnerAndBusiness();
    const found = await BusinessCancellationPolicyModel.findOne({
      businessId: business._id,
    }).exec();
    expect(found).toBeNull();

    const dto = await service.getPolicy(String(business.ownerUserId), String(business._id));
    expect(dto).toEqual({ businessId: String(business._id), configured: false, tiers: [] });
  });

  it("persists a real five-window policy end to end, canonically ordered on read", async () => {
    const { business } = await createOwnerAndBusiness();

    await service.putPolicy(String(business.ownerUserId), String(business._id), {
      tiers: fullValidTiers(),
      noShowPercentage: 25,
    });

    const stored = await BusinessCancellationPolicyModel.findOne({
      businessId: business._id,
    }).orFail();
    expect(stored.tiers).toHaveLength(5);
    expect(stored.noShowPercentage).toBe(25);

    const dto = await service.getPolicy(String(business.ownerUserId), String(business._id));
    expect(dto.configured).toBe(true);
    expect(dto.tiers.map((rule) => rule.tier)).toEqual([
      "MORE_THAN_72_HOURS",
      "BETWEEN_24_AND_72_HOURS",
      "BETWEEN_12_AND_24_HOURS",
      "BETWEEN_2_AND_12_HOURS",
      "UNDER_2_HOURS",
    ]);
  });

  it("rejects a percentage below the 20% floor at the Mongoose layer (defense in depth beyond Zod)", async () => {
    const { business } = await createOwnerAndBusiness();
    const tiers: CancellationTierRule[] = fullValidTiers().map((rule) =>
      rule.tier === "UNDER_2_HOURS"
        ? { tier: rule.tier, mode: "PERCENTAGE" as const, percentage: 19 }
        : rule,
    );

    await expect(
      BusinessCancellationPolicyModel.create({
        businessId: business._id,
        tiers,
        noShowPercentage: 20,
      }),
    ).rejects.toThrow();
  });

  it("rejects a percentage above 100 at the Mongoose layer", async () => {
    const { business } = await createOwnerAndBusiness();
    const tiers: CancellationTierRule[] = fullValidTiers().map((rule) =>
      rule.tier === "UNDER_2_HOURS"
        ? { tier: rule.tier, mode: "PERCENTAGE" as const, percentage: 101 }
        : rule,
    );

    await expect(
      BusinessCancellationPolicyModel.create({
        businessId: business._id,
        tiers,
        noShowPercentage: 20,
      }),
    ).rejects.toThrow();
  });

  it("rejects a FREE tier that also carries a percentage, and a PERCENTAGE tier with none, at the Mongoose layer", async () => {
    const { business } = await createOwnerAndBusiness();

    await expect(
      BusinessCancellationPolicyModel.create({
        businessId: business._id,
        tiers: fullValidTiers().map((rule) =>
          rule.tier === "MORE_THAN_72_HOURS" ? { ...rule, percentage: 25 } : rule,
        ),
        noShowPercentage: 20,
      }),
    ).rejects.toThrow();

    await expect(
      BusinessCancellationPolicyModel.create({
        businessId: business._id,
        tiers: fullValidTiers().map((rule) => {
          if (rule.tier === "UNDER_2_HOURS") {
            const { percentage: _percentage, ...rest } = rule;
            return rest;
          }
          return rule;
        }),
        noShowPercentage: 20,
      }),
    ).rejects.toThrow();
  });

  it("rejects a policy missing one of the five required windows at the Mongoose layer", async () => {
    const { business } = await createOwnerAndBusiness();

    await expect(
      BusinessCancellationPolicyModel.create({
        businessId: business._id,
        tiers: fullValidTiers().slice(0, 4),
        noShowPercentage: 20,
      }),
    ).rejects.toThrow();
  });

  it("Supervisor and other non-owner users cannot read or write the cancellation policy (owner-only)", async () => {
    const { business } = await createOwnerAndBusiness();
    const otherUser = await userRepository.create({
      normalizedEmail: "supervisor@example.com",
      passwordHash: "hash",
      role: "SUPERVISOR",
      status: "ACTIVE",
    });

    await expect(
      service.putPolicy(String(otherUser._id), String(business._id), {
        tiers: fullValidTiers(),
        noShowPercentage: 20,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.getPolicy(String(otherUser._id), String(business._id)),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(await BusinessCancellationPolicyModel.countDocuments({ businessId: business._id })).toBe(
      0,
    );
  });

  // --- Real HTTP boundary (auth middleware + role gate + Zod + route mounting) --------------

  it("a Business Owner can GET and PUT the cancellation policy through the real HTTP route", async () => {
    const { user, business } = await createOwnerAndBusiness();
    const app = buildApp();
    const token = await bearerFor(user._id, "BUSINESS_OWNER");

    const notConfigured = await request(app)
      .get(`/businesses/${business._id}/cancellation-policy`)
      .set("Authorization", token);
    expect(notConfigured.status).toBe(200);
    expect(notConfigured.body.data).toMatchObject({ configured: false, tiers: [] });

    const put = await request(app)
      .put(`/businesses/${business._id}/cancellation-policy`)
      .set("Authorization", token)
      .send({ tiers: fullValidTiers(), noShowPercentage: 30 });
    expect(put.status).toBe(200);
    expect(put.body.data.configured).toBe(true);
    expect(put.body.data.noShowPercentage).toBe(30);

    const getAfter = await request(app)
      .get(`/businesses/${business._id}/cancellation-policy`)
      .set("Authorization", token);
    expect(getAfter.body.data.tiers).toHaveLength(5);
  });

  it("rejects a SUPERVISOR at the router's blanket owner-only gate before the service is ever reached", async () => {
    const { business } = await createOwnerAndBusiness();
    const supervisorUser = await userRepository.create({
      normalizedEmail: "supervisor@example.com",
      passwordHash: "hash",
      role: "SUPERVISOR",
      status: "ACTIVE",
    });
    const app = buildApp();
    const token = await bearerFor(supervisorUser._id, "SUPERVISOR");

    const response = await request(app)
      .put(`/businesses/${business._id}/cancellation-policy`)
      .set("Authorization", token)
      .send({ tiers: fullValidTiers(), noShowPercentage: 20 });

    expect(response.status).toBe(403);
  });

  it("rejects a request with no Authorization header at all", async () => {
    const { business } = await createOwnerAndBusiness();
    const app = buildApp();

    const response = await request(app).get(`/businesses/${business._id}/cancellation-policy`);
    expect(response.status).toBe(401);
  });

  it("rejects malformed bodies at the Zod boundary before touching the database: sub-20% percentage, missing window, mode/percentage mismatch", async () => {
    const { user, business } = await createOwnerAndBusiness();
    const app = buildApp();
    const token = await bearerFor(user._id, "BUSINESS_OWNER");

    const belowFloor = await request(app)
      .put(`/businesses/${business._id}/cancellation-policy`)
      .set("Authorization", token)
      .send({
        tiers: fullValidTiers().map((rule) =>
          rule.tier === "UNDER_2_HOURS"
            ? { tier: rule.tier, mode: "PERCENTAGE", percentage: 15 }
            : rule,
        ),
        noShowPercentage: 20,
      });
    expect(belowFloor.status).toBe(400);

    const missingWindow = await request(app)
      .put(`/businesses/${business._id}/cancellation-policy`)
      .set("Authorization", token)
      .send({ tiers: fullValidTiers().slice(0, 4), noShowPercentage: 20 });
    expect(missingWindow.status).toBe(400);

    const modeMismatch = await request(app)
      .put(`/businesses/${business._id}/cancellation-policy`)
      .set("Authorization", token)
      .send({
        tiers: fullValidTiers().map((rule) =>
          rule.tier === "MORE_THAN_72_HOURS"
            ? { tier: rule.tier, mode: "FREE", percentage: 25 }
            : rule,
        ),
        noShowPercentage: 20,
      });
    expect(modeMismatch.status).toBe(400);

    const belowFloorNoShow = await request(app)
      .put(`/businesses/${business._id}/cancellation-policy`)
      .set("Authorization", token)
      .send({ tiers: fullValidTiers(), noShowPercentage: 10 });
    expect(belowFloorNoShow.status).toBe(400);

    expect(await BusinessCancellationPolicyModel.countDocuments({ businessId: business._id })).toBe(
      0,
    );
  });

  it("rejects unknown/injected fields via the strict Zod schema", async () => {
    const { user, business } = await createOwnerAndBusiness();
    const app = buildApp();
    const token = await bearerFor(user._id, "BUSINESS_OWNER");

    const response = await request(app)
      .put(`/businesses/${business._id}/cancellation-policy`)
      .set("Authorization", token)
      .send({
        tiers: fullValidTiers(),
        noShowPercentage: 20,
        businessId: "000000000000000000000000",
        depositCents: 500,
      });

    expect(response.status).toBe(400);
  });
});
