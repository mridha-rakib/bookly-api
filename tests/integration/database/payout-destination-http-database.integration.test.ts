import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { Argon2PasswordHasher } from "../../../src/modules/auth/password-hasher.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { PayoutDestinationModel } from "../../../src/modules/payout-destination/payout-destination.model.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import type { UserRole } from "../../../src/modules/user/user.types.js";
import { createApiRouter } from "../../../src/routes/api-router.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const TIMEZONE = "Europe/Nicosia";

// SYNTHETIC, valid-checksum test IBANs only — never a real account number.
const IBAN_CY = "CY17002001280000001200527600";
const IBAN_DE = "DE89370400440532013000";
const IBAN_INVALID = "CY17002001280000001200527601";

const PASSWORD = "Correct-Horse-1";

/**
 * HTTP-level test for Business Payout Destination, mounting the REAL createApiRouter() (so the
 * real role gates, the real ownership check and the real Super Admin router are exercised, in
 * their real mount order) against a real database.
 */
describe("HTTP-level Business Payout Destination", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let tokenService: TokenService;
  let passwordHash: string;

  beforeAll(async () => {
    await connectIsolatedDatabase();
    passwordHash = await new Argon2PasswordHasher().hash(PASSWORD);
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

  const createOwnerAndBusiness = async (options: { oauthOnly?: boolean } = {}) => {
    const email = `owner-${new Types.ObjectId().toString()}@example.com`;
    const owner = await userRepository.create({
      normalizedEmail: email,
      ...(options.oauthOnly
        ? { authProviders: ["GOOGLE" as const] }
        : { passwordHash, authProviders: ["PASSWORD" as const] }),
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const business = await businessRepository.create({
      ownerUserId: owner._id,
      name: "Ledra Barbers",
      ownerName: "Owner Name",
      email,
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

  const createUser = async (role: UserRole) =>
    userRepository.create({
      normalizedEmail: `user-${new Types.ObjectId().toString()}@example.com`,
      passwordHash,
      role,
      status: "ACTIVE",
    });

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter({ getConnectionState: () => "connected" as const }));
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (userId: Types.ObjectId | string, role: UserRole) =>
    `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  const validBody = (iban = IBAN_CY) => ({
    accountHolderName: "Maria Georgiou",
    iban,
    bankName: "Bank of Cyprus",
    stepUp: { currentPassword: PASSWORD },
  });

  // --- Owner surface ---------------------------------------------------------------------------

  it("lets the owning BUSINESS_OWNER create, then read a masked destination", async () => {
    const { owner, business } = await createOwnerAndBusiness();
    const app = buildApp();
    const token = await bearerFor(owner._id, "BUSINESS_OWNER");

    const empty = await request(app)
      .get(`/api/v1/businesses/${business._id}/payout-destination`)
      .set("Authorization", token);
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual({ configured: false });

    const created = await request(app)
      .patch(`/api/v1/businesses/${business._id}/payout-destination`)
      .set("Authorization", token)
      .send(validBody());
    expect(created.status).toBe(200);

    const read = await request(app)
      .get(`/api/v1/businesses/${business._id}/payout-destination`)
      .set("Authorization", token);
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({
      configured: true,
      accountHolderName: "Maria Georgiou",
      ibanMasked: "CY••••••••7600",
      ibanLast4: "7600",
      ibanCountry: "CY",
      bankName: "Bank of Cyprus",
    });

    const serialized = JSON.stringify(read.body);
    expect(serialized).not.toContain(IBAN_CY);
    expect(serialized).not.toContain("ibanCiphertext");
    expect(serialized).not.toContain("ibanKeyVersion");
  });

  it("enforces one destination per Business — a second create updates in place", async () => {
    const { owner, business } = await createOwnerAndBusiness();
    const app = buildApp();
    const token = await bearerFor(owner._id, "BUSINESS_OWNER");

    await request(app)
      .patch(`/api/v1/businesses/${business._id}/payout-destination`)
      .set("Authorization", token)
      .send(validBody());
    const second = await request(app)
      .patch(`/api/v1/businesses/${business._id}/payout-destination`)
      .set("Authorization", token)
      .send(validBody(IBAN_DE));

    expect(second.status).toBe(200);
    expect(second.body.data.ibanLast4).toBe("3000");
    expect(await PayoutDestinationModel.countDocuments({ businessId: business._id })).toBe(1);

    const stored = await PayoutDestinationModel.findOne({ businessId: business._id }).exec();
    expect(stored?.history).toHaveLength(2);
    expect(stored?.history[0]?.action).toBe("CREATED");
    expect(stored?.history[1]).toMatchObject({
      action: "UPDATED",
      previousLast4: "7600",
      newLast4: "3000",
    });
    // Even a direct database read cannot return the secret fields without an explicit select.
    expect((stored as unknown as Record<string, unknown>)["ibanCiphertext"]).toBeUndefined();
  });

  it("rejects an invalid IBAN", async () => {
    const { owner, business } = await createOwnerAndBusiness();
    const app = buildApp();
    const token = await bearerFor(owner._id, "BUSINESS_OWNER");

    const response = await request(app)
      .patch(`/api/v1/businesses/${business._id}/payout-destination`)
      .set("Authorization", token)
      .send(validBody(IBAN_INVALID));

    expect(response.status).toBe(400);
    expect(await PayoutDestinationModel.countDocuments({})).toBe(0);
  });

  it("rejects backend-derived fields supplied by the client", async () => {
    const { owner, business } = await createOwnerAndBusiness();
    const app = buildApp();
    const token = await bearerFor(owner._id, "BUSINESS_OWNER");

    for (const extra of [
      { ibanLast4: "9999" },
      { ibanCountry: "XX" },
      { ibanKeyVersion: 1 },
      { history: [] },
      { businessId: String(new Types.ObjectId()) },
    ]) {
      const response = await request(app)
        .patch(`/api/v1/businesses/${business._id}/payout-destination`)
        .set("Authorization", token)
        .send({ ...validBody(), ...extra });
      expect(response.status).toBe(400);
    }
    expect(await PayoutDestinationModel.countDocuments({})).toBe(0);
  });

  it("rejects a wrong current password and leaves the stored destination untouched", async () => {
    const { owner, business } = await createOwnerAndBusiness();
    const app = buildApp();
    const token = await bearerFor(owner._id, "BUSINESS_OWNER");

    await request(app)
      .patch(`/api/v1/businesses/${business._id}/payout-destination`)
      .set("Authorization", token)
      .send(validBody());

    const response = await request(app)
      .patch(`/api/v1/businesses/${business._id}/payout-destination`)
      .set("Authorization", token)
      .send({ ...validBody(IBAN_DE), stepUp: { currentPassword: "wrong-password" } });

    expect(response.status).toBe(400);
    const stored = await PayoutDestinationModel.findOne({ businessId: business._id }).exec();
    expect(stored?.ibanLast4).toBe("7600");
    expect(stored?.history).toHaveLength(1);
  });

  it("requires OTP step-up for an OAuth-only owner (a password is not accepted)", async () => {
    const { owner, business } = await createOwnerAndBusiness({ oauthOnly: true });
    const app = buildApp();
    const token = await bearerFor(owner._id, "BUSINESS_OWNER");

    const withPassword = await request(app)
      .patch(`/api/v1/businesses/${business._id}/payout-destination`)
      .set("Authorization", token)
      .send(validBody());
    expect(withPassword.status).toBe(400);

    const withoutProof = await request(app)
      .patch(`/api/v1/businesses/${business._id}/payout-destination`)
      .set("Authorization", token)
      .send({ ...validBody(), stepUp: {} });
    expect(withoutProof.status).toBe(400);

    const fabricated = await request(app)
      .patch(`/api/v1/businesses/${business._id}/payout-destination`)
      .set("Authorization", token)
      .send({ ...validBody(), stepUp: { otpAuthorizationToken: "made-up" } });
    expect(fabricated.status).toBe(400);

    expect(await PayoutDestinationModel.countDocuments({})).toBe(0);
  });

  it("rejects the OTP step-up endpoints for a password account", async () => {
    const { owner, business } = await createOwnerAndBusiness();
    const app = buildApp();
    const token = await bearerFor(owner._id, "BUSINESS_OWNER");

    const response = await request(app)
      .post(`/api/v1/businesses/${business._id}/payout-destination/step-up/otp/request`)
      .set("Authorization", token)
      .send({});

    expect(response.status).toBe(400);
  });

  // --- Authorization ---------------------------------------------------------------------------

  it("denies SUPERVISOR and STAFF with 403", async () => {
    const { business } = await createOwnerAndBusiness();
    const app = buildApp();

    for (const role of ["SUPERVISOR", "STAFF"] as const) {
      const user = await createUser(role);
      const token = await bearerFor(user._id, role);

      const read = await request(app)
        .get(`/api/v1/businesses/${business._id}/payout-destination`)
        .set("Authorization", token);
      const write = await request(app)
        .patch(`/api/v1/businesses/${business._id}/payout-destination`)
        .set("Authorization", token)
        .send(validBody());

      expect(read.status).toBe(403);
      expect(write.status).toBe(403);
    }
    expect(await PayoutDestinationModel.countDocuments({})).toBe(0);
  });

  it("denies an unrelated BUSINESS_OWNER (404, matching the Finance convention)", async () => {
    const { business } = await createOwnerAndBusiness();
    const other = await createOwnerAndBusiness();
    const app = buildApp();
    const token = await bearerFor(other.owner._id, "BUSINESS_OWNER");

    const read = await request(app)
      .get(`/api/v1/businesses/${business._id}/payout-destination`)
      .set("Authorization", token);
    const write = await request(app)
      .patch(`/api/v1/businesses/${business._id}/payout-destination`)
      .set("Authorization", token)
      .send(validBody());

    expect(read.status).toBe(404);
    expect(write.status).toBe(404);
    expect(await PayoutDestinationModel.countDocuments({ businessId: business._id })).toBe(0);
  });

  it("has no DELETE route", async () => {
    const { owner, business } = await createOwnerAndBusiness();
    const app = buildApp();
    const token = await bearerFor(owner._id, "BUSINESS_OWNER");

    const response = await request(app)
      .delete(`/api/v1/businesses/${business._id}/payout-destination`)
      .set("Authorization", token);

    expect(response.status).toBe(404);
  });

  // --- Super Admin -----------------------------------------------------------------------------

  describe("Super Admin", () => {
    const seed = async () => {
      const { owner, business } = await createOwnerAndBusiness();
      const app = buildApp();
      const ownerToken = await bearerFor(owner._id, "BUSINESS_OWNER");
      await request(app)
        .patch(`/api/v1/businesses/${business._id}/payout-destination`)
        .set("Authorization", ownerToken)
        .send(validBody());

      const admin = await createUser("SUPER_ADMIN");
      const adminToken = await bearerFor(admin._id, "SUPER_ADMIN");
      return { app, business, admin, adminToken, owner, ownerToken };
    };

    it("sees masked data on the normal detail read", async () => {
      const { app, business, adminToken } = await seed();

      const response = await request(app)
        .get(`/api/v1/super-admin/businesses/${business._id}/payout-destination`)
        .set("Authorization", adminToken);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        configured: true,
        ibanMasked: "CY••••••••7600",
        ibanLast4: "7600",
      });
      expect(JSON.stringify(response.body)).not.toContain(IBAN_CY);
    });

    it("returns the full IBAN via the explicit reveal, and audits it without the IBAN", async () => {
      const { app, business, admin, adminToken } = await seed();

      const response = await request(app)
        .post(`/api/v1/super-admin/businesses/${business._id}/payout-destination/reveal`)
        .set("Authorization", adminToken)
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.data.iban).toBe(IBAN_CY);
      expect(response.body.data.accountHolderName).toBe("Maria Georgiou");

      const stored = await PayoutDestinationModel.findOne({ businessId: business._id }).exec();
      const audit = stored?.history.at(-1);
      expect(audit?.action).toBe("IBAN_REVEALED");
      expect(String(audit?.actorUserId)).toBe(String(admin._id));
      expect(JSON.stringify(stored?.history)).not.toContain(IBAN_CY);
    });

    it("denies a non-SUPER_ADMIN reveal — including the Business Owner themselves", async () => {
      const { app, business, ownerToken } = await seed();

      const owner = await request(app)
        .post(`/api/v1/super-admin/businesses/${business._id}/payout-destination/reveal`)
        .set("Authorization", ownerToken)
        .send({});
      expect(owner.status).toBe(403);

      for (const role of ["SUPERVISOR", "STAFF", "CUSTOMER"] as const) {
        const user = await createUser(role);
        const response = await request(app)
          .post(`/api/v1/super-admin/businesses/${business._id}/payout-destination/reveal`)
          .set("Authorization", await bearerFor(user._id, role))
          .send({});
        expect(response.status).toBe(403);
      }
    });

    it("rate-limits the reveal endpoint", async () => {
      const { app, business, adminToken } = await seed();
      // The configured budget in tests is AUTH-style and small; drive past it and assert the
      // limiter (not the handler) answers.
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const response = await request(app)
          .post(`/api/v1/super-admin/businesses/${business._id}/payout-destination/reveal`)
          .set("Authorization", adminToken)
          .send({});
        statuses.push(response.status);
        if (response.status === 429) break;
      }

      expect(statuses).toContain(429);
    });

    it("fails closed (500-class) when the stored ciphertext is corrupted", async () => {
      const { app, business, adminToken } = await seed();
      await PayoutDestinationModel.updateOne(
        { businessId: business._id },
        { $set: { ibanCiphertext: "deadbeef" } },
      ).exec();

      const response = await request(app)
        .post(`/api/v1/super-admin/businesses/${business._id}/payout-destination/reveal`)
        .set("Authorization", adminToken)
        .send({});

      expect(response.status).toBe(500);
      expect(JSON.stringify(response.body)).not.toContain(IBAN_CY);
    });

    it("returns 404 from reveal when the Business has no destination", async () => {
      const { business: other } = await createOwnerAndBusiness();
      const app = buildApp();
      const admin = await createUser("SUPER_ADMIN");

      const response = await request(app)
        .post(`/api/v1/super-admin/businesses/${other._id}/payout-destination/reveal`)
        .set("Authorization", await bearerFor(admin._id, "SUPER_ADMIN"))
        .send({});

      expect(response.status).toBe(404);
    });
  });
});
