import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorHandler } from "../../src/common/middleware/error-handler.js";
import { readPackageCheckoutAvailability } from "../../src/modules/booking/package-checkout-availability.js";
import { createPackageConsentRoute } from "../../src/modules/booking/package-consent.route.js";
import {
  readPackageConsentHttpReadiness,
  shippedPackageConsentHttpActivation,
} from "../../src/modules/booking/package-consent-http-activation.js";

// Only the two authority modules are controlled; Consent HTTP readiness stays real.
const authority = vi.hoisted(() => ({ host: false, batch: false }));
vi.mock("../../src/modules/booking/trusted-time/qualified-host.js", async (original) => {
  const shipped =
    await original<typeof import("../../src/modules/booking/trusted-time/qualified-host.js")>();
  return {
    ...shipped,
    requireQualifiedConsentHost: () =>
      authority.host ? ({} as never) : shipped.requireQualifiedConsentHost(),
  };
});
vi.mock("../../src/modules/booking/package-batch-authority.js", async (original) => {
  const shipped =
    await original<typeof import("../../src/modules/booking/package-batch-authority.js")>();
  return {
    ...shipped,
    verifyPackageBatchActivation: async () =>
      authority.batch ? undefined : shipped.verifyPackageBatchActivation(),
  };
});

const consentEnabled = { enabled: true, lifetimeMs: 1800000 } as const;
beforeEach(() => {
  authority.host = false;
  authority.batch = false;
});

describe("P4K-1 checkout availability matches the actual consent/purchase composition", () => {
  it("normal composition: unavailable and the mounted consent route is denied", async () => {
    expect(shippedPackageConsentHttpActivation).toEqual({});
    expect(readPackageConsentHttpReadiness(shippedPackageConsentHttpActivation).state).toBe(
      "DISABLED",
    );
    await expect(readPackageCheckoutAvailability()).resolves.toBe(false);
    const app = express();
    app.use("/c", createPackageConsentRoute());
    app.use(createErrorHandler({ isProduction: true }));
    const denied = await request(app).get(`/c/${"a".repeat(24)}/offers/${"b".repeat(24)}`);
    expect(denied.status).toBe(404);
    expect(JSON.stringify(denied.body)).toContain("PACKAGE_CONSENT_DISABLED");
  });
  it("qualified host + batch activation WITHOUT Consent HTTP stays unavailable (partial rollout)", async () => {
    authority.host = true;
    authority.batch = true;
    await expect(readPackageCheckoutAvailability()).resolves.toBe(false);
    await expect(readPackageCheckoutAvailability({ enabled: false })).resolves.toBe(false);
  });
  it("Consent HTTP enabled but batch purchase or host denied stays unavailable", async () => {
    authority.host = true;
    await expect(readPackageCheckoutAvailability(consentEnabled)).resolves.toBe(false);
    authority.host = false;
    authority.batch = true;
    await expect(readPackageCheckoutAvailability(consentEnabled)).resolves.toBe(false);
  });
  it("Consent HTTP enabled without an approved lifetime stays unavailable, matching the route", () => {
    expect(readPackageConsentHttpReadiness({ enabled: true }).state).not.toBe("READY");
  });
  it("only a fully authorized composition reports availability", async () => {
    authority.host = true;
    authority.batch = true;
    await expect(readPackageCheckoutAvailability(consentEnabled)).resolves.toBe(true);
  });
  it("availability is informational: it performs no authorization for later requests", async () => {
    authority.host = true;
    authority.batch = true;
    await readPackageCheckoutAvailability(consentEnabled);
    authority.batch = false;
    const { verifyPackageBatchActivation } = await import(
      "../../src/modules/booking/package-batch-authority.js"
    );
    await expect(verifyPackageBatchActivation()).rejects.toThrow();
  });
});
