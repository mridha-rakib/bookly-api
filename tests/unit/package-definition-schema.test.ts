import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import { openApiDocument } from "../../src/config/openapi.js";
import { toPackageDefinitionDto } from "../../src/modules/packages/package.dto.js";
import { PackageModel } from "../../src/modules/packages/package.model.js";
import {
  archivePackageQuerySchema,
  createPackageBodySchema,
  listPackagesQuerySchema,
  packageDefinitionContractTermsSchema,
  updatePackageBodySchema,
} from "../../src/modules/packages/package.schema.js";

const serviceId = new Types.ObjectId().toString();
const published = {
  name: "Hair & Facial",
  status: "ACTIVE",
  serviceCategoryId: new Types.ObjectId().toString(),
  subcategory: "Massage",
  bundlePriceCents: 100,
  items: [{ serviceId, includedSessions: 5, referenceUnitPriceCents: 100 }],
};

describe("Package definition request contracts", () => {
  it("never converts missing or unsupported stored validity into FOREVER in a DTO", () => {
    for (const validity of [undefined, {}, { mode: "UNKNOWN" }]) {
      const model = new PackageModel({
        ...published,
        businessId: new Types.ObjectId(),
        category: "Wellness",
        contractTerms: { version: 2, penaltyPolicyVersion: 1, validity },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      expect(() => toPackageDefinitionDto(model, [])).toThrow();
    }
  });
  it.each([{ mode: "FINITE", months: 6 }, { mode: "FINITE", months: 12 }, { mode: "FOREVER" }])(
    "accepts explicit validity %j through owner input, model and DTO",
    async (validity) => {
      const contractTerms = { validity };
      const input = {
        ...published,
        contractTerms,
        items: [{ ...published.items[0], penaltyBasisCents: 5000 }],
      };
      expect(createPackageBodySchema.parse(input).contractTerms).toEqual(contractTerms);
      expect(
        updatePackageBodySchema.safeParse({ ...input, isFeatured: false, expectedRevision: 1 })
          .success,
      ).toBe(true);
      const stored = packageDefinitionContractTermsSchema.parse({
        version: 2,
        penaltyPolicyVersion: 1,
        validity,
      });
      const model = new PackageModel({
        ...input,
        contractTerms: stored,
        businessId: new Types.ObjectId(),
        category: "Wellness",
        items: [{ ...input.items[0], itemId: new Types.ObjectId() }],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await model.validate();
      const dto = toPackageDefinitionDto(model, []);
      expect(dto.contractTerms).toEqual(stored);
      expect(dto.newContractReady).toBe(true);
      expect(dto).not.toHaveProperty("expiresAt");
      expect(dto.contractTerms).not.toHaveProperty("expiresAt");
      expect(dto.referenceTotalCents).toBe(500);
      model.status = "DRAFT";
      expect(toPackageDefinitionDto(model, []).newContractReady).toBe(false);
    },
  );
  it.each([
    {},
    { mode: "FINITE" },
    { mode: "FINITE", months: 0 },
    { mode: "FINITE", months: 18 },
    { mode: "FINITE", months: "6" },
    { mode: "FOREVER", months: 6 },
    { mode: "UNKNOWN" },
    { mode: "forever" },
    { mode: "FOREVER", expiresAt: "2099-01-01" },
    null,
  ])("rejects malformed explicit validity %j", async (validity) => {
    const contractTerms = { validity };
    expect(createPackageBodySchema.safeParse({ ...published, contractTerms }).success).toBe(false);
    // Mongoose casts numeric strings on typed paths; the strict Owner schema rejects them above.
    if (validity?.mode === "FINITE" && validity.months === "6") return;
    const model = new PackageModel({
      name: "Malformed",
      businessId: new Types.ObjectId(),
      category: "Wellness",
      contractTerms: { version: 2, penaltyPolicyVersion: 1, validity },
    });
    await expect(model.validate()).rejects.toThrow();
  });
  it.each([
    { version: 1, validity: { mode: "FOREVER" }, penaltyPolicyVersion: 1 },
    { version: 2, validityMonths: 6, penaltyPolicyVersion: 1 },
    { version: 2, validityMonths: 6, validity: { mode: "FOREVER" }, penaltyPolicyVersion: 1 },
    { version: 3, validity: { mode: "FOREVER" }, penaltyPolicyVersion: 1 },
    { version: 2, validity: { mode: "FOREVER" }, penaltyPolicyVersion: 2 },
  ])("rejects mixed and unsupported stored contract %j", async (contractTerms) => {
    expect(packageDefinitionContractTermsSchema.safeParse(contractTerms).success).toBe(false);
    const model = new PackageModel({
      name: "Invalid",
      businessId: new Types.ObjectId(),
      category: "Wellness",
      contractTerms,
    });
    await expect(model.validate()).rejects.toThrow();
  });
  it("rejects owner-supplied versions, fixed controls and hybrid validity in the new shape", () => {
    for (const extra of [
      { version: 2 },
      { penaltyPolicyVersion: 1 },
      { currency: "EUR" },
      { appointmentCaptureCapCents: 2500 },
      { lifetimeCaptureCapCents: 10000 },
      { lifetimeFormula: "B/2" },
      { validityMonths: 6 },
    ]) {
      const input = { ...published, contractTerms: { validity: { mode: "FOREVER" }, ...extra } };
      expect(createPackageBodySchema.safeParse(input).success).toBe(false);
      expect(
        updatePackageBodySchema.safeParse({ ...input, isFeatured: false, expectedRevision: 1 })
          .success,
      ).toBe(false);
    }
  });
  it.each([6, 12])(
    "accepts explicit %i-month catalog validity without accepting policy inputs",
    (validityMonths) => {
      const input = {
        ...published,
        contractTerms: { validityMonths },
        items: [{ ...published.items[0], penaltyBasisCents: 0 }],
      };
      expect(createPackageBodySchema.parse(input).contractTerms).toEqual({ validityMonths });
    },
  );
  it.each([0, 1, 5, 7, 18, 6.5, "6", null, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid validity %s",
    (validityMonths) => {
      expect(
        createPackageBodySchema.safeParse({ ...published, contractTerms: { validityMonths } })
          .success,
      ).toBe(false);
    },
  );
  it.each([0, 5000])("accepts independent penalty basis %i", (penaltyBasisCents) => {
    expect(
      createPackageBodySchema.safeParse({
        ...published,
        items: [{ ...published.items[0], penaltyBasisCents }],
      }).success,
    ).toBe(true);
  });
  it.each([-1, 0.1, 5001, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "5000", null])(
    "rejects invalid penalty basis %s",
    (penaltyBasisCents) => {
      expect(
        createPackageBodySchema.safeParse({
          ...published,
          items: [{ ...published.items[0], penaltyBasisCents }],
        }).success,
      ).toBe(false);
    },
  );
  it.each([
    { version: 1 },
    { penaltyPolicyVersion: 1 },
    { currency: "EUR" },
    { appointmentCaptureCapCents: 2500 },
    { lifetimeCaptureCapCents: 10000 },
    { lifetimeFormula: "B" },
  ])("rejects even matching server-controlled terms %j", (extra) => {
    const contractTerms = { validityMonths: 6, ...extra };
    const body = { ...published, contractTerms };
    expect(createPackageBodySchema.safeParse(body).success).toBe(false);
    expect(
      updatePackageBodySchema.safeParse({ ...body, isFeatured: false, expectedRevision: 1 })
        .success,
    ).toBe(false);
    expect(createPackageBodySchema.safeParse({ ...published, ...extra }).success).toBe(false);
  });
  it("keeps old DTO semantics and qualifies only complete supported catalog terms", async () => {
    const model = new PackageModel({
      ...published,
      businessId: new Types.ObjectId(),
      category: "Wellness",
      items: [{ ...published.items[0], itemId: new Types.ObjectId() }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await model.validate();
    const old = toPackageDefinitionDto(model, []);
    expect(old).toMatchObject({ sellable: true, newContractReady: false });
    expect(old).not.toHaveProperty("contractTerms");
    expect(old.items[0]).not.toHaveProperty("penaltyBasisCents");
    model.contractTerms = { version: 1, validityMonths: 6, penaltyPolicyVersion: 1 };
    expect(toPackageDefinitionDto(model, []).newContractReady).toBe(false);
    const first = model.items[0];
    if (!first) throw new Error("Missing test item");
    first.penaltyBasisCents = 0;
    await model.validate();
    const complete = toPackageDefinitionDto(model, []);
    expect(complete).toMatchObject({
      sellable: true,
      newContractReady: true,
      contractTerms: { version: 1, validityMonths: 6, penaltyPolicyVersion: 1 },
    });
    expect(complete.referenceTotalCents).toBe(old.referenceTotalCents);
    expect(complete.discountPercent).toBe(old.discountPercent);
    expect(
      toPackageDefinitionDto(model, [{ code: "PACKAGE_PROVIDER_REQUIRED" }]).newContractReady,
    ).toBe(false);
    model.bundlePriceCents = 0;
    first.penaltyBasisCents = 5000;
    await model.validate(); // Zero consideration disables cash via L=0, not an invented P restriction.
    expect(toPackageDefinitionDto(model, []).newContractReady).toBe(true);
    model.status = "INACTIVE";
    expect(toPackageDefinitionDto(model, [])).toMatchObject({
      sellable: false,
      newContractReady: false,
    });
  });
  it("enforces supplied terms and basis in model validation without a database", async () => {
    for (const penaltyBasisCents of [-1, 0.5, 5001, Number.MAX_SAFE_INTEGER + 1]) {
      const model = new PackageModel({
        businessId: new Types.ObjectId(),
        name: "Draft",
        category: "Wellness",
        items: [
          { itemId: new Types.ObjectId(), serviceId, includedSessions: 1, penaltyBasisCents },
        ],
      });
      await expect(model.validate()).rejects.toThrow();
    }
    for (const contractTerms of [
      { version: 1, validityMonths: 7, penaltyPolicyVersion: 1 },
      { version: 2, validityMonths: 6, penaltyPolicyVersion: 1 },
      { version: 1, validityMonths: 6, penaltyPolicyVersion: 2 },
      { validityMonths: 6 },
    ]) {
      const model = new PackageModel({
        businessId: new Types.ObjectId(),
        name: "Draft",
        category: "Wellness",
        contractTerms,
      });
      await expect(model.validate()).rejects.toThrow();
    }
  });
  it("defaults a minimal empty draft", () => {
    expect(createPackageBodySchema.parse({ name: "  Draft  " })).toEqual({
      name: "Draft",
      status: "DRAFT",
      isFeatured: false,
      items: [],
    });
  });
  it("accepts a complete published Package and exact zero bundle", () => {
    expect(createPackageBodySchema.safeParse(published).success).toBe(true);
    expect(createPackageBodySchema.safeParse({ ...published, bundlePriceCents: 0 }).success).toBe(
      true,
    );
  });
  it.each(["serviceCategoryId", "subcategory", "bundlePriceCents", "items"])(
    "requires published %s",
    (key) => {
      const body: Record<string, unknown> = { ...published };
      delete body[key];
      expect(createPackageBodySchema.safeParse(body).success).toBe(false);
    },
  );
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null])(
    "rejects malformed quantity %s even in draft",
    (quantity) => {
      expect(
        createPackageBodySchema.safeParse({
          name: "Draft",
          items: [{ serviceId, includedSessions: quantity }],
        }).success,
      ).toBe(false);
    },
  );
  it.each([
    { discountPercent: 10 },
    { businessId: serviceId },
    { revision: 1 },
    { visitType: "TRAVEL_TO_CUSTOMER" },
    { assignedStaffMembershipIds: [] },
  ])("rejects unknown server/operational keys %j", (extra) => {
    expect(createPackageBodySchema.safeParse({ name: "Draft", ...extra }).success).toBe(false);
  });
  it("rejects duplicate Services case-insensitively and client-chosen create itemIds", () => {
    expect(
      createPackageBodySchema.safeParse({
        ...published,
        items: [...published.items, { ...published.items[0], serviceId: serviceId.toUpperCase() }],
      }).success,
    ).toBe(false);
    expect(
      createPackageBodySchema.safeParse({
        ...published,
        items: [{ ...published.items[0], itemId: serviceId }],
      }).success,
    ).toBe(false);
  });
  it("rejects duplicate update itemIds and requires full replacement fields", () => {
    const itemId = new Types.ObjectId().toString();
    expect(
      updatePackageBodySchema.safeParse({
        ...published,
        isFeatured: false,
        expectedRevision: 1,
        items: [
          { serviceId, itemId, includedSessions: 1 },
          { serviceId: new Types.ObjectId().toString(), itemId, includedSessions: 1 },
        ],
      }).success,
    ).toBe(false);
    expect(
      updatePackageBodySchema.safeParse({ name: "Partial", expectedRevision: 1 }).success,
    ).toBe(false);
  });
  it("rejects supplied reference zero, fractional cents and reference overflow", () => {
    for (const referenceUnitPriceCents of [0, 1.1, Number.MAX_SAFE_INTEGER]) {
      expect(
        createPackageBodySchema.safeParse({
          ...published,
          items: [{ serviceId, includedSessions: 2, referenceUnitPriceCents }],
        }).success,
      ).toBe(false);
    }
  });
  it("rejects incompatible filters and unsafe archive revision", () => {
    expect(listPackagesQuerySchema.safeParse({ status: "ACTIVE", archived: "false" }).success).toBe(
      false,
    );
    expect(
      archivePackageQuerySchema.safeParse({ expectedRevision: "9007199254740992" }).success,
    ).toBe(false);
    expect(archivePackageQuerySchema.parse({ expectedRevision: "12" })).toEqual({
      expectedRevision: 12,
    });
  });
  it("validates embedded model identities and published completeness without a DB", async () => {
    const id = new Types.ObjectId();
    const model = new PackageModel({
      businessId: id,
      name: "Draft",
      category: "Wellness",
      items: [
        { itemId: id, serviceId: id, includedSessions: 1 },
        { itemId: id, serviceId: id, includedSessions: 1 },
      ],
    });
    await expect(model.validate()).rejects.toThrow();
    const active = new PackageModel({
      businessId: id,
      name: "Empty",
      category: "Wellness",
      status: "ACTIVE",
    });
    await expect(active.validate()).rejects.toThrow();
  });
  it("registers only the required nonunique Package indexes", () => {
    expect(PackageModel.schema.indexes().map(([keys]) => keys)).toEqual([
      { businessId: 1, status: 1, createdAt: -1 },
      { businessId: 1, archivedAt: 1, createdAt: -1 },
      { businessId: 1, "items.serviceId": 1 },
    ]);
  });
  it("documents all seven Owner routes with schemas/security and no new sales route", () => {
    const paths = openApiDocument["paths"] as Record<string, Record<string, unknown>>;
    const base = "/api/v1/businesses/{businessId}/packages";
    expect(Object.keys(paths).filter((path) => path.startsWith(base))).toHaveLength(4);
    for (const [path, methods] of [
      [base, ["get", "post"]],
      [`${base}/{packageId}`, ["get", "patch", "delete"]],
      [`${base}/{packageId}/status`, ["patch"]],
      [`${base}/{packageId}/restore`, ["post"]],
    ] as const) {
      for (const method of methods)
        expect(paths[path]?.[method]).toMatchObject({ security: [{ PackageOwnerBearer: [] }] });
    }
  });
});
