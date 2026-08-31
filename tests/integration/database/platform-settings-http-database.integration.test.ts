import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import {
  DEPOSIT_MAX_CENTS,
  DEPOSIT_MIN_CENTS,
  DEPOSIT_PERCENT,
  NO_SHOW_RESOLUTION_WINDOW_MINUTES,
} from "../../../src/modules/booking/booking.types.js";
import {
  CANCELLATION_PERCENTAGE_MAX,
  CANCELLATION_PERCENTAGE_MIN,
} from "../../../src/modules/business-cancellation-policy/business-cancellation-policy.model.js";
import { businessCategoryKeys } from "../../../src/modules/platform-settings/business-category.js";
import {
  DEFAULT_MAX_SERVICES_PER_BOOKING,
  STRUCTURAL_MAX_SERVICES_PER_BOOKING,
} from "../../../src/modules/platform-settings/platform-settings.constants.js";
import { PlatformSettingsModel } from "../../../src/modules/platform-settings/platform-settings.model.js";
import { createPlatformConfigRoute } from "../../../src/modules/platform-settings/platform-settings.route.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { createSuperAdminRoute } from "../../../src/modules/super-admin/super-admin.route.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import type { UserRole } from "../../../src/modules/user/user.types.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * Batch 21 — Super Admin Platform Settings HTTP surface. Proves the SUPER_ADMIN authorization
 * boundary, that fixed rules are served from the real backend constants (not stored copies),
 * that editable fields persist across a fresh request, that lazy defaults never overwrite an
 * edit, and that the public booking-config endpoint mirrors the same limit anonymously.
 */
describe("HTTP-level Super Admin Platform Settings (Batch 21)", () => {
  let userRepository: UserRepository;
  let tokenService: TokenService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    tokenService = new TokenService(new SessionRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/super-admin", createSuperAdminRoute());
    app.use("/platform", createPlatformConfigRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (role: UserRole) => {
    const user = await userRepository.create({
      normalizedEmail: `${role.toLowerCase()}-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "x".repeat(40),
      role,
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
    });
    return `Bearer ${await tokenService.createAccessToken({ userId: user._id, role })}`;
  };

  it("rejects an unauthenticated GET with 401", async () => {
    const app = buildApp();
    await request(app).get("/super-admin/settings/platform").expect(401);
  });

  it("rejects a non-super-admin GET with 403", async () => {
    const app = buildApp();
    const bearer = await bearerFor("CUSTOMER");
    await request(app)
      .get("/super-admin/settings/platform")
      .set("Authorization", bearer)
      .expect(403);
  });

  it("super-admin GET returns fixed rules straight from the backend constants + default editable values", async () => {
    const app = buildApp();
    const bearer = await bearerFor("SUPER_ADMIN");

    const response = await request(app)
      .get("/super-admin/settings/platform")
      .set("Authorization", bearer)
      .expect(200);

    expect(response.body.data.fixed).toMatchObject({
      depositPercent: DEPOSIT_PERCENT,
      depositMinCents: DEPOSIT_MIN_CENTS,
      depositMaxCents: DEPOSIT_MAX_CENTS,
      cancellationPercentageMin: CANCELLATION_PERCENTAGE_MIN,
      cancellationPercentageMax: CANCELLATION_PERCENTAGE_MAX,
      noShowResolutionMinutes: NO_SHOW_RESOLUTION_WINDOW_MINUTES,
    });
    expect(response.body.data.editable.maxServicesPerBooking).toBe(
      DEFAULT_MAX_SERVICES_PER_BOOKING,
    );
    expect(response.body.data.editable.structuralMaxServicesPerBooking).toBe(
      STRUCTURAL_MAX_SERVICES_PER_BOOKING,
    );
    expect(response.body.data.editable.noShowCategoryWindows).toHaveLength(
      businessCategoryKeys.length,
    );
    // Truthful session info — the real env value, not a fabricated 90/180-day figure.
    expect(response.body.data.session.refreshTokenTtlDays).toBe(30);
  });

  it("PATCH persists maxServicesPerBooking and a fresh GET returns it", async () => {
    const app = buildApp();
    const bearer = await bearerFor("SUPER_ADMIN");

    await request(app)
      .patch("/super-admin/settings/platform")
      .set("Authorization", bearer)
      .send({ maxServicesPerBooking: 7 })
      .expect(200);

    const fresh = await request(app)
      .get("/super-admin/settings/platform")
      .set("Authorization", bearer)
      .expect(200);
    expect(fresh.body.data.editable.maxServicesPerBooking).toBe(7);

    // Lazy-default getOrCreate must NOT clobber the persisted edit.
    const doc = await PlatformSettingsModel.findOne({ key: "SINGLETON" }).lean();
    expect(doc?.maxServicesPerBooking).toBe(7);
  });

  it("PATCH persists a full category-window replacement and it survives a fresh request", async () => {
    const app = buildApp();
    const bearer = await bearerFor("SUPER_ADMIN");

    const base = await request(app)
      .get("/super-admin/settings/platform")
      .set("Authorization", bearer)
      .expect(200);

    const windows = base.body.data.editable.noShowCategoryWindows.map(
      (w: { categoryKey: string }) =>
        w.categoryKey === "AUTOMOTIVE"
          ? { categoryKey: w.categoryKey, opensAfterMinutes: 20, closesAfterMinutes: 200 }
          : w,
    );

    await request(app)
      .patch("/super-admin/settings/platform")
      .set("Authorization", bearer)
      .send({ noShowCategoryWindows: windows })
      .expect(200);

    const fresh = await request(app)
      .get("/super-admin/settings/platform")
      .set("Authorization", bearer)
      .expect(200);
    const automotive = fresh.body.data.editable.noShowCategoryWindows.find(
      (w: { categoryKey: string }) => w.categoryKey === "AUTOMOTIVE",
    );
    expect(automotive).toMatchObject({ opensAfterMinutes: 20, closesAfterMinutes: 200 });
  });

  it("rejects invalid maxServicesPerBooking (0, negative, above the structural ceiling, non-integer)", async () => {
    const app = buildApp();
    const bearer = await bearerFor("SUPER_ADMIN");

    for (const bad of [0, -3, STRUCTURAL_MAX_SERVICES_PER_BOOKING + 1, 2.5]) {
      await request(app)
        .patch("/super-admin/settings/platform")
        .set("Authorization", bearer)
        .send({ maxServicesPerBooking: bad })
        .expect(400);
    }
  });

  it("rejects invalid category windows (opens >= closes, missing a category, unknown key)", async () => {
    const app = buildApp();
    const bearer = await bearerFor("SUPER_ADMIN");

    const good = businessCategoryKeys.map((categoryKey) => ({
      categoryKey,
      opensAfterMinutes: 15,
      closesAfterMinutes: 120,
    }));

    // opens >= closes
    await request(app)
      .patch("/super-admin/settings/platform")
      .set("Authorization", bearer)
      .send({
        noShowCategoryWindows: good.map((w, i) =>
          i === 0 ? { ...w, opensAfterMinutes: 120, closesAfterMinutes: 120 } : w,
        ),
      })
      .expect(400);

    // missing one category (7 entries)
    await request(app)
      .patch("/super-admin/settings/platform")
      .set("Authorization", bearer)
      .send({ noShowCategoryWindows: good.slice(0, businessCategoryKeys.length - 1) })
      .expect(400);

    // unknown key
    await request(app)
      .patch("/super-admin/settings/platform")
      .set("Authorization", bearer)
      .send({
        noShowCategoryWindows: good.map((w, i) =>
          i === 0 ? { ...w, categoryKey: "NOT_A_CATEGORY" } : w,
        ),
      })
      .expect(400);
  });

  it("rejects an empty PATCH body (no updatable fields)", async () => {
    const app = buildApp();
    const bearer = await bearerFor("SUPER_ADMIN");
    await request(app)
      .patch("/super-admin/settings/platform")
      .set("Authorization", bearer)
      .send({})
      .expect(400);
  });

  it("the public booking-config endpoint is anonymous and mirrors the configured limit", async () => {
    const app = buildApp();
    const bearer = await bearerFor("SUPER_ADMIN");

    const before = await request(app).get("/platform/booking-config").expect(200);
    expect(before.body.data.maxServicesPerBooking).toBe(DEFAULT_MAX_SERVICES_PER_BOOKING);

    await request(app)
      .patch("/super-admin/settings/platform")
      .set("Authorization", bearer)
      .send({ maxServicesPerBooking: 9 })
      .expect(200);

    const after = await request(app).get("/platform/booking-config").expect(200);
    expect(after.body.data.maxServicesPerBooking).toBe(9);
  });
});
