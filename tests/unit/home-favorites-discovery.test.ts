import type { Request, Response } from "express";
import { Types } from "mongoose";
import { afterEach, expect, it, vi } from "vitest";
import { BusinessModel } from "../../src/modules/business/business.model.js";
import { DiscoveryRepository } from "../../src/modules/discovery/discovery.repository.js";
import { listDiscoveryBusinessesQuerySchema } from "../../src/modules/discovery/discovery.schema.js";
import { FavoriteController } from "../../src/modules/favorite/favorite.controller.js";
import { FavoriteModel } from "../../src/modules/favorite/favorite.model.js";
import { FavoriteRepository } from "../../src/modules/favorite/favorite.repository.js";
import { createFavoriteRoute } from "../../src/modules/favorite/favorite.route.js";

afterEach(() => vi.restoreAllMocks());
it("supported discovery filters share server visibility, sorting and pagination/count aggregation", async () => {
  const aggregate = vi
    .spyOn(BusinessModel, "aggregate")
    .mockReturnValue({ exec: async () => [{ data: [], totalCount: [{ count: 0 }] }] } as never);
  const parsed = listDiscoveryBusinessesQuerySchema.parse({
    q: "  Hair.*  ",
    city: "Larnaca,Limassol",
    category: "Beauty,Fitness",
    minRating: "4.8",
    visitType: "TRAVEL_TO_CUSTOMER",
    sort: "priceLowToHigh",
    page: "2",
    limit: "12",
  });
  await new DiscoveryRepository().search(parsed, parsed.sort, {
    page: parsed.page,
    limit: parsed.limit,
  });
  const pipeline = aggregate.mock.calls[0]?.[0] as unknown as Record<string, unknown>[];
  expect(pipeline[0]).toMatchObject({
    $match: {
      status: { $in: ["APPROVED", "WARNING"] },
      publicVisible: { $ne: false },
      "address.city": { $in: ["Larnaca", "Limassol"] },
      category: { $in: ["Beauty", "Fitness"] },
      visitType: "TRAVEL_TO_CUSTOMER",
    },
  });
  const name = (pipeline[0]?.["$match"] as { name: RegExp } | undefined)?.name;
  expect(name?.test("Hair.* salon")).toBe(true);
  expect(name?.test("Haircut")).toBe(false);
  expect(pipeline).toContainEqual({ $match: { averageRating: { $gte: 4.8 } } });
  expect(pipeline.find((stage) => stage["$facet"])).toMatchObject({
    $facet: {
      data: [
        { $sort: { hasNoStartingPrice: 1, startingPriceSortValue: 1, _id: 1 } },
        { $skip: 12 },
        { $limit: 12 },
        expect.anything(),
      ],
      totalCount: [{ $count: "count" }],
    },
  });
  expect(listDiscoveryBusinessesQuerySchema.safeParse({ distance: "5" }).success).toBe(false);
  expect(listDiscoveryBusinessesQuerySchema.safeParse({ availability: "Today" }).success).toBe(
    false,
  );
});

it("actual Favorite route guards reject guests, other roles and suspended Customers", () => {
  const router = createFavoriteRoute();
  // Authentication is the first middleware. Exercise the actual installed active-user and
  // role gates with an already-resolved actor; no JWT, database or network access occurs.
  const guards = router.stack.slice(1, 3).map((layer) => layer.handle);
  for (const role of [null, "BUSINESS_OWNER", "SUPERVISOR", "STAFF", "SUPER_ADMIN", "CUSTOMER"]) {
    const request = {
      auth: role
        ? {
            userId: String(new Types.ObjectId()),
            role,
            status: role === "CUSTOMER" ? "SUSPENDED" : "ACTIVE",
          }
        : undefined,
    } as Request;
    let rejection: unknown;
    for (const guard of guards) {
      if (rejection) break;
      guard(request, {} as Response, (error?: unknown) => {
        rejection = error;
      });
    }
    expect(rejection).toMatchObject({ statusCode: 403 });
  }
  const accepted = vi.fn();
  const customer = {
    auth: { userId: String(new Types.ObjectId()), role: "CUSTOMER", status: "ACTIVE" },
  } as Request;
  for (const guard of guards) guard(customer, {} as Response, accepted);
  expect(accepted.mock.calls).toEqual([[], []]);
});

it("Favorite controller uses only the authenticated Customer and validated Business identity", async () => {
  const add = vi.fn(),
    remove = vi.fn();
  const controller = new FavoriteController({ add, remove } as never);
  const customer = String(new Types.ObjectId()),
    business = String(new Types.ObjectId());
  const request = {
    auth: { userId: customer, role: "CUSTOMER", status: "ACTIVE" },
    validated: { params: { businessId: business } },
    body: { customerUserId: "forged", serviceId: "foreign-service" },
  } as unknown as Request;
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
  await controller.add(request, response);
  await controller.remove(request, response);
  expect(add).toHaveBeenCalledWith(customer, business);
  expect(remove).toHaveBeenCalledWith(customer, business);
});

it("Favorite persistence scopes reads/removal by Customer and retains its duplicate-protecting Business index", async () => {
  const customer = new Types.ObjectId(),
    business = new Types.ObjectId();
  const find = vi
    .spyOn(FavoriteModel, "find")
    .mockReturnValue({ exec: async () => [{ businessId: business }] } as never);
  const remove = vi
    .spyOn(FavoriteModel, "deleteOne")
    .mockReturnValue({ exec: async () => ({ deletedCount: 1 }) } as never);
  const repository = new FavoriteRepository();
  expect(await repository.listBusinessIdsByCustomer(customer)).toEqual([business]);
  await repository.remove(customer, business);
  expect(find).toHaveBeenCalledWith({ customerUserId: customer }, { businessId: 1 });
  expect(remove).toHaveBeenCalledWith({ customerUserId: customer, businessId: business });
  expect(FavoriteModel.schema.indexes()).toContainEqual([
    { customerUserId: 1, businessId: 1 },
    expect.objectContaining({ unique: true }),
  ]);
});
