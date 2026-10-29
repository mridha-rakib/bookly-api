import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import { SignJWT } from "jose";
import mongoose, { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { env } from "../../../src/config/env.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BookingCreationClaimModel } from "../../../src/modules/booking/booking-creation-claim.model.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import { PackageCheckoutAcceptanceService } from "../../../src/modules/booking/package-checkout-acceptance.service.js";
import { PackageCheckoutCustomerAuthority } from "../../../src/modules/booking/package-checkout-customer-authority.js";
import { PackageCheckoutRetentionService } from "../../../src/modules/booking/package-checkout-retention.service.js";
import { buildPackageConsentServices } from "../../../src/modules/booking/package-consent.factory.js";
import {
  createPackageConsentRoute,
  type PackageConsentServices,
  packageConsentOperationKey,
} from "../../../src/modules/booking/package-consent.route.js";
import { BusinessOpeningHoursModel } from "../../../src/modules/business-hours/business-hours.model.js";
import { createCatalogRoute } from "../../../src/modules/catalog/catalog.route.js";
import { ServiceCategoryModel } from "../../../src/modules/services/service-category.model.js";
import { SessionModel } from "../../../src/modules/session/session.model.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffScheduleModel } from "../../../src/modules/staff/staff-schedule.model.js";
import { daysOfWeek } from "../../../src/modules/staff/staff-schedule.types.js";
import { UserModel, UserProfileModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "../../helpers/consent-isolated-database.js";
import { CHECK_TIME, checkoutFixture } from "../../helpers/package-checkout-fixture.js";
import { openPackageConsentBrowser } from "../../helpers/package-consent-browser.js";

const setup = async () => {
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
    600000,
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
      lifetimeMs: 600000,
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
describe("gated consent-only HTTP adapter; real auth/CAS with synthetic domain reads", () => {
  beforeAll(async () => {
    const database = await connectIsolatedDatabase();
    expect(mongoose.connection.host).toBe("127.0.0.1");
    expect(database).toMatch(/^bookly_consent_v1_/);
    const hello = await mongoose.connection.db?.admin().command({ hello: 1 });
    expect(hello?.["setName"]).toBeTruthy();
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await mongoose.connection.db
          ?.collection("consent_http_preflight")
          .insertOne({ test: true }, { session });
      });
    } finally {
      await session.endSession();
    }
    process.stdout.write(
      `${JSON.stringify({ database, host: mongoose.connection.host, replicaSet: hello?.["setName"], transaction: "PASS" })}\n`,
    );
  }, 60000);
  beforeEach(clearIsolatedDatabase);
  afterAll(stopIsolatedReplicaSet);
  it("default off prevents composition, reads and writes, including acceptance reads", async () => {
    const build = vi.fn();
    const app = express();
    app.use(createPackageConsentRoute({ build }));
    app.use(createErrorHandler());
    expect((await request(app).post(`/${new Types.ObjectId()}/quotes`).send({})).status).toBe(404);
    expect(
      (await request(app).get(`/${new Types.ObjectId()}/operations/${randomUUID()}/acceptance`))
        .status,
    ).toBe(404);
    expect(build).not.toHaveBeenCalled();
    expect(await BookingCreationClaimModel.countDocuments()).toBe(0);
  });
  it("uses the explicitly approved 30-minute configurable default", async () => {
    expect(env.PACKAGE_CONSENT_QUOTE_LIFETIME_MS).toBe(30 * 60 * 1000);
    expect(env.PACKAGE_CONSENT_ENABLED).toBe(false);
  });
  it("quote > presentation > affirmative acceptance uses three bounded requests and no private response authority", async () => {
    const s = await setup();
    expect((await s.quote()).status).toBe(200);
    const presentation = await s.present();
    expect(presentation.status).toBe(200);
    const p = presentation.body.data;
    expect(Object.keys(p).sort()).toEqual([
      "challenge",
      "disclosureHash",
      "presentationId",
      "quoteHash",
      "templateVersion",
      "text",
      "version",
    ]);
    expect(p.text).toContain("Package:");
    expect(p).not.toHaveProperty("sessionFamilyId");
    expect(p).not.toHaveProperty("seed");
    const action = s.actionFor(p),
      result = await s.accept(action);
    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({
      state: "ACCEPTED_IMMUTABLE",
      disclosureHash: p.disclosureHash,
      eventId: action.eventId,
    });
    expect((await s.accept(action)).body.data).toEqual(result.body.data);
    expect(
      (await request(s.app).get(`${s.path}/acceptance`).set("Authorization", s.auth)).body.data,
    ).toEqual(result.body.data);
    const row = await BookingCreationClaimModel.findOne().orFail();
    expect(row.idempotencyKey).toBe(
      packageConsentOperationKey(s.f.context.customerUserId, s.operationId),
    );
    for (const collection of [
      "bookings",
      "paymentattempts",
      "packageprogresses",
      "refundoperations",
      "bookingslotreservations",
    ])
      expect(await mongoose.connection.db?.collection(collection).countDocuments()).toBe(0);
  });
  it("server provides owned definition/services/professionals without accepting monetary terms", async () => {
    const s = await setup();
    const res = await request(s.app)
      .get(`${s.base}/offers/${s.f.definition._id}`)
      .set("Authorization", s.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(3);
    expect(res.body.data.revision).toBe(4);
  });
  it.each([undefined, "Bearer forged", "Basic fake"])("rejects invalid auth %s", async (auth) => {
    const s = await setup();
    const call = request(s.app)
      .post(`${s.base}/quotes`)
      .send({ operationId: s.operationId, intent: s.f.intent });
    if (auth) call.set("Authorization", auth);
    expect((await call).status).toBe(401);
  });
  it.each(["STAFF", "BUSINESS_OWNER", "SUSPENDED", "DELETED"])(
    "rejects current account %s",
    async (state) => {
      const s = await setup();
      await UserModel.updateOne(
        { _id: s.f.context.customerUserId },
        { $set: ["STAFF", "BUSINESS_OWNER"].includes(state) ? { role: state } : { status: state } },
      );
      expect([401, 403]).toContain((await s.quote()).status);
    },
  );
  it("rejects revoked auth and denied Origin even with a valid token", async () => {
    const s = await setup();
    expect(
      (
        await request(s.app)
          .post(`${s.base}/quotes`)
          .set("Authorization", s.auth)
          .set("Origin", "https://foreign.test")
          .send({})
      ).status,
    ).toBe(403);
    await SessionModel.updateMany({}, { $set: { revokedAt: new Date() } });
    expect((await s.quote()).status).toBe(401);
  });
  it("rejects a correctly signed but expired JWT", async () => {
    const s = await setup();
    const token = await new SignJWT({ role: "CUSTOMER", sid: randomUUID() })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(String(s.f.context.customerUserId))
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(env.JWT_ACCESS_TOKEN_SECRET));
    expect(
      (
        await request(s.app)
          .post(`${s.base}/quotes`)
          .set("Authorization", `Bearer ${token}`)
          .send({ operationId: s.operationId, intent: s.f.intent })
      ).status,
    ).toBe(401);
  });
  it("another Customer cannot read or accept an existing operation", async () => {
    const s = await setup();
    await s.quote();
    const p = (await s.present()).body.data;
    const other = await UserModel.create({
      normalizedEmail: "foreign@consent.test",
      passwordHash: "synthetic",
      role: "CUSTOMER",
      status: "ACTIVE",
      security: { passwordUpdatedAt: new Date() },
    });
    const token = await issueTestAccessToken(s.services.tokens, {
      userId: other._id,
      role: "CUSTOMER",
    });
    expect(
      (
        await request(s.app)
          .post(`${s.path}/acceptance`)
          .set("Authorization", `Bearer ${token}`)
          .send(s.actionFor(p))
      ).status,
    ).toBe(409);
    expect(
      (await request(s.app).get(`${s.path}/acceptance`).set("Authorization", `Bearer ${token}`))
        .status,
    ).toBe(409);
  });
  it("exposes no purchase, payment or activation operation", async () => {
    const s = await setup();
    for (const suffix of ["purchase", "payment", "activation"])
      expect(
        (await request(s.app).post(`${s.path}/${suffix}`).set("Authorization", s.auth).send({}))
          .status,
      ).toBe(404);
    expect(await BookingCreationClaimModel.countDocuments()).toBe(0);
  });
  it("rejects forged seed, actor/time and incorrect challenge/hash", async () => {
    const s = await setup();
    expect(
      (
        await request(s.app)
          .post(`${s.base}/quotes`)
          .set("Authorization", s.auth)
          .send({ operationId: s.operationId, intent: s.f.intent, seed: s.f.seed })
      ).status,
    ).toBe(400);
    await s.quote();
    const p = (await s.present()).body.data;
    for (const extra of [{ acceptedAt: new Date() }, { actorUserId: String(s.f.id(90)) }])
      expect((await s.accept({ ...s.actionFor(p), ...extra })).status).toBe(400);
    expect((await s.accept({ ...s.actionFor(p), challenge: "0".repeat(64) })).status).toBe(409);
    expect((await s.accept({ ...s.actionFor(p), disclosureHash: "0".repeat(64) })).status).toBe(
      409,
    );
    expect((await s.accept({ accepted: true })).status).toBe(400);
  });
  it("changed policy and foreign Business cannot accept or overwrite the offer", async () => {
    const s = await setup();
    await s.quote();
    const p = (await s.present()).body.data;
    s.f.configuredPolicy.noShowPercentage = 99;
    expect((await s.accept(s.actionFor(p))).status).toBe(409);
    expect(
      (
        await request(s.app)
          .post(`/package-consent/${s.f.id(95)}/operations/${s.operationId}/presentation`)
          .set("Authorization", s.auth)
          .send({})
      ).status,
    ).toBe(409);
    expect(
      (await BookingCreationClaimModel.findOne().orFail()).packageCheckoutAcceptance,
    ).toBeUndefined();
  });
  it("different session cannot use an unaccepted presentation", async () => {
    const s = await setup();
    await s.quote();
    const p = (await s.present()).body.data;
    const token = await issueTestAccessToken(s.services.tokens, {
      userId: s.f.context.customerUserId,
      role: "CUSTOMER",
    });
    expect(
      (
        await request(s.app)
          .post(`${s.path}/acceptance`)
          .set("Authorization", `Bearer ${token}`)
          .send(s.actionFor(p))
      ).status,
    ).toBe(409);
  });
  it("concurrent conflicting requests elect one accepted result", async () => {
    const s = await setup();
    await s.quote();
    const p = (await s.present()).body.data;
    const results = await Promise.all([s.accept(s.actionFor(p)), s.accept(s.actionFor(p))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
  it("expired unaccepted offers cannot accept or slide expiry on presentation/quote retry", async () => {
    const s = await setup();
    await s.quote();
    const p = (await s.present()).body.data;
    const row = await BookingCreationClaimModel.findOne().orFail();
    const expiry = row.packageCheckoutRetention?.seed.expiresAt;
    if (!expiry) throw new Error("Quote expiry missing");
    s.advance(expiry);
    expect((await s.accept(s.actionFor(p))).status).toBe(409);
    expect((await s.present()).status).toBe(409);
    expect((await s.quote()).status).toBe(409);
    const preserved = await BookingCreationClaimModel.findOne().orFail();
    expect(preserved.packageCheckoutRetention?.seed.expiresAt).toEqual(expiry);
    expect(preserved.packageCheckoutAcceptance).toBeUndefined();
    const original = await request(s.app)
      .get(`${s.path}/quote`)
      .set("Authorization", s.auth)
      .expect(200);
    expect(original.body.data.quote.expiresAt).toBe(expiry.toISOString());
    expect(original.body.data.quote.issuedAt).toBe(
      row.packageCheckoutRetention?.seed.issuedAt.toISOString(),
    );
    expect(original.body.data.quote.certification).toBe("UNRESOLVED");
    expect(original.body.data.quote.purchaseAvailable).toBe(false);
  });
  it("committed acceptance replays after expiry without fresh policy or new evidence", async () => {
    const s = await setup();
    await s.quote();
    const action = s.actionFor((await s.present()).body.data);
    const first = await s.accept(action);
    const expiry = (await BookingCreationClaimModel.findOne().orFail()).packageCheckoutRetention
      ?.seed.expiresAt;
    if (!expiry) throw new Error("Quote expiry missing");
    s.advance(new Date(expiry.getTime() + 1));
    s.f.configuredPolicy.noShowPercentage = 99;
    expect((await s.accept(action)).body.data).toEqual(first.body.data);
    expect((await s.present()).body.data.accepted).toEqual(first.body.data);
  });
  it("production composition uses real persisted definition, policy, staff and availability; approved expiry never slides", async () => {
    const s = await setup(),
      f = s.f;
    f.business.set({
      ownerName: "Synthetic Owner",
      email: "business@consent.test",
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      briefDescription: "Disposable fixture",
    });
    await f.business.save();
    for (const member of f.providers) await member.save();
    for (const service of f.services) {
      service.set({ category: "Wellness & Beauty", sessionExpiryAlert: { enabled: false } });
      await service.save();
    }
    const category = await ServiceCategoryModel.create({
      businessId: f.business._id,
      name: "Hair",
      nameKey: "hair",
      active: true,
    });
    f.definition.set({
      category: "Wellness & Beauty",
      subcategory: "Hair",
      serviceCategoryId: category._id,
    });
    await f.definition.save();
    await f.configuredPolicy.save();
    for (const member of f.providers) {
      await UserProfileModel.create({
        userId: member.userId,
        firstName: "Synthetic",
        lastName: "Professional",
        gender: "other",
      });
      await StaffScheduleModel.create({
        membershipId: member._id,
        businessId: f.business._id,
        days: daysOfWeek.map((dayOfWeek) => ({
          dayOfWeek,
          intervals: [{ startTime: "00:00", endTime: "23:59" }],
        })),
      });
    }
    await BusinessOpeningHoursModel.create({
      businessId: f.business._id,
      days: daysOfWeek.map((dayOfWeek) => ({
        dayOfWeek,
        isOpen: true,
        slots: [{ startTime: "00:00", endTime: "23:59" }],
      })),
    });
    const production = buildPackageConsentServices(env.PACKAGE_CONSENT_QUOTE_LIFETIME_MS);
    const date = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const available = await production.availability.getAvailability({
      businessId: String(f.business._id),
      serviceId: String(f.services[0]?._id),
      staffMembershipId: String(f.providers[0]?._id),
      fromDate: date,
      toDate: date,
    });
    const slot = available.days[0]?.slots[0];
    expect(slot).toBeTruthy();
    const intent = {
      ...f.intent,
      selections: [{ ...f.intent.selections[0], startAt: slot?.startAt, addonIds: [] }],
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/package-consent",
      createPackageConsentRoute({ enabled: true, build: () => production }),
    );
    app.use(createErrorHandler());
    const quote = await request(app)
      .post(`${s.base}/quotes`)
      .set("Authorization", s.auth)
      .send({ operationId: s.operationId, intent });
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    const retained = (await BookingCreationClaimModel.findOne().orFail()).packageCheckoutRetention;
    if (!retained) throw new Error("Retained quote missing");
    expect(retained.seed.expiresAt.getTime() - retained.seed.issuedAt.getTime()).toBe(1800000);
    const p = await request(app)
      .post(`${s.path}/presentation`)
      .set("Authorization", s.auth)
      .send({});
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const repeated = await request(app)
      .post(`${s.base}/quotes`)
      .set("Authorization", s.auth)
      .send({ operationId: s.operationId, intent });
    expect(repeated.status).toBe(200);
    expect(
      (await BookingCreationClaimModel.findOne().orFail()).packageCheckoutRetention?.seed.expiresAt,
    ).toEqual(retained.seed.expiresAt);
    const result = await request(app)
      .post(`${s.path}/acceptance`)
      .set("Authorization", s.auth)
      .send(s.actionFor(p.body.data));
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(
      (await BookingCreationClaimModel.findOne().orFail()).packageCheckoutRetention?.seed.expiresAt,
    ).toEqual(retained.seed.expiresAt);
    const replay = await request(app)
      .post(`${s.path}/presentation`)
      .set("Authorization", s.auth)
      .send({});
    expect(replay.body.data.accepted).toEqual(result.body.data);
    const directory = process.env["BOOKLY_CONSENT_BROWSER_ARTIFACTS"];
    if (directory) {
      const bundle = await readFile(join(directory, "consent-browser.js"), "utf8");
      const css = await readFile(join(directory, "consent-browser.css"), "utf8");
      const paths: string[] = [];
      const browserOrigins: string[] = [];
      // Count only UI consent traffic; fixtures and assets are separate local reads.
      const browserApp = express();
      browserApp.use(express.json());
      browserApp.use((req, _res, next) => {
        if (req.path.startsWith("/package-consent/")) paths.push(`${req.method} ${req.path}`);
        next();
      });
      browserApp.use(
        "/package-consent",
        createPackageConsentRoute({
          enabled: true,
          origins: browserOrigins,
          build: () => production,
        }),
      );
      browserApp.use("/catalog", createCatalogRoute());
      browserApp.get("/consent-browser.js", (_req, res) => res.type("js").send(bundle));
      browserApp.get("/consent-browser.css", (_req, res) => res.type("css").send(css));
      browserApp.get("/browser-fixture", (_req, res) =>
        res
          .type("html")
          .send(
            `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/consent-browser.css"></head><body><div id="root"></div><script>window.__consentFixture=${JSON.stringify({ token: s.auth.slice(7), businessId: String(f.business._id), packageId: String(f.definition._id) })}</script><script src="/consent-browser.js"></script></body></html>`,
          ),
      );
      browserApp.use(createErrorHandler());
      const server = browserApp.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Local port missing");
      browserOrigins.push(`http://127.0.0.1:${address.port}`);
      const browser = await openPackageConsentBrowser(
        `http://127.0.0.1:${address.port}/browser-fixture`,
        directory,
      );
      try {
        await browser.waitFor(`document.body.innerText.includes('Add Hair appointment')`);
        await browser.evaluate(
          `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Add Hair appointment')).click()`,
        );
        await browser.waitFor(`!!document.querySelector('select')`);
        await browser.evaluate(
          `(()=>{const s=document.querySelector('select'); s.value=s.options[1].value; s.dispatchEvent(new Event('change',{bubbles:true}));const input=document.querySelector('input[type="date"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(slot?.startAt.slice(0, 10))});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
        );
        await browser.evaluate(
          `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Find available times')).click()`,
        );
        await browser.waitFor(
          `document.querySelector('[aria-label="Package appointment time"]').options.length > 1`,
        );
        await browser.evaluate(
          `(()=>{const s=document.querySelector('[aria-label="Package appointment time"]');s.value=${JSON.stringify(slot?.startAt)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`,
        );
        await browser.evaluate(
          `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Review selected terms')).click()`,
        );
        await browser.waitFor(`!!document.querySelector('input[type="checkbox"]')`);
        expect(
          await browser.evaluate(`document.querySelector('input[type="checkbox"]').checked`),
        ).toBe(false);
        expect(
          await browser.evaluate(
            `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Accept these terms').disabled`,
          ),
        ).toBe(true);
        await browser.screenshot(390, "consent-mobile.png");
        expect(await browser.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(
          true,
        );
        await browser.screenshot(1280, "consent-desktop.png");
        await browser.evaluate(`document.querySelector('input[type="checkbox"]').focus()`);
        await browser.press("Space");
        await browser.waitFor(`document.querySelector('input[type="checkbox"]').checked`);
        await browser.evaluate(
          `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Accept these terms').focus()`,
        );
        await browser.press("Enter");
        await browser.waitFor(`document.body.innerText.includes('Terms accepted')`);
        expect(paths).toHaveLength(4);
        expect(
          await browser.evaluate(
            "document.body.innerText.includes('No Package purchase has been made')",
          ),
        ).toBe(true);
        const rows = await BookingCreationClaimModel.find();
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => Boolean(r.packageCheckoutAcceptance))).toBe(true);
        const text = await browser.evaluate(
          `document.querySelector('[aria-label="Exact Package terms"]').textContent`,
        );
        expect(
          rows.some(
            (r) => r.packageCheckoutPresentation?.disclosure.content.renderedTermsSnapshot === text,
          ),
        ).toBe(true);
        process.stdout.write(
          `${JSON.stringify({ browserConsent: "PASS", observedConsentRequests: paths, mobileWidth: 390, desktopWidth: 1280 })}\n`,
        );
      } finally {
        browser.close();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  });
});
