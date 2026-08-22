import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

import type { BusinessDocument } from "../../src/modules/business/business.model.js";
import type { BusinessRepository } from "../../src/modules/business/business.repository.js";
import type {
  BusinessCancellationPolicyDocument,
  CancellationTierRule,
} from "../../src/modules/business-cancellation-policy/business-cancellation-policy.model.js";
import type { BusinessCancellationPolicyRepository } from "../../src/modules/business-cancellation-policy/business-cancellation-policy.repository.js";
import {
  BusinessCancellationPolicyService,
  type CancellationTierRuleDto,
} from "../../src/modules/business-cancellation-policy/business-cancellation-policy.service.js";

const buildBusiness = (overrides: Partial<BusinessDocument> = {}): BusinessDocument =>
  ({
    _id: new Types.ObjectId(),
    ownerUserId: new Types.ObjectId(),
    name: "Ledra Barbers",
    ownerName: "Owner Name",
    email: "owner@example.com",
    phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
    status: "PENDING",
    visitType: "AT_BUSINESS_LOCATION",
    timezone: "Europe/Nicosia",
    address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
    briefDescription: "A great business",
    category: "Barber",
    subcategories: ["Haircut"],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  }) as BusinessDocument;

const fullValidTiers = (): CancellationTierRuleDto[] => [
  { tier: "MORE_THAN_72_HOURS", mode: "FREE" },
  { tier: "BETWEEN_24_AND_72_HOURS", mode: "FREE" },
  { tier: "BETWEEN_12_AND_24_HOURS", mode: "PERCENTAGE", percentage: 50 },
  { tier: "BETWEEN_2_AND_12_HOURS", mode: "PERCENTAGE", percentage: 75 },
  { tier: "UNDER_2_HOURS", mode: "PERCENTAGE", percentage: 100 },
];

class FakeCancellationPolicyRepository implements Partial<BusinessCancellationPolicyRepository> {
  public byBusinessId = new Map<string, BusinessCancellationPolicyDocument>();

  public readonly findByBusinessId = vi.fn(async (businessId: Types.ObjectId | string) => {
    return this.byBusinessId.get(String(businessId)) ?? null;
  });

  public readonly replace = vi.fn(
    async (businessId: Types.ObjectId, tiers: CancellationTierRule[], noShowPercentage: number) => {
      const existing = this.byBusinessId.get(String(businessId));
      const now = new Date();
      const document = {
        _id: existing?._id ?? new Types.ObjectId(),
        businessId,
        tiers,
        noShowPercentage,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      } as BusinessCancellationPolicyDocument;
      this.byBusinessId.set(String(businessId), document);
      return document;
    },
  );
}

const createService = (input: { business?: BusinessDocument | null } = {}) => {
  const ownerUserId = new Types.ObjectId();
  const business = input.business === undefined ? buildBusiness({ ownerUserId }) : input.business;
  const businessRepository = { findById: vi.fn().mockResolvedValue(business) };
  const cancellationPolicyRepository = new FakeCancellationPolicyRepository();
  const service = new BusinessCancellationPolicyService(
    cancellationPolicyRepository as unknown as BusinessCancellationPolicyRepository,
    businessRepository as unknown as BusinessRepository,
  );

  return { ownerUserId, business, businessRepository, cancellationPolicyRepository, service };
};

describe("BusinessCancellationPolicyService", () => {
  it("reports not-configured (never a fabricated default fee) when no document exists", async () => {
    const { service, business, ownerUserId } = createService();

    const result = await service.getPolicy(String(ownerUserId), String(business?._id));

    expect(result).toEqual({ businessId: String(business?._id), configured: false, tiers: [] });
  });

  it("owner configures all five windows plus a no-show percentage", async () => {
    const { service, business, ownerUserId } = createService();

    const result = await service.putPolicy(String(ownerUserId), String(business?._id), {
      tiers: fullValidTiers(),
      noShowPercentage: 30,
    });

    expect(result.configured).toBe(true);
    expect(result.noShowPercentage).toBe(30);
    expect(result.tiers).toHaveLength(5);
    // Returned in canonical tier order regardless of input order.
    expect(result.tiers.map((rule) => rule.tier)).toEqual([
      "MORE_THAN_72_HOURS",
      "BETWEEN_24_AND_72_HOURS",
      "BETWEEN_12_AND_24_HOURS",
      "BETWEEN_2_AND_12_HOURS",
      "UNDER_2_HOURS",
    ]);
    const underTwoHours = result.tiers.find((rule) => rule.tier === "UNDER_2_HOURS");
    expect(underTwoHours).toEqual({ tier: "UNDER_2_HOURS", mode: "PERCENTAGE", percentage: 100 });
    const moreThan72 = result.tiers.find((rule) => rule.tier === "MORE_THAN_72_HOURS");
    expect(moreThan72).toEqual({ tier: "MORE_THAN_72_HOURS", mode: "FREE" });
  });

  it("rejects a PERCENTAGE rule with no percentage set", async () => {
    const { service, business, ownerUserId } = createService();
    const tiers: CancellationTierRuleDto[] = fullValidTiers().map((rule) =>
      rule.tier === "UNDER_2_HOURS" ? { tier: rule.tier, mode: "PERCENTAGE" } : rule,
    );

    await expect(
      service.putPolicy(String(ownerUserId), String(business?._id), {
        tiers,
        noShowPercentage: 20,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects a policy missing one of the five required windows", async () => {
    const { service, business, ownerUserId } = createService();
    const tiers = fullValidTiers().slice(0, 4);

    await expect(
      service.putPolicy(String(ownerUserId), String(business?._id), {
        tiers,
        noShowPercentage: 20,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("dedupes a duplicate tier entry, keeping the last one (defense in depth beyond Zod)", async () => {
    const { service, business, ownerUserId } = createService();
    const tiers: CancellationTierRuleDto[] = [
      ...fullValidTiers().filter((rule) => rule.tier !== "MORE_THAN_72_HOURS"),
      { tier: "MORE_THAN_72_HOURS", mode: "PERCENTAGE", percentage: 25 },
      { tier: "MORE_THAN_72_HOURS", mode: "FREE" },
    ];

    const result = await service.putPolicy(String(ownerUserId), String(business?._id), {
      tiers,
      noShowPercentage: 20,
    });

    const moreThan72Entries = result.tiers.filter((rule) => rule.tier === "MORE_THAN_72_HOURS");
    expect(moreThan72Entries).toHaveLength(1);
    expect(moreThan72Entries[0]).toEqual({ tier: "MORE_THAN_72_HOURS", mode: "FREE" });
  });

  it("keeps depositCents/platformFeeCents concerns out of scope — this module never mentions them", async () => {
    // Documents the deliberate boundary: this service persists ONLY cancellation/no-show
    // fee configuration, never a deposit formula and never platform-fee logic (those remain
    // entirely separate concerns per the confirmed product rules).
    const { service, business, ownerUserId } = createService();
    const result = await service.putPolicy(String(ownerUserId), String(business?._id), {
      tiers: fullValidTiers(),
      noShowPercentage: 20,
    });

    expect(result).not.toHaveProperty("depositCents");
    expect(result).not.toHaveProperty("platformFeeCents");
  });

  it("rejects a non-owner user", async () => {
    const { service, business } = createService();
    const unrelatedUserId = String(new Types.ObjectId());

    await expect(service.getPolicy(unrelatedUserId, String(business?._id))).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      service.putPolicy(unrelatedUserId, String(business?._id), {
        tiers: fullValidTiers(),
        noShowPercentage: 20,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects an unknown business id format", async () => {
    const { service, ownerUserId } = createService();
    await expect(service.getPolicy(String(ownerUserId), "not-an-id")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("reloads a persisted policy", async () => {
    const { service, business, ownerUserId } = createService();
    await service.putPolicy(String(ownerUserId), String(business?._id), {
      tiers: fullValidTiers(),
      noShowPercentage: 40,
    });

    const result = await service.getPolicy(String(ownerUserId), String(business?._id));

    expect(result.configured).toBe(true);
    expect(result.noShowPercentage).toBe(40);
  });
});
