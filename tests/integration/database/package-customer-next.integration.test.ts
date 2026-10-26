import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { createAuthRoute } from "../../../src/modules/auth/auth.route.js";
import { Argon2PasswordHasher } from "../../../src/modules/auth/password-hasher.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { createCustomerBookingRoute } from "../../../src/modules/booking/booking.route.js";
import { BookingCreationClaimModel } from "../../../src/modules/booking/booking-creation-claim.model.js";
import { createPackageConsentRoute } from "../../../src/modules/booking/package-consent.route.js";
import { createCatalogRoute } from "../../../src/modules/catalog/catalog.route.js";
import { PackageProgressV2Model } from "../../../src/modules/package-progress/package-progress-v2.model.js";
import { createPackageViewRoute } from "../../../src/modules/package-progress/package-view.route.js";
import { PaymentAttemptModel } from "../../../src/modules/payment/payment-attempt.model.js";
import { UserModel } from "../../../src/modules/user/user.model.js";
import { seedConsentDomain } from "../../helpers/consent-persisted-fixture.js";
import { checkoutFixture } from "../../helpers/package-checkout-fixture.js";
import { openPackageConsentBrowser } from "../../helpers/package-consent-browser.js";
import { connectIsolatedDatabase, stopIsolatedReplicaSet } from "./mongo-replset-helper.js";

vi.mock("../../../src/modules/payment/stripe-payment-gateway.js", async () => {
  const { FakePaymentGateway } = await import("../../helpers/fake-payment-gateway.js");
  return { StripePaymentGateway: FakePaymentGateway };
});
vi.mock("../../../src/modules/payment/stripe-tax-gateway.js", async () => {
  const { FakeTaxGateway } = await import("../../helpers/fake-tax-gateway.js");
  return { StripeTaxGateway: FakeTaxGateway };
});
const artifacts = process.env["BOOKLY_S6_NEXT_ARTIFACTS"];
beforeAll(async () => {
  if (artifacts) await connectIsolatedDatabase();
}, 120000);
afterAll(async () => {
  if (artifacts) await stopIsolatedReplicaSet();
});
it.skipIf(!artifacts)(
  "S6 actual Next Customer login, published detail, empty packages and denial without purchase writes",
  async () => {
    if (!artifacts) throw Error("Explicit isolated artifacts directory required");
    await mkdir(artifacts, { recursive: true });
    const f = checkoutFixture();
    await seedConsentDomain(f);
    f.business.set("subcategories", ["Hair"]);
    await f.business.save();
    const email = "s6-browser@fixture.test",
      password = "Only-Test-Password-123!";
    await UserModel.create({
      _id: f.context.customerUserId,
      normalizedEmail: email,
      passwordHash: await new Argon2PasswordHasher().hash(password),
      role: "CUSTOMER",
      status: "ACTIVE",
      authProviders: ["PASSWORD"],
      security: { passwordUpdatedAt: new Date() },
    });
    const origins: string[] = [],
      requests: { method: string; path: string; status: number }[] = [];
    const app = express();
    app.use((req, res, next) => {
      res.on("finish", () =>
        requests.push({ method: req.method, path: req.path, status: res.statusCode }),
      );
      const origin = req.headers.origin;
      if (origin && !origins.includes(origin)) return res.sendStatus(403);
      if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      if (req.method === "OPTIONS") return res.sendStatus(204);
      next();
    });
    app.use(express.json());
    app.use("/api/v1/auth", createAuthRoute());
    app.use("/api/v1/package-views", createPackageViewRoute());
    app.use("/api/v1/catalog", createCatalogRoute());
    app.use("/api/v1/me", createCustomerBookingRoute());
    app.use("/api/v1/package-consent", createPackageConsentRoute());
    app.use(createErrorHandler({ isProduction: true }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((done) => server.once("listening", done));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw Error("Local API missing");
      const { runPackageCustomerNext } = await import(
        pathToFileURL(resolve("../client/tests/e2e/package-customer-next.mjs")).href
      );
      const result = await runPackageCustomerNext({
        clientRoot: resolve("../client"),
        apiOrigin: `http://127.0.0.1:${address.port}`,
        businessId: String(f.business._id),
        packageId: String(f.definition._id),
        name: f.definition.name,
        email,
        password,
        artifacts,
        openBrowser: openPackageConsentBrowser,
        setUiOrigin: (origin: string) => origins.push(origin),
      });
      expect(result).toHaveLength(4);
      expect(await BookingModel.countDocuments()).toBe(0);
      expect(await PackageProgressV2Model.countDocuments()).toBe(0);
      expect(await PaymentAttemptModel.countDocuments()).toBe(0);
      expect(await BookingCreationClaimModel.countDocuments()).toBe(0);
      await writeFile(
        resolve(artifacts, "next-api-requests.json"),
        JSON.stringify(requests, null, 2),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
  360000,
);
