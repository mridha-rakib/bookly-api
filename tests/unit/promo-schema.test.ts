import { describe, expect, it } from "vitest";

import {
  createPromoBodySchema,
  updatePromoBodySchema,
} from "../../src/modules/promo/promo.schema.js";

const baseCreate = {
  code: "SUMMER",
  scope: "ALL_BOOKINGS",
  businessIds: [],
  expiresAt: "2030-01-01T00:00:00.000Z",
};

/** P2.0 — FIXED promo values are integer cents on the wire and in storage (the UI converts
 * euros -> cents). PERCENTAGE validation is unchanged. */
describe("createPromoBodySchema — FIXED value is integer cents", () => {
  it("accepts a positive integer FIXED value", () => {
    for (const value of [500, 1]) {
      const parsed = createPromoBodySchema.safeParse({ ...baseCreate, type: "FIXED", value });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.value).toBe(value);
    }
  });

  it("rejects fractional, zero and negative FIXED values", () => {
    for (const value of [5.5, 0, -100]) {
      const parsed = createPromoBodySchema.safeParse({ ...baseCreate, type: "FIXED", value });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.some((issue) => issue.path[0] === "value")).toBe(true);
    }
  });

  it("still accepts a fractional PERCENTAGE value", () => {
    const parsed = createPromoBodySchema.safeParse({
      ...baseCreate,
      type: "PERCENTAGE",
      value: 12.5,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.value).toBe(12.5);
  });
});

describe("updatePromoBodySchema — FIXED value is integer cents", () => {
  it("rejects a PATCH that sets type=FIXED with fractional cents", () => {
    expect(updatePromoBodySchema.safeParse({ type: "FIXED", value: 5.5 }).success).toBe(false);
  });

  it("accepts a PATCH that sets type=FIXED with integer cents", () => {
    expect(updatePromoBodySchema.safeParse({ type: "FIXED", value: 750 }).success).toBe(true);
  });

  it("defers single-field PATCHes to PromoService's merged-promo validation", () => {
    // Neither field alone tells the schema the effective type — PromoService.update re-validates
    // the merged type+value (covered in promo-database.integration.test.ts).
    expect(updatePromoBodySchema.safeParse({ value: 5.5 }).success).toBe(true);
    expect(updatePromoBodySchema.safeParse({ type: "FIXED" }).success).toBe(true);
  });

  it("still accepts a fractional PERCENTAGE PATCH", () => {
    expect(updatePromoBodySchema.safeParse({ type: "PERCENTAGE", value: 12.5 }).success).toBe(true);
  });
});
