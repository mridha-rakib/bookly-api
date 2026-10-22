/** biome-ignore-all lint/style/noNonNullAssertion: Fixture dimensions and successful reads are asserted by these tests; optional chaining would silently skip mutations. */
import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import { PackageProgressV2Model } from "../../src/modules/package-progress/package-progress-v2.model.js";
import {
  derivePackageProgressV2Totals,
  packageProgressV2InputSchema,
} from "../../src/modules/package-progress/package-progress-v2.rules.js";
import type { CreatePackageProgressV2Input } from "../../src/modules/package-progress/package-progress-v2.types.js";
import {
  AFTER,
  BEFORE,
  CUTOFF,
  prospectiveFixture,
} from "../helpers/package-v2-prospective-fixture.js";

const progressInput = (): CreatePackageProgressV2Input => ({
  _id: new Types.ObjectId(),
  schemaVersion: 2,
  businessId: new Types.ObjectId(),
  customerUserId: new Types.ObjectId(),
  businessClientId: new Types.ObjectId(),
  packageId: new Types.ObjectId(),
  originBookingId: new Types.ObjectId(),
  purchaseSnapshot: {
    name: "Bundle",
    packageRevision: 1,
    bundlePriceCents: 100,
    referenceTotalCents: 500,
    discountPercent: 80,
    currency: "EUR",
    fulfilmentMode: "AT_BUSINESS_LOCATION",
  },
  items: [2, 2, 1].map((quantity) => ({
    packageItemId: new Types.ObjectId(),
    definitionItemId: new Types.ObjectId(),
    serviceId: new Types.ObjectId(),
    serviceSnapshot: { name: "Treatment", pricingMode: "FIXED", durationMin: 60 },
    totalSessions: quantity,
    remainingSessions: quantity,
    completedSessions: 0,
    referenceUnitPriceCents: 100,
  })),
  sessions: [],
});

describe("prospective accounting2 contract and provenance", () => {
  it.each([6, 12] as const)(
    "supports explicit finite %i with a separate accounting version",
    async (months) => {
      const input = prospectiveFixture(progressInput(), "FINITE", months);
      expect(packageProgressV2InputSchema.parse(input).creditAccountingVersion).toBe(2);
      await expect(new PackageProgressV2Model(input).validate()).resolves.toBeUndefined();
      expect(input.items[0]).toHaveProperty("penaltyBasisCents", 5000);
      expect(input.purchasedContract).not.toHaveProperty("items");
    },
  );
  it("supports FOREVER without finite fields or logical expiry", async () => {
    const input = prospectiveFixture(progressInput(), "FOREVER");
    await expect(new PackageProgressV2Model(input).validate()).resolves.toBeUndefined();
    expect(derivePackageProgressV2Totals(input, AFTER, "SETTLED")).toMatchObject({
      availableSessions: 5,
      expiredSessions: 0,
      originSettlement: "SETTLED",
    });
  });
  it("preserves absent/explicit accounting1 and rejects mixed or downgraded shapes", () => {
    const old = progressInput();
    expect(() =>
      derivePackageProgressV2Totals(
        Object.assign(
          { ...old },
          { creditAccountingVersion: 3 },
        ) as unknown as CreatePackageProgressV2Input,
      ),
    ).toThrow("Unsupported credit accounting version");
    expect(packageProgressV2InputSchema.parse(old)).not.toHaveProperty("creditAccountingVersion");
    expect(
      packageProgressV2InputSchema.safeParse({ ...old, creditAccountingVersion: 1 }).success,
    ).toBe(true);
    const input = prospectiveFixture(old);
    for (const value of [
      { ...old, creditAccountingVersion: 2 },
      { ...old, creditAccountingVersion: 3 },
      { ...input, creditAccountingVersion: 1 },
      { ...input, creditAccountingVersion: undefined },
      { ...input, purchasedContract: undefined },
      { ...old, items: old.items.map((item) => ({ ...item, expiredSessions: 0 })) },
    ])
      expect(packageProgressV2InputSchema.safeParse(value).success).toBe(false);
  });
  it("projects delayed expiry independently of materialized X and settlement", () => {
    const input = prospectiveFixture(progressInput());
    expect(derivePackageProgressV2Totals(input, BEFORE, "SETTLED")).toMatchObject({
      availableSessions: 5,
      redeemableSessions: 5,
      expiredSessions: 0,
    });
    expect(derivePackageProgressV2Totals(input, CUTOFF, "SETTLED")).toMatchObject({
      availableSessions: 0,
      redeemableSessions: 0,
      remainingSessions: 5,
      expiredSessions: 5,
      materializedExpiredSessions: 0,
    });
    expect(derivePackageProgressV2Totals(input, BEFORE, "LOCKED")).toMatchObject({
      availableSessions: 5,
      redeemableSessions: 0,
      originSettlement: "LOCKED",
    });
    expect(derivePackageProgressV2Totals(input, BEFORE)).toMatchObject({
      redeemableSessions: 0,
      originSettlement: "UNKNOWN",
    });
  });
  it.each([
    "missing-P",
    "wrong-P",
    "wrong-cap",
    "wrong-owner",
    "wrong-price",
    "wrong-item",
    "unexplained-X",
    "wrong-revision",
  ])("rejects %s", (kind) => {
    const input = prospectiveFixture(progressInput());
    const header = input.purchasedContract;
    const invalid =
      kind === "missing-P"
        ? {
            ...input,
            items: input.items.map((item) => ({ ...item, penaltyBasisCents: undefined })),
          }
        : kind === "wrong-P"
          ? { ...input, items: input.items.map((item) => ({ ...item, penaltyBasisCents: 5001 })) }
          : kind === "wrong-cap"
            ? {
                ...input,
                purchasedContract: {
                  ...header,
                  penalty: { ...header.penalty, lifetimeCapCents: 100 },
                },
              }
            : kind === "wrong-owner"
              ? { ...input, businessId: new Types.ObjectId() }
              : kind === "wrong-price"
                ? {
                    ...input,
                    purchasedContract: {
                      ...header,
                      penalty: {
                        ...header.penalty,
                        soldBundlePriceCents: 200,
                        lifetimeCapCents: 100,
                      },
                    },
                  }
                : kind === "wrong-item"
                  ? {
                      ...input,
                      items: input.items.map((item) => ({
                        ...item,
                        definitionItemId: new Types.ObjectId(),
                      })),
                    }
                  : kind === "wrong-revision"
                    ? {
                        ...input,
                        purchaseSnapshot: { ...input.purchaseSnapshot, packageRevision: 2 },
                      }
                    : {
                        ...input,
                        items: input.items.map((item) => ({
                          ...item,
                          remainingSessions: 0,
                          expiredSessions: item.totalSessions,
                        })),
                      };
    expect(packageProgressV2InputSchema.safeParse(invalid).success).toBe(false);
  });
  it("validates exact all-item expiry events without fake attempts", async () => {
    const input = prospectiveFixture(progressInput());
    const expired = {
      ...input,
      expiryReconciledAt: CUTOFF,
      items: input.items.map((item) => ({
        ...item,
        remainingSessions: 0,
        expiredSessions: item.totalSessions,
        expiryEvent: {
          eventKey: `expiry:${input._id}:${item.packageItemId}`,
          packageProgressId: input._id,
          packageItemId: item.packageItemId,
          cutoff: CUTOFF,
          quantity: item.totalSessions,
          reason: "VALIDITY_EXPIRED" as const,
          processedAt: CUTOFF,
        },
      })),
    };
    expect(packageProgressV2InputSchema.safeParse(expired).success).toBe(true);
    await expect(new PackageProgressV2Model(expired).validate()).resolves.toBeUndefined();
    expect(expired.sessions).toHaveLength(0);
    expect(derivePackageProgressV2Totals(expired, BEFORE)).toMatchObject({
      availableSessions: 0,
      expiredSessions: 5,
    });
    for (const override of [
      { quantity: 99 },
      { cutoff: AFTER },
      { processedAt: BEFORE },
      { packageProgressId: new Types.ObjectId() },
      { eventKey: "fake" },
      { reason: "NO_SHOW" },
    ]) {
      expect(
        packageProgressV2InputSchema.safeParse({
          ...expired,
          items: expired.items.map((item, index) =>
            index === 0 ? { ...item, expiryEvent: { ...item.expiryEvent, ...override } } : item,
          ),
        }).success,
      ).toBe(false);
    }
  });
  it.each(["AVAILABLE", "EXPIRED"] as const)(
    "validates terminal restore %s provenance",
    (disposition) => {
      const input = prospectiveFixture(progressInput());
      const item = input.items[0]!;
      const bookingId = new Types.ObjectId();
      const valid = {
        ...input,
        items: input.items.map((row, index) =>
          index === 0 && disposition === "EXPIRED"
            ? { ...row, remainingSessions: row.remainingSessions - 1, expiredSessions: 1 }
            : row,
        ),
        sessions: [
          {
            bookingId,
            packageItemId: item.packageItemId,
            serviceId: item.serviceId,
            status: "CANCELLED" as const,
            resolution: {
              eventKey: `resolution:${bookingId}`,
              outcome: "CANCELLED" as const,
              resolvedAt: disposition === "EXPIRED" ? CUTOFF : BEFORE,
              restorationDisposition: disposition,
            },
          },
        ],
      };
      expect(packageProgressV2InputSchema.safeParse(valid).success).toBe(true);
      const attempt = valid.sessions[0]!;
      for (const override of [
        { eventKey: "fake" },
        { outcome: "COMPLETED" },
        { restorationDisposition: undefined },
        { resolvedAt: disposition === "EXPIRED" ? BEFORE : CUTOFF },
      ])
        expect(
          packageProgressV2InputSchema.safeParse({
            ...valid,
            sessions: [{ ...attempt, resolution: { ...attempt.resolution, ...override } }],
          }).success,
        ).toBe(false);
    },
  );
  it("rejects FOREVER expiry and terminal evidence on a scheduled attempt", () => {
    const input = prospectiveFixture(progressInput(), "FOREVER");
    expect(
      packageProgressV2InputSchema.safeParse({ ...input, expiryReconciledAt: CUTOFF }).success,
    ).toBe(false);
    const item = input.items[0]!;
    const bookingId = new Types.ObjectId();
    expect(
      packageProgressV2InputSchema.safeParse({
        ...input,
        items: input.items.map((row, index) =>
          index === 0 ? { ...row, remainingSessions: row.remainingSessions - 1 } : row,
        ),
        sessions: [
          {
            bookingId,
            packageItemId: item.packageItemId,
            serviceId: item.serviceId,
            status: "SCHEDULED",
            resolution: {
              eventKey: `resolution:${bookingId}`,
              outcome: "CANCELLED",
              resolvedAt: BEFORE,
              restorationDisposition: "AVAILABLE",
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
describe("v2 purchased credit invariants", () => {
  it("derives authoritative aggregates and void availability", () => {
    const input = progressInput();
    expect(packageProgressV2InputSchema.parse(input)).toMatchObject({ schemaVersion: 2 });
    expect(derivePackageProgressV2Totals(input)).toEqual({
      totalSessions: 5,
      remainingSessions: 5,
      completedSessions: 0,
      availableSessions: 5,
    });
    expect(
      derivePackageProgressV2Totals({ ...input, voidedAt: new Date() }).availableSessions,
    ).toBe(0);
  });
  it.each([
    "duplicate-item",
    "duplicate-service",
    "duplicate-definition",
    "negative",
    "fraction",
    "overflow",
    "wrong-completed",
    "wrong-total",
    "no-duration",
    "non-fixed",
    "wrong-reference",
    "wrong-discount",
    "venue-cities",
    "travel-no-cities",
    "unknown-field",
    "duplicate-attempt",
    "wrong-attempt",
  ])("rejects %s", (kind) => {
    const input = progressInput();
    const item = input.items[0]!;
    if (kind === "duplicate-item") input.items[1]!.packageItemId = item.packageItemId;
    if (kind === "duplicate-service") input.items[1]!.serviceId = item.serviceId;
    if (kind === "duplicate-definition") input.items[1]!.definitionItemId = item.definitionItemId;
    if (kind === "negative") item.remainingSessions = -1;
    if (kind === "fraction") item.totalSessions = 1.1;
    if (kind === "overflow") item.totalSessions = Number.MAX_SAFE_INTEGER + 1;
    if (kind === "wrong-completed") item.completedSessions = 1;
    if (kind === "wrong-total") item.remainingSessions = 1;
    if (kind === "no-duration") item.serviceSnapshot.durationMin = 0;
    if (kind === "non-fixed") Object.assign(item.serviceSnapshot, { pricingMode: "HOURLY" });
    if (kind === "wrong-reference") input.purchaseSnapshot.referenceTotalCents = 1;
    if (kind === "wrong-discount") input.purchaseSnapshot.discountPercent = 10;
    if (kind === "venue-cities") item.travelCities = [{ city: "Larnaca", feeCents: 0 }];
    if (kind === "travel-no-cities") input.purchaseSnapshot.fulfilmentMode = "TRAVEL_TO_CUSTOMER";
    if (kind === "unknown-field") Object.assign(input, { remainingSessions: 5 });
    if (kind === "duplicate-attempt" || kind === "wrong-attempt") {
      input.sessions.push({
        bookingId: input.originBookingId,
        packageItemId: item.packageItemId,
        serviceId: kind === "wrong-attempt" ? new Types.ObjectId() : item.serviceId,
        status: "CANCELLED",
      });
      if (kind === "duplicate-attempt") input.sessions.push({ ...input.sessions[0]! });
    }
    expect(packageProgressV2InputSchema.safeParse(input).success).toBe(false);
  });
  it("checks travel city uniqueness and safe fees", () => {
    const input = progressInput();
    input.purchaseSnapshot.fulfilmentMode = "TRAVEL_TO_CUSTOMER";
    input.items.forEach((item) => {
      item.travelCities = [{ city: "Larnaca", feeCents: 100 }];
    });
    expect(packageProgressV2InputSchema.safeParse(input).success).toBe(true);
    input.items[0]!.travelCities!.push({ city: "Larnaca", feeCents: 100 });
    expect(packageProgressV2InputSchema.safeParse(input).success).toBe(false);
    input.items[0]!.travelCities = [{ city: "Larnaca", feeCents: 1.1 }];
    expect(packageProgressV2InputSchema.safeParse(input).success).toBe(false);
  });
  it("rejects a voided record that still has a live scheduled attempt", () => {
    const input = progressInput();
    const item = input.items[0]!;
    item.remainingSessions -= 1;
    input.sessions.push({
      bookingId: input.originBookingId,
      packageItemId: item.packageItemId,
      serviceId: item.serviceId,
      status: "SCHEDULED",
    });
    input.voidedAt = new Date();
    expect(packageProgressV2InputSchema.safeParse(input).success).toBe(false);
  });
  it("validates the Mongoose shape without legacy scalar authorities", async () => {
    await expect(new PackageProgressV2Model(progressInput()).validate()).resolves.toBeUndefined();
    const invalid = progressInput();
    invalid.items[0]!.remainingSessions = 99;
    await expect(new PackageProgressV2Model(invalid).validate()).rejects.toThrow();
  });
});
