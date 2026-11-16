import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  mongoose.deleteModel(/.+/);
  vi.doUnmock("../../src/modules/booking/approved-first-class-release.js");
  vi.doUnmock("../../src/modules/booking/trusted-time/qualified-host.js");
  vi.doUnmock("../../src/modules/booking/trusted-time/host-clock.js");
  vi.resetModules();
});

it("denies the mounted route when a configured issuer cannot obtain a trusted clock observation", async () => {
  vi.doMock("../../src/modules/booking/approved-first-class-release.js", () => ({
    readApprovedFirstClassRelease: () => ({
      version: 1,
      approvalReference: "synthetic-only",
      authorityId: "synthetic",
      hostId: "synthetic",
      configurationHash: "a".repeat(64),
      approvedBootId: "aaaa1111-1111-4111-8111-111111111111",
      lifetimeMs: 1_800_000,
    }),
  }));
  vi.doMock("../../src/modules/booking/trusted-time/qualified-host.js", async (original) => ({
    ...(await original<object>()),
    requireQualifiedConsentHost: () => ({}),
  }));
  vi.doMock("../../src/modules/booking/trusted-time/host-clock.js", async (original) => ({
    ...(await original<object>()),
    observeConsentHost: async () => {
      throw new Error("synthetic clock outage");
    },
  }));
  const { createPackageConsentRoute } = await import(
    "../../src/modules/booking/package-consent.route.js"
  );
  const { createErrorHandler } = await import("../../src/common/middleware/error-handler.js");
  const app = express();
  app.use("/consent", createPackageConsentRoute());
  app.use(createErrorHandler({ isProduction: true }));
  const response = await request(app).get("/consent/anything");
  expect(response.status).toBe(503);
  expect(JSON.stringify(response.body)).toContain("PACKAGE_CONSENT_UNAVAILABLE");
});

it("rejects the mounted consent route before authentication or service construction when the host is unqualified", async () => {
  vi.doMock("../../src/modules/booking/approved-first-class-release.js", () => ({
    readApprovedFirstClassRelease: () => ({
      version: 1,
      approvalReference: "synthetic-only",
      authorityId: "unqualified",
      hostId: "unqualified",
      configurationHash: "a".repeat(64),
      approvedBootId: "aaaa1111-1111-4111-8111-111111111111",
      lifetimeMs: 1_800_000,
    }),
  }));
  const { createPackageConsentRoute } = await import(
    "../../src/modules/booking/package-consent.route.js"
  );
  const { createErrorHandler } = await import("../../src/common/middleware/error-handler.js");
  const app = express();
  app.use("/consent", createPackageConsentRoute());
  app.use(createErrorHandler({ isProduction: true }));
  const response = await request(app).get("/consent/anything");
  expect(response.status).toBe(503);
  expect(JSON.stringify(response.body)).toContain("PACKAGE_CONSENT_UNAVAILABLE");
});
