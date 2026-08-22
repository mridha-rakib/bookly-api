import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { validateRequest } from "../../../src/common/middleware/validate-request.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../../../src/modules/auth/auth.middleware.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BusinessController } from "../../../src/modules/business/business.controller.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import {
  businessLinkOtpPerEmailRateLimit,
  businessLinkOtpRateLimit,
} from "../../../src/modules/business/business.route.js";
import { requestLinkVerificationBodySchema } from "../../../src/modules/business/business.schema.js";
import { BusinessService } from "../../../src/modules/business/business.service.js";
import { BusinessAccessRepository } from "../../../src/modules/business/business-access.repository.js";
import { BusinessLinkVerificationRepository } from "../../../src/modules/business/business-link-verification.repository.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import type { EmailOtpProvider } from "../../../src/modules/verification/email-otp.provider.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

class CapturingEmailOtpProvider implements EmailOtpProvider {
  public sentCount = 0;
  public sentTo: string[] = [];

  public async sendOtp(input: { to: string }): Promise<void> {
    this.sentCount += 1;
    this.sentTo.push(input.to);
  }
}

const businessInput = (ownerUserId: import("mongoose").Types.ObjectId, name: string) => ({
  ownerUserId,
  name,
  ownerName: "Owner Name",
  email: `${name.toLowerCase().replace(/\s+/g, "")}@example.com`,
  phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
  visitType: "AT_BUSINESS_LOCATION" as const,
  address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
  briefDescription: "A great business",
  category: "Wellness",
  subcategories: ["Massage"],
});

describe("business-link OTP rate limiting (dedicated limiter, not just the global one)", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let businessAccessRepository: BusinessAccessRepository;
  let businessLinkVerificationRepository: BusinessLinkVerificationRepository;
  let emailProvider: CapturingEmailOtpProvider;
  let tokenService: TokenService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    businessAccessRepository = new BusinessAccessRepository();
    businessLinkVerificationRepository = new BusinessLinkVerificationRepository();
    emailProvider = new CapturingEmailOtpProvider();
    tokenService = new TokenService(new SessionRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const createBusinessOwner = async (email: string, businessName: string) => {
    const user = await userRepository.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const business = await businessRepository.create(businessInput(user._id, businessName));
    return { user, business };
  };

  /**
   * Mirrors business.route.ts's real wiring for the two send-OTP endpoints, but with
   * explicit small limits (instead of env-driven production defaults) so the test can
   * exceed them in a handful of requests, and a capturing (non-network) email provider so
   * the test never depends on real SMTP delivery.
   */
  const buildApp = (perIpLimit: number, perEmailLimit: number) => {
    const businessService = new BusinessService(
      businessRepository,
      businessAccessRepository,
      userRepository,
      businessLinkVerificationRepository,
      emailProvider,
    );
    const controller = new BusinessController(businessService);
    const app = express();
    app.use(express.json());
    app.use(
      createAuthenticateAccessTokenMiddleware(tokenService, userRepository),
      requireActiveUser(),
      requireRoles(["BUSINESS_OWNER"]),
    );
    app.post(
      "/businesses/links/verification",
      businessLinkOtpRateLimit(perIpLimit),
      businessLinkOtpPerEmailRateLimit(perEmailLimit),
      validateRequest({ body: requestLinkVerificationBodySchema }),
      (req, res, next) => {
        controller.requestLinkVerification(req, res).catch(next);
      },
    );
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (userId: import("mongoose").Types.ObjectId) =>
    `Bearer ${await tokenService.createAccessToken({ userId, role: "BUSINESS_OWNER" })}`;

  it("returns 429 once the per-IP send limit is exceeded, with a generic message", async () => {
    const { user: actor } = await createBusinessOwner("actor@example.com", "Actor Business");
    const { user: targetOwner } = await createBusinessOwner(
      "target@example.com",
      "Target Business",
    );
    await createBusinessOwner("target-two@example.com", "Target Business Two");
    const app = buildApp(2, 100);
    const token = await bearerFor(actor._id);

    const first = await request(app)
      .post("/businesses/links/verification")
      .set("Authorization", token)
      .send({ email: "target@example.com" });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/businesses/links/verification")
      .set("Authorization", token)
      .send({ email: "target-two@example.com" });
    expect(second.status).toBe(201);

    const third = await request(app)
      .post("/businesses/links/verification")
      .set("Authorization", token)
      .send({ email: "target@example.com" });
    expect(third.status).toBe(429);
    expect(third.body.success).toBe(false);
    expect(third.body.message).toBe("Too many verification requests. Please try again later.");
    // Does not repeat/leak the requested email or any account-existence signal.
    expect(JSON.stringify(third.body)).not.toContain("target@example.com");

    expect(emailProvider.sentCount).toBe(2);
    void targetOwner;
  });

  it("returns 429 once the per-target-email limit is exceeded, even while the per-IP budget still has room", async () => {
    await createBusinessOwner("actor@example.com", "Actor Business");
    const { user: actor } = await createBusinessOwner(
      "actor-two@example.com",
      "Actor Business Two",
    );
    await createBusinessOwner("popular-target@example.com", "Popular Target Business");
    const app = buildApp(100, 2);
    const token = await bearerFor(actor._id);

    const first = await request(app)
      .post("/businesses/links/verification")
      .set("Authorization", token)
      .send({ email: "popular-target@example.com" });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/businesses/links/verification")
      .set("Authorization", token)
      .send({ email: "popular-target@example.com" });
    expect(second.status).toBe(201);

    // Third request for the SAME target email — blocked by the per-email limiter even
    // though the per-IP budget (100) is nowhere near exhausted.
    const third = await request(app)
      .post("/businesses/links/verification")
      .set("Authorization", token)
      .send({ email: "popular-target@example.com" });
    expect(third.status).toBe(429);

    expect(emailProvider.sentCount).toBe(2);
  });

  it("produces the identical 429 status/message whether the rate-limited target email belongs to a real account or not", async () => {
    const { user: actor } = await createBusinessOwner("actor@example.com", "Actor Business");
    await createBusinessOwner("real-target@example.com", "Real Target Business");
    const app = buildApp(100, 1);
    const token = await bearerFor(actor._id);

    // Exhausts the per-email budget for a real target...
    const realFirst = await request(app)
      .post("/businesses/links/verification")
      .set("Authorization", token)
      .send({ email: "real-target@example.com" });
    expect(realFirst.status).toBe(201);
    const realSecond = await request(app)
      .post("/businesses/links/verification")
      .set("Authorization", token)
      .send({ email: "real-target@example.com" });
    expect(realSecond.status).toBe(429);

    // ...and for a target email that has never existed. Both must be indistinguishable.
    const nonexistentFirst = await request(app)
      .post("/businesses/links/verification")
      .set("Authorization", token)
      .send({ email: "never-existed@example.com" });
    expect(nonexistentFirst.status).toBe(404);
    const nonexistentSecond = await request(app)
      .post("/businesses/links/verification")
      .set("Authorization", token)
      .send({ email: "never-existed@example.com" });
    expect(nonexistentSecond.status).toBe(429);

    expect(realSecond.status).toBe(nonexistentSecond.status);
    expect(realSecond.body).toEqual(nonexistentSecond.body);
  });
});
