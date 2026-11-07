import express from "express";
import request from "supertest";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { UserModel } from "../../../src/modules/user/user.model.js";
import { createApiRouter } from "../../../src/routes/api-router.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import { packageBatchFixture } from "../../helpers/package-batch-fixture.js";
import { connectIsolatedDatabase, stopIsolatedReplicaSet } from "./mongo-replset-helper.js";

vi.mock("../../../src/modules/payment/stripe-payment-gateway.js", async () => ({
  StripePaymentGateway: (await import("../../helpers/fake-payment-gateway.js")).FakePaymentGateway,
}));
vi.mock("../../../src/modules/payment/stripe-tax-gateway.js", async () => ({
  StripeTaxGateway: (await import("../../helpers/fake-tax-gateway.js")).FakeTaxGateway,
}));
beforeAll(connectIsolatedDatabase, 120000);
afterAll(stopIsolatedReplicaSet);

it("full API composition reaches Staff self-service while keeping Customer and Owner forbidden", async () => {
  const t = await packageBatchFixture();
  const membership = t.f.providers.find((p) => p.role === "STAFF");
  if (!membership) throw Error("Staff fixture required");
  await UserModel.create({
    _id: membership.userId,
    normalizedEmail: "staff-route@bcf05.invalid",
    role: "STAFF",
    status: "ACTIVE",
    security: { passwordUpdatedAt: new Date() },
  });
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createApiRouter({ getConnectionState: () => "connected" }));
  app.use(createErrorHandler({ isProduction: true }));
  const path = `/api/v1/businesses/${t.scope.businessId}/staff/me/appointments`;
  const staff = await issueTestAccessToken(t.tokens, {
    userId: String(membership.userId),
    role: "STAFF",
  });
  const own = await request(app).get(path).set("Authorization", `Bearer ${staff}`);
  expect(own.status, JSON.stringify(own.body)).toBe(200);
  expect(own.body.data.appointments).toEqual([]);
  expect(own.headers["cache-control"]).toContain("no-store");
  const overview = await request(app)
    .get(`/api/v1/businesses/${t.scope.businessId}/dashboard/overview`)
    .set("Authorization", `Bearer ${staff}`);
  expect(overview.status, JSON.stringify(overview.body)).toBe(200);
  expect(overview.body.data.scope).toBe("STAFF_SCOPED");
  expect(overview.body.data.financials).toBeNull();
  await request(app).get(path).set("Authorization", t.authorization).expect(403);
  const ownerId = t.f.business.ownerUserId;
  await UserModel.create({
    _id: ownerId,
    normalizedEmail: "owner-route@bcf05.invalid",
    role: "BUSINESS_OWNER",
    status: "ACTIVE",
    security: { passwordUpdatedAt: new Date() },
  });
  const owner = await issueTestAccessToken(t.tokens, {
    userId: String(ownerId),
    role: "BUSINESS_OWNER",
  });
  await request(app).get(path).set("Authorization", `Bearer ${owner}`).expect(403);
});
