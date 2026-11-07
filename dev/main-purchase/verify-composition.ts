// biome-ignore-all lint/suspicious/noConsole: focused composition validation, no application/provider writes
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { authorityDirectory, loadMainConfiguration } from "./configuration.js";

const environment = loadMainConfiguration();
const { compose, DevelopmentClock } = await import("./clock.js");
const clock = new DevelopmentClock(authorityDirectory, environment);
clock.startMonitor();
compose(clock);
try {
  const { readPackageCheckoutReadiness } = await import(
    "../../src/modules/booking/package-checkout-availability.js"
  );
  assert.deepEqual(await readPackageCheckoutReadiness(), { available: true, reason: null });
  const { observeConsentHost, verifyConsentHostObservation } = await import(
    "../../src/modules/booking/trusted-time/host-clock.js"
  );
  const sample = await observeConsentHost("a".repeat(64));
  assert.deepEqual(verifyConsentHostObservation(sample, sample.witnessHash), sample);
  const { createPackageConsentRoute } = await import(
    "../../src/modules/booking/package-consent.route.js"
  );
  const app = express();
  app.use("/consent", createPackageConsentRoute());
  app.use(((error, _req, res, _next) =>
    res
      .status(error.statusCode ?? 500)
      .json({ code: error.statusCode })) as express.ErrorRequestHandler);
  const response = await request(app).get(
    "/consent/000000000000000000000001/offers/000000000000000000000002",
  );
  assert.equal(response.status, 401); // Activated route still requires a genuine authenticated Customer.
  const { buildPackagePurchaseService } = await import(
    "../../src/modules/booking/package-purchase-http.js"
  );
  assert.ok(buildPackagePurchaseService()); // Existing canonical writer/provider composition, no calls.
  console.info(
    "Main development composition passed: checkout readiness, sealed witness, authenticated consent gate and canonical purchase service construction. No database/provider writes.",
  );
} finally {
  clock.close();
}
