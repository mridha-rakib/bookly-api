import { Types } from "mongoose";
import { afterEach, expect, it, vi } from "vitest";
import { BusinessModel } from "../../src/modules/business/business.model.js";
import { CatalogService } from "../../src/modules/catalog/catalog.service.js";
import { DiscoveryRepository } from "../../src/modules/discovery/discovery.repository.js";
import { buildBusiness } from "./stage-b-fixtures.js";

afterEach(() => vi.restoreAllMocks());
it("all discovery, home ranking and Favorites enrichment exclude explicitly hidden Businesses", async () => {
  const aggregate = vi
    .spyOn(BusinessModel, "aggregate")
    .mockReturnValue({ exec: async () => [] } as never);
  const repository = new DiscoveryRepository();
  await repository.search({}, "ratingHighToLow", { page: 1, limit: 20 });
  await repository.getCardsByIds([new Types.ObjectId()]);
  await repository.rankRecommended({
    excludeIds: [],
    limit: 10,
    affinity: { categories: [], cities: [] },
  });
  await repository.rankNearYou({ excludeIds: [], limit: 10 });
  await repository.rankByPopularity({ excludeIds: [], limit: 10 });
  expect(aggregate).toHaveBeenCalledTimes(5);
  for (const call of aggregate.mock.calls)
    expect(call[0]?.[0]).toMatchObject({ $match: { publicVisible: { $ne: false } } });
  expect(aggregate.mock.calls[0]?.[0]?.[0]).toMatchObject({
    $match: { status: { $in: ["APPROVED", "WARNING"] } },
  });
});
it("marketing partners and distinct categories apply the same visibility predicate", async () => {
  const find = vi
    .spyOn(BusinessModel, "find")
    .mockReturnValue({ sort: () => ({ lean: () => ({ exec: async () => [] }) }) } as never);
  const distinct = vi
    .spyOn(BusinessModel, "distinct")
    .mockReturnValue({ exec: async () => [] } as never);
  const repository = new DiscoveryRepository();
  await repository.listFoundingPartners();
  await repository.listDistinctCategories();
  expect(find.mock.calls[0]?.[0]).toMatchObject({
    publicVisible: { $ne: false },
    status: { $in: ["APPROVED", "WARNING"] },
  });
  expect(distinct.mock.calls[0]?.[1]).toMatchObject({ publicVisible: { $ne: false } });
});
it("unlisted Businesses retain direct-link catalog access; suspension and approval remain authoritative", async () => {
  const business = buildBusiness({ publicVisible: false });
  const service = new CatalogService(
    { findById: async () => business } as never,
    { listByBusinessId: async () => [] } as never,
    {} as never,
    {} as never,
    { listActiveByBusinessId: async () => [] } as never,
    { findProfilesByUserIds: async () => [] } as never,
    {} as never,
    { findByBusinessId: async () => null } as never,
    { listByBusinessId: async () => [] } as never,
    { getAvatarUrlsByUserIds: async () => new Map() } as never,
    {} as never,
  );
  expect((await service.getBusinessCatalog(String(business._id))).business.id).toBe(
    String(business._id),
  );
  for (const status of ["PENDING", "SUSPENDED"] as const) {
    business.status = status;
    await expect(service.getBusinessCatalog(String(business._id))).rejects.toMatchObject({
      statusCode: 404,
    });
  }
});
