import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { vi } from "vitest";
import { createErrorHandler } from "../../src/common/middleware/error-handler.js";
import { TokenService } from "../../src/modules/auth/token.service.js";
import { BookingCreationClaimRepository } from "../../src/modules/booking/booking-creation-claim.repository.js";
import { PackageCheckoutAcceptanceService } from "../../src/modules/booking/package-checkout-acceptance.service.js";
import { PackageCheckoutCustomerAuthority } from "../../src/modules/booking/package-checkout-customer-authority.js";
import { PackageCheckoutRetentionService } from "../../src/modules/booking/package-checkout-retention.service.js";
import {
  createPackageConsentRoute,
  type PackageConsentServices,
} from "../../src/modules/booking/package-consent.route.js";
import { SessionRepository } from "../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../src/modules/staff/staff.repository.js";
import { UserModel, UserProfileModel } from "../../src/modules/user/user.model.js";
import { UserRepository } from "../../src/modules/user/user.repository.js";
import { issueTestAccessToken } from "./access-token.js";
import { CHECK_TIME, checkoutFixture } from "./package-checkout-fixture.js";

/** Real HTTP/JWT/Mongo authority; synthetic domain read fixture and controlled quote clock. */
export const setupConsentHttp = async (): Promise<{
  f: ReturnType<typeof checkoutFixture>;
  services: PackageConsentServices;
  app: express.Express;
  auth: string;
  base: string;
  path: string;
  operationId: string;
  quote: () => request.Test;
  present: () => request.Test;
  actionFor: (p: Record<string, unknown>) => Record<string, unknown>;
  accept: (action: object) => request.Test;
  advance: (value: Date) => void;
}> => {
  const f = checkoutFixture();
  let now = CHECK_TIME;
  f.setTime(now);
  const operationId = randomUUID();
  const claims = new BookingCreationClaimRepository(),
    users = new UserRepository(),
    staff = new StaffRepository();
  const tokens = new TokenService(new SessionRepository());
  const authority = new PackageCheckoutCustomerAuthority(tokens, users, () => now);
  await UserModel.create({
    _id: f.context.customerUserId,
    normalizedEmail: "http@consent.test",
    passwordHash: "synthetic",
    role: "CUSTOMER",
    status: "ACTIVE",
    security: { passwordUpdatedAt: new Date() },
  });
  vi.spyOn(staff, "findManyByIdsForBusiness").mockResolvedValue(f.providers);
  vi.spyOn(staff, "listActiveByBusinessId").mockResolvedValue(f.providers);
  vi.spyOn(users, "findProfilesByUserIds").mockResolvedValue(
    f.providers.map(
      (p) =>
        new UserProfileModel({
          userId: p.userId,
          firstName: "Synthetic",
          lastName: "Professional",
        }),
    ),
  );
  const acceptance = new PackageCheckoutAcceptanceService(
    claims,
    authority,
    f.preparer,
    staff,
    users,
    () => now,
  );
  const retention = new PackageCheckoutRetentionService(
    claims,
    f.dependencies.packages,
    f.preparer,
    1800000,
    () => now,
  );
  const services = {
    tokens,
    users,
    authority,
    claims,
    staff,
    acceptance,
    retention,
    businesses: f.dependencies.businesses,
    packages: f.dependencies.packages,
    services: f.dependencies.services,
    availability: f.dependencies.availability,
  } as PackageConsentServices;
  const build = vi.fn(() => services);
  const app = express();
  app.use(express.json());
  app.use(
    "/package-consent",
    createPackageConsentRoute({
      enabled: true,
      lifetimeMs: 1800000,
      origins: ["http://localhost:3000"],
      build,
    }),
  );
  app.use(createErrorHandler({ isProduction: true }));
  const token = await issueTestAccessToken(tokens, {
    userId: f.context.customerUserId,
    role: "CUSTOMER",
  });
  const auth = `Bearer ${token}`,
    base = `/package-consent/${f.context.businessId}`,
    path = `${base}/operations/${operationId}`;
  const quote = () =>
    request(app)
      .post(`${base}/quotes`)
      .set("Authorization", auth)
      .send({ operationId, intent: f.intent });
  const present = () =>
    request(app).post(`${path}/presentation`).set("Authorization", auth).send({});
  const actionFor = (p: Record<string, unknown>) => ({
    version: 1,
    action: "ACCEPT_PACKAGE_CHECKOUT_TERMS",
    eventId: randomUUID(),
    presentationId: p["presentationId"],
    challenge: p["challenge"],
    templateVersion: p["templateVersion"],
    quoteHash: p["quoteHash"],
    disclosureHash: p["disclosureHash"],
  });
  const accept = (action: object) =>
    request(app).post(`${path}/acceptance`).set("Authorization", auth).send(action);
  return {
    f,
    services,
    app,
    auth,
    base,
    path,
    operationId,
    quote,
    present,
    accept,
    actionFor,
    advance: (value: Date) => {
      now = value;
      f.setTime(value);
    },
  };
};
