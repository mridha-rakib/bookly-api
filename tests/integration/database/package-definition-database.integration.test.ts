import express from "express";
import mongoose, { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { createBusinessBookingRoute } from "../../../src/modules/booking/booking.route.js";
import { BookingService } from "../../../src/modules/booking/booking.service.js";
import { BusinessModel } from "../../../src/modules/business/business.model.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { createBusinessRoute } from "../../../src/modules/business/business.route.js";
import { BusinessTravelSettingsRepository } from "../../../src/modules/business-travel-settings/business-travel-settings.repository.js";
import { createCatalogRoute } from "../../../src/modules/catalog/catalog.route.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { PackageModel } from "../../../src/modules/packages/package.model.js";
import { PackageRepository } from "../../../src/modules/packages/package.repository.js";
import { ServiceModel } from "../../../src/modules/services/service.model.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { ServiceCategoryRepository } from "../../../src/modules/services/service-category.repository.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import type { UserRole } from "../../../src/modules/user/user.types.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

vi.mock("../../../src/modules/payment/stripe-payment-gateway.js", async () => {
  const { FakePaymentGateway } = await import("../../helpers/fake-payment-gateway.js");
  return { StripePaymentGateway: FakePaymentGateway };
});
vi.mock("../../../src/modules/payment/stripe-tax-gateway.js", async () => {
  const { FakeTaxGateway } = await import("../../helpers/fake-tax-gateway.js");
  return { StripeTaxGateway: FakeTaxGateway };
});

describe("first-class Package definition Owner API (isolated database)", () => {
  const users = new UserRepository();
  const businesses = new BusinessRepository();
  const staff = new StaffRepository();
  const categories = new ServiceCategoryRepository();
  const travel = new BusinessTravelSettingsRepository();
  const tokens = new TokenService(new SessionRepository());
  const app = express();
  app.use(express.json());
  // Exercise real production Business auth/role wiring, not a test-only Owner middleware.
  app.use("/api/v1/businesses", createBusinessBookingRoute());
  app.use("/api/v1/businesses", createBusinessRoute());
  app.use("/api/v1/catalog", createCatalogRoute());
  app.use(createErrorHandler({ isProduction: true }));

  beforeAll(async () => {
    const dbName = await connectIsolatedDatabase();
    expect(dbName).toMatch(/^bookly_auth_\d+_[a-f0-9]+$/);
    expect(mongoose.connection.host).toMatch(/^(127\.0\.0\.1|localhost)$/);
  }, 120_000);
  beforeEach(async () => {
    await clearIsolatedDatabase();
  });
  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const actor = async (role: UserRole = "BUSINESS_OWNER", email = "owner@example.com") => {
    const user = await users.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role,
      status: "ACTIVE",
    });
    const bearer = `Bearer ${await issueTestAccessToken(tokens, { userId: user._id, role })}`;
    return { user, bearer };
  };
  const fixture = async (
    mode: "AT_BUSINESS_LOCATION" | "TRAVEL_TO_CUSTOMER" = "AT_BUSINESS_LOCATION",
  ) => {
    const owner = await actor();
    const business = await businesses.create({
      ownerUserId: owner.user._id,
      name: "Package Salon",
      ownerName: "Owner",
      email: "salon@example.com",
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: mode,
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "Package tests",
      category: "Wellness & Beauty",
      subcategories: ["Massage", "Facial Care"],
    });
    await BusinessModel.updateOne({ _id: business._id }, { $set: { status: "APPROVED" } });
    const provider = await actor("STAFF", "staff@example.com");
    const membership = await staff.create({
      userId: provider.user._id,
      businessId: business._id,
      role: "STAFF",
      createdByUserId: owner.user._id,
    });
    const category = await categories.create({
      businessId: business._id,
      name: "Treatments",
      nameKey: "treatments",
    });
    const service = await ServiceModel.create({
      businessId: business._id,
      name: "Hair",
      status: "ACTIVE",
      isPackageDeal: false,
      isFeatured: false,
      category: business.category,
      subcategory: "Massage",
      serviceCategoryId: category._id,
      pricingMode: "FIXED",
      fixedPricing: { priceCents: 9900, durationMin: 60, discountPercent: 50 },
      assignedStaffMembershipIds: [membership._id],
      servedCities: mode === "TRAVEL_TO_CUSTOMER" ? ["Larnaca"] : [],
      scheduleMode: "AUTO",
      sessionExpiryAlert: { enabled: false },
    });
    const base = `/api/v1/businesses/${business._id}/packages`;
    const input = {
      name: "Hair package",
      status: "ACTIVE",
      isFeatured: false,
      serviceCategoryId: String(category._id),
      subcategory: "Massage",
      bundlePriceCents: 20000,
      items: [
        { serviceId: String(service._id), includedSessions: 5, referenceUnitPriceCents: 6000 },
      ],
    };
    return { ...owner, business, provider, membership, category, service, base, input };
  };
  const create = (f: Awaited<ReturnType<typeof fixture>>, body: object = f.input) =>
    request(app).post(f.base).set("Authorization", f.bearer).send(body);
  const replacement = (dto: {
    name: string;
    status: string;
    isFeatured: boolean;
    serviceCategoryId?: string;
    subcategory?: string;
    items: unknown[];
    bundlePriceCents?: number;
    revision: number;
  }) => ({
    name: dto.name,
    status: dto.status === "ARCHIVED" ? "DRAFT" : dto.status,
    isFeatured: dto.isFeatured,
    serviceCategoryId: dto.serviceCategoryId,
    subcategory: dto.subcategory,
    items: dto.items,
    bundlePriceCents: dto.bundlePriceCents,
    expectedRevision: dto.revision,
  });

  it.each([
    {
      inputTerms: { validityMonths: 6 },
      terms: { version: 1, validityMonths: 6, penaltyPolicyVersion: 1 },
      updatedInput: { validityMonths: 12 },
      updatedTerms: { version: 1, validityMonths: 12, penaltyPolicyVersion: 1 },
    },
    {
      inputTerms: { validity: { mode: "FINITE", months: 6 } },
      terms: { version: 2, validity: { mode: "FINITE", months: 6 }, penaltyPolicyVersion: 1 },
      updatedInput: { validity: { mode: "FOREVER" } },
      updatedTerms: { version: 2, validity: { mode: "FOREVER" }, penaltyPolicyVersion: 1 },
    },
    {
      inputTerms: { validity: { mode: "FINITE", months: 12 } },
      terms: { version: 2, validity: { mode: "FINITE", months: 12 }, penaltyPolicyVersion: 1 },
      updatedInput: { validity: { mode: "FOREVER" } },
      updatedTerms: { version: 2, validity: { mode: "FOREVER" }, penaltyPolicyVersion: 1 },
    },
    {
      inputTerms: { validity: { mode: "FOREVER" } },
      terms: { version: 2, validity: { mode: "FOREVER" }, penaltyPolicyVersion: 1 },
      updatedInput: { validity: { mode: "FOREVER" } },
      updatedTerms: { version: 2, validity: { mode: "FOREVER" }, penaltyPolicyVersion: 1 },
    },
  ])(
    "round-trips $inputTerms through CRUD, CAS, archive and restore without activation",
    async ({ inputTerms, terms, updatedInput, updatedTerms }) => {
      const f = await fixture();
      const body = {
        ...f.input,
        contractTerms: inputTerms,
        items: f.input.items.map((item) => ({ ...item, penaltyBasisCents: 5000 })),
      };
      const created = await create(f, body);
      expect(created.status).toBe(201);
      let dto = created.body.data;
      expect(dto).toMatchObject({
        contractTerms: terms,
        newContractReady: true,
        sellable: true,
        referenceTotalCents: 30000,
        bundlePriceCents: 20000,
      });
      expect(dto.items[0].penaltyBasisCents).toBe(5000);
      expect((await PackageModel.findById(dto.id))?.contractTerms?.penaltyPolicyVersion).toBe(1);
      expect(
        (await request(app).get(f.base).set("Authorization", f.bearer)).body.data.packages[0]
          .contractTerms,
      ).toEqual(terms);
      const patch = async (payload: object) =>
        request(app).patch(`${f.base}/${dto.id}`).set("Authorization", f.bearer).send(payload);
      const changed = await patch({
        ...replacement(dto),
        contractTerms: updatedInput,
        items: dto.items.map((item: Record<string, unknown>) => ({
          ...item,
          penaltyBasisCents: 0,
        })),
      });
      expect(changed.status).toBe(200);
      dto = changed.body.data;
      expect(dto).toMatchObject({
        revision: 2,
        contractTerms: updatedTerms,
        newContractReady: true,
      });
      expect(dto.items[0].penaltyBasisCents).toBe(0);
      expect((await patch({ ...body, expectedRevision: 1 })).status).toBe(409);
      const inactive = await request(app)
        .patch(`${f.base}/${dto.id}/status`)
        .set("Authorization", f.bearer)
        .send({ status: "INACTIVE", expectedRevision: 2 });
      expect(inactive.body.data).toMatchObject({
        revision: 3,
        newContractReady: false,
        contractTerms: dto.contractTerms,
      });
      expect(
        (
          await request(app)
            .delete(`${f.base}/${dto.id}?expectedRevision=3`)
            .set("Authorization", f.bearer)
        ).status,
      ).toBe(200);
      const archived = (
        await request(app).get(`${f.base}/${dto.id}`).set("Authorization", f.bearer)
      ).body.data;
      expect(archived).toMatchObject({
        status: "ARCHIVED",
        revision: 4,
        contractTerms: dto.contractTerms,
      });
      const restored = await request(app)
        .post(`${f.base}/${dto.id}/restore`)
        .set("Authorization", f.bearer)
        .send({ status: "ACTIVE", expectedRevision: 4 });
      expect(restored.status).toBe(200);
      expect(restored.body.data).toMatchObject({
        revision: 5,
        newContractReady: true,
        contractTerms: dto.contractTerms,
      });
      expect(restored.body.data.items[0].penaltyBasisCents).toBe(0);
      // A full replacement intentionally removes omitted optional catalog fields.
      const removed = await patch({ ...f.input, expectedRevision: 5 });
      expect(removed.status).toBe(200);
      expect(removed.body.data).toMatchObject({
        revision: 6,
        sellable: true,
        newContractReady: false,
      });
      expect(removed.body.data.contractTerms).toBeUndefined();
      expect(removed.body.data.items[0].penaltyBasisCents).toBeUndefined();
      const raw = await mongoose.connection.db
        ?.collection("packages")
        .findOne({ _id: new Types.ObjectId(dto.id) });
      expect(raw).not.toHaveProperty("contractTerms");
      for (const name of [
        "bookings",
        "packageprogresses",
        "paymentattempts",
        "bookingfinancialtransactions",
      ])
        expect(await mongoose.connection.db?.collection(name).countDocuments()).toBe(0);
    },
  );

  it("qualifies every item independently and preserves comparison math for zero-price bundles", async () => {
    const f = await fixture();
    const facial = await ServiceModel.create({
      ...f.service.toObject(),
      _id: new Types.ObjectId(),
      name: "Facial",
    });
    const items = [
      { ...f.input.items[0], penaltyBasisCents: 0 },
      { serviceId: String(facial._id), includedSessions: 2, referenceUnitPriceCents: 1000 },
    ];
    const body = { ...f.input, bundlePriceCents: 0, contractTerms: { validityMonths: 12 }, items };
    const partial = await create(f, body);
    expect(partial.status).toBe(201);
    expect(partial.body.data).toMatchObject({
      sellable: true,
      newContractReady: false,
      referenceTotalCents: 32000,
      savingsCents: 32000,
      discountPercent: 100,
    });
    const complete = await request(app)
      .patch(`${f.base}/${partial.body.data.id}`)
      .set("Authorization", f.bearer)
      .send({
        ...body,
        expectedRevision: 1,
        items: [items[0], { ...items[1], penaltyBasisCents: 5000 }],
      });
    expect(complete.status).toBe(200);
    expect(complete.body.data).toMatchObject({
      sellable: true,
      newContractReady: true,
      bundlePriceCents: 0,
      referenceTotalCents: 32000,
      savingsCents: 32000,
      discountPercent: 100,
    });
    expect(
      complete.body.data.items.map((item: { penaltyBasisCents: number }) => item.penaltyBasisCents),
    ).toEqual([0, 5000]);
    expect(await mongoose.connection.db?.collection("paymentattempts").countDocuments()).toBe(0);
  });

  it("rejects contract overrides and invalid supplied fields without changing the stored revision", async () => {
    const f = await fixture();
    const dto = (await create(f)).body.data;
    for (const extra of [
      { penaltyPolicyVersion: 2 },
      { version: 1 },
      { currency: "USD" },
      { appointmentCaptureCapCents: 9999 },
      { lifetimeCaptureCapCents: 99999 },
      { lifetimeFormula: "B" },
    ]) {
      const invalid = { ...f.input, contractTerms: { validityMonths: 6, ...extra } };
      expect((await create(f, invalid)).status).toBe(400);
      expect(
        (
          await request(app)
            .patch(`${f.base}/${dto.id}`)
            .set("Authorization", f.bearer)
            .send({ ...invalid, expectedRevision: 1 })
        ).status,
      ).toBe(400);
    }
    for (const penaltyBasisCents of [-1, 0.5, 5001, Number.MAX_SAFE_INTEGER + 1])
      expect(
        (
          await create(f, {
            ...f.input,
            items: f.input.items.map((item) => ({ ...item, penaltyBasisCents })),
          })
        ).status,
      ).toBe(400);
    for (const validityMonths of [5, 7, 6.5])
      expect((await create(f, { ...f.input, contractTerms: { validityMonths } })).status).toBe(400);
    expect((await PackageModel.findById(dto.id))?.revision).toBe(1);
  });

  it("creates the real five-session definition with comparison-only prices, lists and reads it", async () => {
    const f = await fixture();
    const response = await create(f);
    expect(response.status).toBe(201);
    const dto = response.body.data;
    expect(dto).toMatchObject({
      name: "Hair package",
      revision: 1,
      totalSessions: 5,
      bundlePriceCents: 20000,
      referenceTotalCents: 30000,
      savingsCents: 10000,
      discountPercent: 33.33,
      sellable: true,
      dependencyIssues: [],
    });
    expect(dto.items[0].itemId).toMatch(/^[a-f0-9]{24}$/);
    expect(dto.items[0].itemId).not.toBe(String(f.service._id));
    expect(
      (await request(app).get(f.base).set("Authorization", f.bearer)).body.data.packages.map(
        (p: { id: string }) => p.id,
      ),
    ).toEqual([dto.id]);
    expect(
      (await request(app).get(`${f.base}/${dto.id}`).set("Authorization", f.bearer)).body.data,
    ).toEqual(dto);
    expect(await ServiceModel.findById(f.service._id).lean()).toMatchObject({
      fixedPricing: { priceCents: 9900, discountPercent: 50 },
    });
  });

  it("creates an empty draft with defaults and no fabricated pricing", async () => {
    const f = await fixture();
    const result = await create(f, { name: "Draft" });
    expect(result.status).toBe(201);
    expect(result.body.data).toMatchObject({
      status: "DRAFT",
      isFeatured: false,
      revision: 1,
      items: [],
      totalSessions: 0,
      referenceTotalCents: null,
      savingsCents: null,
      discountPercent: null,
      sellable: false,
    });
  });

  it.each([1, 5])("supports one FIXED Service x%i including bundle zero", async (quantity) => {
    const f = await fixture();
    const result = await create(f, {
      ...f.input,
      bundlePriceCents: 0,
      items: [{ ...f.input.items[0], includedSessions: quantity }],
    });
    expect(result.status).toBe(201);
    expect(result.body.data).toMatchObject({
      totalSessions: quantity,
      discountPercent: 100,
      savingsCents: quantity * 6000,
    });
  });

  it("preserves item identities on reorder and gives a removed/readded row a fresh identity", async () => {
    const f = await fixture();
    const facial = await ServiceModel.create({
      ...f.service.toObject(),
      _id: new Types.ObjectId(),
      name: "Facial",
    });
    const first = await create(f, {
      ...f.input,
      items: [
        ...f.input.items,
        { serviceId: String(facial._id), includedSessions: 2, referenceUnitPriceCents: 4000 },
      ],
    });
    expect(first.status).toBe(201);
    const dto = first.body.data;
    const reordered = await request(app)
      .patch(`${f.base}/${dto.id}`)
      .set("Authorization", f.bearer)
      .send({ ...replacement(dto), items: [...dto.items].reverse(), description: "Edited" });
    expect(reordered.status).toBe(200);
    expect(reordered.body.data.items.map((item: { itemId: string }) => item.itemId)).toEqual(
      dto.items.map((item: { itemId: string }) => item.itemId).reverse(),
    );
    const removed = await request(app)
      .patch(`${f.base}/${dto.id}`)
      .set("Authorization", f.bearer)
      .send({ ...replacement(reordered.body.data), items: [dto.items[0]] });
    expect(removed.status).toBe(200);
    expect(removed.body.data.description).toBeUndefined();
    const added = await request(app)
      .patch(`${f.base}/${dto.id}`)
      .set("Authorization", f.bearer)
      .send({
        ...replacement(removed.body.data),
        items: [
          dto.items[0],
          { serviceId: String(facial._id), includedSessions: 1, referenceUnitPriceCents: 4000 },
        ],
      });
    expect(added.status).toBe(200);
    expect(added.body.data.items[1].itemId).not.toBe(dto.items[1].itemId);
    expect(added.body.data.revision).toBe(4);
  });

  it("rejects arbitrary update IDs, IDs from another definition and Service swaps under existing IDs", async () => {
    const f = await fixture();
    const first = (await create(f)).body.data;
    const second = (await create(f)).body.data;
    for (const row of [
      { ...first.items[0], itemId: String(new Types.ObjectId()) },
      second.items[0],
      { ...first.items[0], serviceId: String(new Types.ObjectId()) },
    ]) {
      const response = await request(app)
        .patch(`${f.base}/${first.id}`)
        .set("Authorization", f.bearer)
        .send({ ...replacement(first), items: [row] });
      expect(response.status).toBe(404);
    }
    expect((await PackageModel.findById(first.id))?.revision).toBe(1);
  });

  it("admits exactly one of two concurrent revision-CAS writes", async () => {
    const f = await fixture();
    const dto = (await create(f)).body.data;
    const responses = await Promise.all(
      ["First", "Second"].map((name) =>
        request(app)
          .patch(`${f.base}/${dto.id}`)
          .set("Authorization", f.bearer)
          .send({ ...replacement(dto), name }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 409)?.body.errors[0].code).toBe(
      "PACKAGE_REVISION_CONFLICT",
    );
    expect((await PackageModel.findById(dto.id))?.revision).toBe(2);
  });

  it("enforces repository CAS even if two callers already read the same revision", async () => {
    const f = await fixture();
    const dto = (await create(f)).body.data;
    const repository = new PackageRepository();
    const definition = await repository.findById(f.business._id, dto.id);
    if (!definition) throw new Error("Missing definition");
    const fields = {
      name: definition.name,
      category: definition.category,
      status: definition.status,
      isFeatured: definition.isFeatured,
      items: definition.items,
      bundlePriceCents: definition.bundlePriceCents,
      serviceCategoryId: definition.serviceCategoryId,
      subcategory: definition.subcategory,
    };
    const result = await Promise.all([
      repository.replace(f.business._id, dto.id, 1, { ...fields, name: "A" }),
      repository.replace(f.business._id, dto.id, 1, { ...fields, name: "B" }),
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    expect((await repository.findById(f.business._id, dto.id))?.revision).toBe(2);
  });

  it("publishes drafts, toggles ACTIVE/INACTIVE and refuses published-to-DRAFT", async () => {
    const f = await fixture();
    const draft = (await create(f, { ...f.input, status: "DRAFT" })).body.data;
    const active = await request(app)
      .patch(`${f.base}/${draft.id}/status`)
      .set("Authorization", f.bearer)
      .send({ status: "ACTIVE", expectedRevision: 1 });
    expect(active.status).toBe(200);
    const inactive = await request(app)
      .patch(`${f.base}/${draft.id}/status`)
      .set("Authorization", f.bearer)
      .send({ status: "INACTIVE", expectedRevision: 2 });
    expect(inactive.body.data).toMatchObject({ status: "INACTIVE", revision: 3, sellable: false });
    for (const [suffix, body] of [
      ["/status", { status: "DRAFT", expectedRevision: 3 }],
      ["", { ...replacement(inactive.body.data), status: "DRAFT" }],
    ] as const) {
      expect(
        (
          await request(app)
            .patch(`${f.base}/${draft.id}${suffix}`)
            .set("Authorization", f.bearer)
            .send(body)
        ).status,
      ).toBe(409);
    }
  });

  it("archives softly, masks default list, edits archived without activating and restores only after validation", async () => {
    const f = await fixture();
    const dto = (await create(f)).body.data;
    expect(
      (
        await request(app)
          .delete(`${f.base}/${dto.id}?expectedRevision=1`)
          .set("Authorization", f.bearer)
      ).status,
    ).toBe(200);
    expect(
      (await request(app).get(f.base).set("Authorization", f.bearer)).body.data.packages,
    ).toEqual([]);
    const archived = (
      await request(app).get(`${f.base}?archived=true`).set("Authorization", f.bearer)
    ).body.data.packages[0];
    expect(archived).toMatchObject({
      status: "ARCHIVED",
      revision: 2,
      sellable: false,
      archivedAt: expect.any(String),
    });
    expect(
      (
        await request(app)
          .delete(`${f.base}/${dto.id}?expectedRevision=1`)
          .set("Authorization", f.bearer)
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .delete(`${f.base}/${dto.id}?expectedRevision=2`)
          .set("Authorization", f.bearer)
      ).status,
    ).toBe(200);
    expect((await PackageModel.findById(dto.id))?.revision).toBe(2);
    const edited = await request(app)
      .patch(`${f.base}/${dto.id}`)
      .set("Authorization", f.bearer)
      .send({
        name: "Archived draft edit",
        status: "ACTIVE",
        isFeatured: false,
        items: [],
        expectedRevision: 2,
      });
    expect(edited.body.data).toMatchObject({ status: "ARCHIVED", revision: 3, items: [] });
    expect(
      (
        await request(app)
          .post(`${f.base}/${dto.id}/restore`)
          .set("Authorization", f.bearer)
          .send({ status: "ACTIVE", expectedRevision: 3 })
      ).status,
    ).toBe(400);
    const filled = await request(app)
      .patch(`${f.base}/${dto.id}`)
      .set("Authorization", f.bearer)
      .send({ ...f.input, expectedRevision: 3 });
    expect(filled.status).toBe(200);
    const restored = await request(app)
      .post(`${f.base}/${dto.id}/restore`)
      .set("Authorization", f.bearer)
      .send({ status: "INACTIVE", expectedRevision: 4 });
    expect(restored.body.data).toMatchObject({ status: "INACTIVE", revision: 5 });
    expect(restored.body.data.archivedAt).toBeUndefined();
    expect(await PackageModel.countDocuments({ _id: dto.id })).toBe(1);
  });

  it.each([
    "HOURLY",
    "PER_PERSON",
    "LEGACY_PACKAGE",
    "ARCHIVED",
    "FOREIGN",
    "MISSING",
    "NESTED_PACKAGE",
    "BAD_FIXED",
  ])("rejects %s references even in drafts", async (kind) => {
    const f = await fixture();
    let serviceId = String(f.service._id);
    if (kind === "HOURLY" || kind === "PER_PERSON")
      await ServiceModel.updateOne({ _id: serviceId }, { $set: { pricingMode: kind } });
    if (kind === "LEGACY_PACKAGE")
      await ServiceModel.updateOne({ _id: serviceId }, { $set: { isPackageDeal: true } });
    if (kind === "ARCHIVED")
      await ServiceModel.updateOne({ _id: serviceId }, { $set: { status: "ARCHIVED" } });
    if (kind === "FOREIGN")
      await ServiceModel.updateOne(
        { _id: serviceId },
        { $set: { businessId: new Types.ObjectId() } },
      );
    if (kind === "MISSING") serviceId = String(new Types.ObjectId());
    if (kind === "NESTED_PACKAGE") serviceId = (await create(f)).body.data.id;
    if (kind === "BAD_FIXED")
      await ServiceModel.updateOne({ _id: serviceId }, { $unset: { fixedPricing: "" } });
    expect(
      (await create(f, { name: "Draft", items: [{ serviceId, includedSessions: 1 }] })).status,
    ).toBe(400);
  });

  it.each(["DRAFT", "INACTIVE"])(
    "allows structurally valid %s source only in a draft",
    async (status) => {
      const f = await fixture();
      await ServiceModel.updateOne({ _id: f.service._id }, { $set: { status } });
      expect((await create(f, { ...f.input, status: "DRAFT" })).status).toBe(201);
      expect((await create(f)).status).toBe(409);
    },
  );

  it("reports dependency loss as unsellable and refuses restore until recovery", async () => {
    const f = await fixture();
    const dto = (await create(f)).body.data;
    await ServiceModel.updateOne({ _id: f.service._id }, { $set: { status: "INACTIVE" } });
    const detail = await request(app).get(`${f.base}/${dto.id}`).set("Authorization", f.bearer);
    expect(detail.body.data).toMatchObject({
      status: "ACTIVE",
      sellable: false,
      revision: 1,
      dependencyIssues: [{ itemId: dto.items[0].itemId, code: "PACKAGE_SERVICE_INACTIVE" }],
    });
    await request(app)
      .delete(`${f.base}/${dto.id}?expectedRevision=1`)
      .set("Authorization", f.bearer);
    expect(
      (
        await request(app)
          .post(`${f.base}/${dto.id}/restore`)
          .set("Authorization", f.bearer)
          .send({ status: "ACTIVE", expectedRevision: 2 })
      ).status,
    ).toBe(409);
    await ServiceModel.updateOne({ _id: f.service._id }, { $set: { status: "ACTIVE" } });
    expect(
      (
        await request(app)
          .post(`${f.base}/${dto.id}/restore`)
          .set("Authorization", f.bearer)
          .send({ status: "ACTIVE", expectedRevision: 2 })
      ).status,
    ).toBe(200);
  });

  it("requires a current active assigned provider for each published item", async () => {
    const f = await fixture();
    await staff.updateActiveById(f.business._id, f.membership._id, { employmentActive: false });
    expect((await create(f)).status).toBe(409);
    await staff.updateActiveById(f.business._id, f.membership._id, { employmentActive: true });
    expect((await create(f)).status).toBe(201);
    await staff.softRemoveById(f.business._id, f.membership._id);
    expect((await create(f)).status).toBe(409);
  });

  it("validates taxonomy ownership and membership even in a draft", async () => {
    const f = await fixture();
    for (const extra of [
      { serviceCategoryId: String(new Types.ObjectId()) },
      { subcategory: "Unconfigured" },
    ]) {
      expect((await create(f, { ...f.input, status: "DRAFT", ...extra })).status).toBe(400);
    }
  });

  it("requires a configured active travel city per item without inventing venue requirements", async () => {
    const f = await fixture("TRAVEL_TO_CUSTOMER");
    expect((await create(f)).status).toBe(409);
    await travel.upsertByBusinessId(f.business._id, [
      { city: "Limassol", active: true, feeCents: 100 },
    ]);
    expect((await create(f)).status).toBe(409);
    await travel.upsertByBusinessId(f.business._id, [
      { city: "Larnaca", active: true, feeCents: 100 },
    ]);
    expect((await create(f)).status).toBe(201);
    const other = await ServiceModel.create({
      ...f.service.toObject(),
      _id: new Types.ObjectId(),
      name: "Other city",
      servedCities: ["Paphos"],
    });
    expect(
      (
        await create(f, {
          ...f.input,
          items: [
            ...f.input.items,
            { serviceId: String(other._id), includedSessions: 1, referenceUnitPriceCents: 100 },
          ],
        })
      ).status,
    ).toBe(409);
  });

  it.each(["SUPERVISOR", "STAFF", "CUSTOMER", "SUPER_ADMIN"] as const)(
    "denies %s on every Package management endpoint",
    async (role) => {
      const f = await fixture();
      const dto = (await create(f)).body.data;
      const forbidden = await actor(role, "forbidden@example.com");
      const responses = await Promise.all([
        request(app).get(f.base).set("Authorization", forbidden.bearer),
        request(app).post(f.base).set("Authorization", forbidden.bearer).send(f.input),
        request(app).get(`${f.base}/${dto.id}`).set("Authorization", forbidden.bearer),
        request(app)
          .patch(`${f.base}/${dto.id}`)
          .set("Authorization", forbidden.bearer)
          .send(replacement(dto)),
        request(app)
          .patch(`${f.base}/${dto.id}/status`)
          .set("Authorization", forbidden.bearer)
          .send({ status: "INACTIVE", expectedRevision: 1 }),
        request(app)
          .delete(`${f.base}/${dto.id}?expectedRevision=1`)
          .set("Authorization", forbidden.bearer),
        request(app)
          .post(`${f.base}/${dto.id}/restore`)
          .set("Authorization", forbidden.bearer)
          .send({ status: "ACTIVE", expectedRevision: 1 }),
      ]);
      expect(responses.map((response) => response.status)).toEqual(Array(7).fill(403));
    },
  );

  it("masks foreign Owner resources and denies anonymous access", async () => {
    const f = await fixture();
    const dto = (await create(f)).body.data;
    const foreign = await actor("BUSINESS_OWNER", "foreign@example.com");
    expect((await request(app).get(f.base)).status).toBe(401);
    expect((await request(app).get(f.base).set("Authorization", foreign.bearer)).status).toBe(404);
    expect(
      (await request(app).get(`${f.base}/${dto.id}`).set("Authorization", foreign.bearer)).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch(`${f.base}/${dto.id}`)
          .set("Authorization", foreign.bearer)
          .send(replacement(dto))
      ).status,
    ).toBe(404);
    expect(
      (await request(app).post(f.base).set("Authorization", foreign.bearer).send(f.input)).status,
    ).toBe(404);
  });

  it.each(["PENDING", "SUSPENDED"])(
    "preserves the %s Business gate after ownership masking",
    async (status) => {
      const f = await fixture();
      await BusinessModel.updateOne({ _id: f.business._id }, { $set: { status } });
      expect((await create(f)).status).toBe(403);
      expect((await request(app).get(f.base).set("Authorization", f.bearer)).status).toBe(403);
      const foreign = await actor("BUSINESS_OWNER", "foreign@example.com");
      expect((await request(app).get(f.base).set("Authorization", foreign.bearer)).status).toBe(
        404,
      );
    },
  );

  it("filters deterministically, rejects incompatible filters and never leaks definitions into the public Service catalog", async () => {
    const f = await fixture();
    const first = (await create(f)).body.data;
    const second = (await create(f)).body.data;
    await PackageModel.updateMany({}, { $set: { createdAt: new Date("2026-01-01T00:00:00Z") } });
    const listed = await request(app).get(`${f.base}?status=ACTIVE`).set("Authorization", f.bearer);
    expect(listed.body.data.packages.map((p: { id: string }) => p.id)).toEqual(
      [first.id, second.id].sort().reverse(),
    );
    expect(
      (
        await request(app)
          .get(`${f.base}?status=ACTIVE&archived=false`)
          .set("Authorization", f.bearer)
      ).status,
    ).toBe(400);
    const catalog = await request(app).get(`/api/v1/catalog/businesses/${f.business._id}`);
    expect(catalog.status).toBe(200);
    expect(catalog.body.data.services.map((service: { id: string }) => service.id)).toEqual([
      String(f.service._id),
    ]);
    expect(catalog.body.data.packages).toBeUndefined();
    const booking = new BookingService(
      businesses,
      staff,
      new ServiceRepository(),
      new AddonRepository(),
      new AddonServiceAssignmentRepository(),
      new ClientRepository(),
      new BookingRepository(),
    );
    await expect(
      booking.requirePackageRedemptionService(f.business, first.id),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("does not couple comparison references to live Service prices or edits", async () => {
    const f = await fixture();
    const dto = (await create(f)).body.data;
    await ServiceModel.updateOne(
      { _id: f.service._id },
      { $set: { "fixedPricing.priceCents": 1, "fixedPricing.discountPercent": 100 } },
    );
    const detail = await request(app).get(`${f.base}/${dto.id}`).set("Authorization", f.bearer);
    expect(detail.body.data).toMatchObject({
      bundlePriceCents: 20000,
      referenceTotalCents: 30000,
      savingsCents: 10000,
      discountPercent: 33.33,
      revision: 1,
    });
  });

  it("rejects a new definition through both legacy purchase endpoints without payment or Booking writes", async () => {
    const f = await fixture();
    const dto = (await create(f)).body.data;
    const customer = await actor("CUSTOMER", "buyer@example.com");
    for (const action of ["preview", "purchase"]) {
      const result = await request(app)
        .post(`/api/v1/businesses/${f.business._id}/bookings/packages/${action}`)
        .set("Authorization", customer.bearer)
        .send({
          serviceLines: [
            {
              serviceId: dto.id,
              staffMembershipId: String(f.membership._id),
              addonIds: [],
              pricingInput: {},
            },
          ],
          startAt: new Date(Date.now() + 14 * 86400000).toISOString(),
          idempotencyKey: `p1-no-sale-${action}`,
        });
      expect(result.status).toBe(404);
      expect(result.body.errors[0].code).toBe("BOOKING_SERVICE_NOT_FOUND");
    }
    expect(await mongoose.connection.db?.collection("bookings").countDocuments()).toBe(0);
    expect(await mongoose.connection.db?.collection("packageprogresses").countDocuments()).toBe(0);
    expect(await mongoose.connection.db?.collection("paymentattempts").countDocuments()).toBe(0);
  });

  it("uses no new sales/Booking/payment writes while creating definitions", async () => {
    const f = await fixture();
    await create(f);
    const names =
      (await mongoose.connection.db?.listCollections().toArray())?.map(
        (collection) => collection.name,
      ) ?? [];
    for (const name of names.filter((name) =>
      /booking|packageprogress|payment|financialtransaction/i.test(name),
    )) {
      expect(await mongoose.connection.db?.collection(name).countDocuments()).toBe(0);
    }
  });
});
