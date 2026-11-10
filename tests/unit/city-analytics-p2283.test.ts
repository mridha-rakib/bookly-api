import { afterEach, expect, it, vi } from "vitest";
import { BusinessModel } from "../../src/modules/business/business.model.js";
import { BusinessRepository } from "../../src/modules/business/business.repository.js";
import { superAdminAnalyticsPeriodQuerySchema } from "../../src/modules/super-admin/super-admin.schema.js";
import {
  aggregateOwnershipForPeriod,
  chunkRange,
} from "../../src/modules/super-admin/super-admin-analytics.util.js";

afterEach(() => vi.restoreAllMocks());
it("groups coverage using the selector's trimmed city authority without discarding unassigned businesses", async () => {
  const aggregate = vi.spyOn(BusinessModel, "aggregate").mockReturnValue({
    exec: async () => [
      { _id: "", premisesCount: 1, mobileCount: 0, approvedCount: 0 },
      { _id: "Nicosia", premisesCount: 2, mobileCount: 1, approvedCount: 2 },
    ],
  } as never);
  const rows = await new BusinessRepository().aggregateCityCoverage();
  expect(rows).toEqual([
    { city: "", premisesCount: 1, mobileCount: 0, approvedCount: 0 },
    { city: "Nicosia", premisesCount: 2, mobileCount: 1, approvedCount: 2 },
  ]);
  expect(aggregate.mock.calls[0]?.[0]).toEqual([
    expect.objectContaining({
      $group: expect.objectContaining({
        _id: { $trim: { input: { $ifNull: ["$address.city", ""] } } },
        premisesCount: {
          $sum: { $cond: [{ $in: ["$visitType", ["AT_BUSINESS_LOCATION", "location"]] }, 1, 0] },
        },
        mobileCount: {
          $sum: { $cond: [{ $in: ["$visitType", ["TRAVEL_TO_CUSTOMER", "travel"]] }, 1, 0] },
        },
      }),
    }),
    { $sort: { _id: 1 } },
  ]);
});
it("keeps 92 Cyprus days over autumn DST contiguous and within the ledger cap with the same city/day scope", async () => {
  const query = superAdminAnalyticsPeriodQuerySchema.parse({
    fromDate: "2026-08-01",
    toDate: "2026-10-31",
  });
  const from = query.fromDate;
  const to = query.toDate;
  if (!from || !to) throw new Error("Expected explicit period");
  expect((to.getTime() - from.getTime()) / 3600000).toBe(92 * 24 + 1);
  const chunks = chunkRange(from, to);
  expect(chunks).toHaveLength(2);
  expect(chunks[0]?.from).toEqual(from);
  expect(chunks[0]?.to).toEqual(chunks[1]?.from);
  expect(chunks[1]?.to).toEqual(to);
  const aggregateOwnedBySource = vi.fn(async () => [
    { type: "PLATFORM_FEE", sourceType: "BOOKING", totalCents: 100, count: 1 },
  ]);
  const scope = { businessIds: [], isoDayOfWeek: 7 };
  const result = await aggregateOwnershipForPeriod({ aggregateOwnedBySource } as never, {
    types: ["PLATFORM_FEE"],
    period: { from, to, isAllTime: false },
    scope,
  });
  expect(result).toEqual([
    { type: "PLATFORM_FEE", sourceType: "BOOKING", totalCents: 200, count: 2 },
  ]);
  for (const [input] of aggregateOwnedBySource.mock.calls as unknown as [
    { from: Date; to: Date; scope: unknown },
  ][]) {
    expect(input.scope).toBe(scope);
    expect(input.to.getTime() - input.from.getTime()).toBeLessThanOrEqual(92 * 86400000);
  }
});
