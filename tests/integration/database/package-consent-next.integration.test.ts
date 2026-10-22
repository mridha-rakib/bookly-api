import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { createAuthRoute } from "../../../src/modules/auth/auth.route.js";
import { Argon2PasswordHasher } from "../../../src/modules/auth/password-hasher.js";
import { BookingCreationClaimModel } from "../../../src/modules/booking/booking-creation-claim.model.js";
import { buildPackageConsentServices } from "../../../src/modules/booking/package-consent.factory.js";
import { createPackageConsentRoute } from "../../../src/modules/booking/package-consent.route.js";
import { StaffScheduleModel } from "../../../src/modules/staff/staff-schedule.model.js";
import { UserModel } from "../../../src/modules/user/user.model.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "../../helpers/consent-isolated-database.js";
import { seedConsentDomain } from "../../helpers/consent-persisted-fixture.js";
import { checkoutFixture } from "../../helpers/package-checkout-fixture.js";
import { openPackageConsentBrowser } from "../../helpers/package-consent-browser.js";

const artifacts = process.env["BOOKLY_CONSENT_NEXT_ARTIFACTS"];
beforeAll(async () => {
  if (artifacts) await connectIsolatedDatabase();
}, 60000);
beforeEach(async () => {
  if (artifacts) await clearIsolatedDatabase();
});
afterAll(async () => {
  if (artifacts) await stopIsolatedReplicaSet();
});

it.skipIf(!artifacts).each(["price", "revision", "policy", "availability"])(
  "actual persisted %s change blocks acceptance before the 30-minute expiry",
  async (fact) => {
    const f = checkoutFixture();
    await seedConsentDomain(f);
    await UserModel.create({
      _id: f.context.customerUserId,
      normalizedEmail: "freshness@consent.test",
      passwordHash: "unused",
      role: "CUSTOMER",
      status: "ACTIVE",
      security: { passwordUpdatedAt: new Date() },
    });
    const services = buildPackageConsentServices(1800000);
    const token = await issueTestAccessToken(services.tokens, {
      userId: f.context.customerUserId,
      role: "CUSTOMER",
    });
    const date = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const availability = await services.availability.getAvailability({
      businessId: String(f.business._id),
      serviceId: String(f.services[0]?._id),
      staffMembershipId: String(f.providers[0]?._id),
      fromDate: date,
      toDate: date,
    });
    const startAt = availability.days[0]?.slots[0]?.startAt;
    expect(startAt).toBeTruthy();
    const app = express();
    app.use(express.json());
    app.use(createPackageConsentRoute({ enabled: true, build: () => services }));
    app.use(createErrorHandler());
    const operationId = randomUUID(),
      base = `/${f.business._id}`,
      path = `${base}/operations/${operationId}`;
    const post = (url: string, body: object) =>
      request(app).post(url).set("Authorization", `Bearer ${token}`).send(body);
    expect(
      (
        await post(`${base}/quotes`, {
          operationId,
          intent: {
            ...f.intent,
            selections: [{ ...f.intent.selections[0], startAt, addonIds: [] }],
          },
        })
      ).status,
    ).toBe(200);
    const p = (await post(`${path}/presentation`, {})).body.data;
    if (fact === "price") {
      f.definition.bundlePriceCents = (f.definition.bundlePriceCents ?? 1) - 1;
      await f.definition.save();
    }
    if (fact === "revision") {
      f.definition.revision += 1;
      await f.definition.save();
    }
    if (fact === "policy") {
      f.configuredPolicy.noShowPercentage = 99;
      await f.configuredPolicy.save();
    }
    if (fact === "availability")
      await StaffScheduleModel.updateMany(
        { businessId: f.business._id },
        { $set: { days: [] } },
        { runValidators: true },
      );
    const rejected = await post(`${path}/acceptance`, {
      version: 1,
      action: "ACCEPT_PACKAGE_CHECKOUT_TERMS",
      eventId: randomUUID(),
      presentationId: p.presentationId,
      challenge: p.challenge,
      templateVersion: p.templateVersion,
      quoteHash: p.quoteHash,
      disclosureHash: p.disclosureHash,
    });
    const stored = await BookingCreationClaimModel.findOne().orFail();
    expect(stored.packageCheckoutAcceptance).toBeUndefined();
    expect(stored.packageCheckoutRetention?.seed.expiresAt.getTime()).toBeGreaterThan(Date.now());
    process.stdout.write(
      `${JSON.stringify({ actualPersistedFreshness: fact, status: rejected.status, error: rejected.body })}\n`,
    );
    // Keep the stale-revision regression red until the production error mapping is corrected.
    expect(rejected.status).toBe(409);
  },
  60000,
);

it.skipIf(!artifacts)(
  "actual Next protected route, password login, canonical consent, same-family tabs and reload",
  async () => {
    if (!artifacts) throw new Error("Isolated artifacts directory required");
    const f = checkoutFixture();
    await seedConsentDomain(f);
    const email = "next-customer@consent.test",
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
    const services = buildPackageConsentServices(1800000);
    const date = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const available = await services.availability.getAvailability({
      businessId: String(f.business._id),
      serviceId: String(f.services[0]?._id),
      staffMembershipId: String(f.providers[0]?._id),
      fromDate: date,
      toDate: date,
    });
    const startAt = available.days[0]?.slots[0]?.startAt;
    if (!startAt) throw new Error("Actual availability fixture has no slot");
    const app = express();
    const origins: string[] = [];
    let enabled = true;
    let held = false;
    let release: (() => void) | undefined;
    const requests: { method: string; path: string; status: number }[] = [];
    const observations: { stage: string; requestCount: number }[] = [];
    app.use((req, res, next) => {
      const path = req.originalUrl.split("?")[0] ?? req.path;
      res.on("finish", () => requests.push({ method: req.method, path, status: res.statusCode }));
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
    const on = createPackageConsentRoute({ enabled: true, origins, build: () => services });
    const off = createPackageConsentRoute({ enabled: false });
    app.use("/api/v1/package-consent", async (req, res, next) => {
      if (held && req.method === "POST" && req.path.endsWith("/acceptance"))
        await new Promise<void>((done) => {
          release = done;
        });
      (enabled ? on : off)(req, res, next);
    });
    app.use(createErrorHandler());
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((done) => server.on("listening", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local API address");
    let acceptanceId: string | undefined;
    try {
      // Resolve the adjacent Client only for the explicitly enabled full-app test.
      // Ordinary API test discovery/typechecking does not require a Client checkout.
      const { runConsentNextE2E } = await import(
        pathToFileURL(resolve("../client/tests/e2e/package-consent-next.mjs")).href
      );
      await runConsentNextE2E({
        clientRoot: resolve("../client"),
        apiOrigin: `http://127.0.0.1:${address.port}`,
        businessId: String(f.business._id),
        packageId: String(f.definition._id),
        startAt,
        email,
        password,
        artifacts,
        openBrowser: openPackageConsentBrowser,
        setUiOrigin: (origin: string) => origins.push(origin),
        setApiEnabled: (value: boolean) => {
          enabled = value;
        },
        holdAcceptance: (value: boolean) => {
          held = value;
          if (!value) release?.();
        },
        verifyPersistence: async (stage: string, text?: string) => {
          observations.push({ stage, requestCount: requests.length });
          if (stage === "passive") expect(await BookingCreationClaimModel.countDocuments()).toBe(0);
          else {
            const row = await BookingCreationClaimModel.findOne().orFail();
            const q = row.packageCheckoutRetention;
            expect(q?.seed.expiresAt.getTime() ?? 0).toBe(
              (q?.seed.issuedAt.getTime() ?? 0) + 1800000,
            );
            if (stage.startsWith("presented")) {
              expect(
                row.packageCheckoutPresentation?.disclosure.content.renderedTermsSnapshot,
              ).toBe(text);
              expect(row.packageCheckoutAcceptance).toBeUndefined();
            } else {
              const accepted = row.packageCheckoutAcceptance;
              expect(accepted?.event.quoteHash).toBe(q?.quote.termsHash);
              expect(accepted?.disclosureHash).toBe(
                row.packageCheckoutPresentation?.disclosure.contentHash,
              );
              const id = String(accepted?.evidence.acceptanceId);
              expect(accepted?.evidence.acceptedAt.getUTCFullYear()).toBeGreaterThan(2025);
              if (acceptanceId) expect(id).toBe(acceptanceId);
              acceptanceId = id;
            }
          }
          for (const name of [
            "bookings",
            "packageprogresses",
            "paymentattempts",
            "bookingslotreservations",
            "refundoperations",
          ])
            expect(await mongoose.connection.db?.collection(name).countDocuments()).toBe(0);
        },
      });
    } finally {
      release?.();
      await writeFile(
        resolve(artifacts, "next-api-requests.json"),
        JSON.stringify({ requests, observations }, null, 2),
      );
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    }
  },
  600000,
);
