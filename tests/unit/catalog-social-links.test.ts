import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import type { BusinessDocument } from "../../src/modules/business/business.model.js";
import { updateBusinessBodySchema } from "../../src/modules/business/business.schema.js";
import { toCatalogBusinessDto } from "../../src/modules/catalog/catalog.dto.js";

/** The public venue catalog publishes a Business's saved social accounts, and only values that
 * satisfy the Business Profile's own save rules. */
const business = (over: Partial<BusinessDocument> = {}) =>
  ({
    _id: new Types.ObjectId(),
    name: "Aurelia Hair & Beauty Studio",
    category: "Beauty & Wellness",
    subcategories: ["Hair"],
    briefDescription: "Hair and beauty",
    visitType: "AT_BUSINESS_LOCATION",
    timezone: "Asia/Nicosia",
    address: { city: "Larnaca", area: "Larnaca", streetName: "Main", streetNumber: "1" },
    ...over,
  }) as unknown as BusinessDocument;
const extra = {
  openStatus: { configured: false, isOpen: false, label: "Hours not available" },
  hours: [],
  media: [],
};
const dto = (over: Partial<BusinessDocument>) => toCatalogBusinessDto(business(over), extra);

describe("catalog Business social accounts", () => {
  it("publishes a saved Instagram handle (without @) and Facebook Page URL", () => {
    expect(
      dto({
        instagramHandle: "@aurelia.studio",
        facebookPageUrl: "https://www.facebook.com/aurelia.studio",
      }),
    ).toMatchObject({
      instagramHandle: "aurelia.studio",
      facebookPageUrl: "https://www.facebook.com/aurelia.studio",
    });
    expect(
      dto({ instagramHandle: "aurelia_studio", facebookPageUrl: "https://facebook.com/aurelia" }),
    ).toMatchObject({
      instagramHandle: "aurelia_studio",
      facebookPageUrl: "https://facebook.com/aurelia",
    });
  });

  it("omits both fields when none are saved", () => {
    const result = dto({});
    expect(result).not.toHaveProperty("instagramHandle");
    expect(result).not.toHaveProperty("facebookPageUrl");
    const blank = dto({ instagramHandle: "  ", facebookPageUrl: "" });
    expect(blank).not.toHaveProperty("instagramHandle");
    expect(blank).not.toHaveProperty("facebookPageUrl");
  });

  it("never publishes values that fail the Business Profile save rules", () => {
    for (const instagramHandle of ["not a handle!", "@", "a/b", "x".repeat(61), "javascript:x"])
      expect(dto({ instagramHandle })).not.toHaveProperty("instagramHandle");
    for (const facebookPageUrl of [
      "http://facebook.com/aurelia",
      "https://facebook.com.evil.example/aurelia",
      "https://evil.example/https://facebook.com/aurelia",
      "https://user:pw@facebook.com/aurelia",
      "javascript:alert(1)//https://facebook.com/",
      "facebook.com/aurelia",
      "https://m.facebook.com/aurelia",
    ])
      expect(dto({ facebookPageUrl })).not.toHaveProperty("facebookPageUrl");
  });

  it("publishes exactly what the Business Profile save rule accepts", () => {
    const saved = updateBusinessBodySchema.parse({
      instagramHandle: " @aurelia.studio ",
      facebookPageUrl: " https://www.facebook.com/aurelia.studio ",
    });
    expect(
      dto({
        ...(saved.instagramHandle ? { instagramHandle: saved.instagramHandle } : {}),
        ...(saved.facebookPageUrl ? { facebookPageUrl: saved.facebookPageUrl } : {}),
      }),
    ).toMatchObject({
      instagramHandle: "aurelia.studio",
      facebookPageUrl: "https://www.facebook.com/aurelia.studio",
    });
    expect(() => updateBusinessBodySchema.parse({ instagramHandle: "not a handle!" })).toThrow();
    expect(() =>
      updateBusinessBodySchema.parse({ facebookPageUrl: "https://facebook.com.evil.example/x" }),
    ).toThrow();
  });
});
