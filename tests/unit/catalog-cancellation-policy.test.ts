import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import { CatalogService } from "../../src/modules/catalog/catalog.service.js";

const businessA = new Types.ObjectId();
const businessB = new Types.ObjectId();
const business = (id: Types.ObjectId, name: string) => ({
  _id: id,
  status: "APPROVED",
  name,
  category: "Beauty",
  subcategories: [],
  briefDescription: "",
  visitType: "AT_BUSINESS_LOCATION",
  timezone: "Asia/Nicosia",
  address: { city: "Larnaca", area: "Centre", streetName: "Main", streetNumber: "1" },
});
const policies = new Map<string, unknown>([
  [
    String(businessA),
    {
      tiers: [
        { tier: "MORE_THAN_72_HOURS", mode: "FREE" },
        { tier: "BETWEEN_24_AND_72_HOURS", mode: "PERCENTAGE", percentage: 20 },
        { tier: "BETWEEN_12_AND_24_HOURS", mode: "PERCENTAGE", percentage: 40 },
        { tier: "BETWEEN_2_AND_12_HOURS", mode: "PERCENTAGE", percentage: 60 },
        { tier: "UNDER_2_HOURS", mode: "PERCENTAGE", percentage: 80 },
      ],
      noShowPercentage: 90,
    },
  ],
]);
const requested: string[] = [];
const empty = async () => [];
const service = (withPolicyRepository: boolean) =>
  new CatalogService(
    {
      findById: async (id: string) =>
        [business(businessA, "Aurelia"), business(businessB, "Bodhi")].find(
          (b) => String(b._id) === id,
        ) ?? null,
    } as never,
    { listByBusinessId: empty } as never,
    {} as never,
    {} as never,
    { listActiveByBusinessId: empty } as never,
    { findProfilesByUserIds: empty } as never,
    {} as never,
    { findByBusinessId: async () => null } as never,
    { listByBusinessId: empty } as never,
    { getAvatarUrlsByUserIds: async () => new Map() } as never,
    { getObjectUrl: async () => "" } as never,
    undefined,
    withPolicyRepository
      ? {
          findByBusinessId: async (id: Types.ObjectId | string) => {
            requested.push(String(id));
            return (policies.get(String(id)) ?? null) as never;
          },
        }
      : undefined,
  );

describe("public catalog cancellation policy", () => {
  it("returns only the requested Business's configured rates", async () => {
    const catalog = await service(true).getBusinessCatalog(String(businessA));
    expect(catalog.business.cancellationPolicy).toEqual(policies.get(String(businessA)));
    expect(requested.at(-1)).toBe(String(businessA));
  });
  it("reports a Business without a policy as null, never another Business's policy or a default", async () => {
    const catalog = await service(true).getBusinessCatalog(String(businessB));
    expect(catalog.business.cancellationPolicy).toBeNull();
    expect(requested.at(-1)).toBe(String(businessB));
  });
  it("omits the policy when it was not read, rather than claiming none exists", async () => {
    const catalog = await service(false).getBusinessCatalog(String(businessA));
    expect(catalog.business).not.toHaveProperty("cancellationPolicy");
  });
});
