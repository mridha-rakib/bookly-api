import { describe, expect, it } from "vitest";

import {
  createMarketingCampaignBodySchema,
  listMarketingCampaignsQuerySchema,
} from "../../src/modules/marketing/marketing-campaign.schema.js";

const OID = "64b7f0c2e1a2b3c4d5e6f7a8";

describe("createMarketingCampaignBodySchema", () => {
  it("accepts an ARTICLE / PROMO campaign with a source id and optional scheduledAt", () => {
    expect(
      createMarketingCampaignBodySchema.safeParse({ type: "ARTICLE", sourceId: OID }).success,
    ).toBe(true);
    expect(
      createMarketingCampaignBodySchema.safeParse({
        type: "PROMO",
        sourceId: OID,
        scheduledAt: "2030-01-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown campaign type", () => {
    expect(
      createMarketingCampaignBodySchema.safeParse({ type: "BUSINESS_ADDON", sourceId: OID })
        .success,
    ).toBe(false);
  });

  it("rejects free-typed content / audience / recipients (mass-assignment guard)", () => {
    for (const extra of [
      { subject: "hi" },
      { html: "<p>x</p>" },
      { ctaUrl: "https://evil.example" },
      { audience: { scope: "ALL_OPTED_IN" } },
      { recipients: ["a@example.com"] },
      { businessId: OID },
      { createdByUserId: OID },
      { ownerScope: "BUSINESS" },
    ]) {
      expect(
        createMarketingCampaignBodySchema.safeParse({ type: "ARTICLE", sourceId: OID, ...extra })
          .success,
      ).toBe(false);
    }
  });

  it("rejects a non-ObjectId sourceId and a non-datetime scheduledAt", () => {
    expect(
      createMarketingCampaignBodySchema.safeParse({ type: "ARTICLE", sourceId: "nope" }).success,
    ).toBe(false);
    expect(
      createMarketingCampaignBodySchema.safeParse({
        type: "ARTICLE",
        sourceId: OID,
        scheduledAt: "tomorrow",
      }).success,
    ).toBe(false);
  });
});

describe("listMarketingCampaignsQuerySchema", () => {
  it("defaults and clamps pagination", () => {
    expect(listMarketingCampaignsQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
    expect(listMarketingCampaignsQuerySchema.parse({ page: "3", limit: "9999" })).toEqual({
      page: 3,
      limit: 100,
    });
  });
});
