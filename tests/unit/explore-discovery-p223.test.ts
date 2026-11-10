import type { Request, Response } from "express";
import { Types } from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AvailabilityError } from "../../src/modules/availability/availability.errors.js";
import { BusinessModel } from "../../src/modules/business/business.model.js";
import { DiscoveryController } from "../../src/modules/discovery/discovery.controller.js";
import {
  DiscoveryRepository,
  distanceKmExpression,
} from "../../src/modules/discovery/discovery.repository.js";
import { listDiscoveryBusinessesQuerySchema } from "../../src/modules/discovery/discovery.schema.js";
import { DiscoveryService } from "../../src/modules/discovery/discovery.service.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Evaluates the subset of MongoDB expression operators the distance expression uses, so the
 * pipeline expression itself (not a copy of the formula) is checked. */
// biome-ignore lint/suspicious/noExplicitAny: test-only expression evaluator
const evaluate = (expr: any, doc: Record<string, any>): any => {
  if (typeof expr === "string" && expr.startsWith("$")) {
    return expr
      .slice(1)
      .split(".")
      .reduce((value, key) => value?.[key], doc);
  }
  if (typeof expr !== "object" || expr === null) return expr;
  const [op, raw] = Object.entries(expr)[0] as [string, unknown];
  const args = (Array.isArray(raw) ? raw : [raw]).map((a) => evaluate(a, doc));
  switch (op) {
    case "$degreesToRadians":
      return (args[0] * Math.PI) / 180;
    case "$subtract":
      return args[0] - args[1];
    case "$divide":
      return args[0] / args[1];
    case "$add":
      return args.reduce((a, b) => a + b, 0);
    case "$multiply":
      return args.reduce((a, b) => a * b, 1);
    case "$pow":
      return args[0] ** args[1];
    case "$sin":
      return Math.sin(args[0]);
    case "$cos":
      return Math.cos(args[0]);
    case "$asin":
      return Math.asin(args[0]);
    case "$sqrt":
      return Math.sqrt(args[0]);
    case "$min":
      return Math.min(...args);
    case "$isNumber":
      return typeof args[0] === "number";
    case "$gte":
      return args[0] >= args[1];
    case "$lte":
      return args[0] <= args[1];
    case "$and":
      return args.every(Boolean);
    case "$cond":
      return args[0] ? args[1] : args[2];
    default:
      throw new Error(`unsupported ${op}`);
  }
};

/** Independent great-circle reference (atan2 form). */
const referenceKm = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

const NICOSIA = { lat: 35.1856, lng: 33.3823 };
const LIMASSOL = { lat: 34.7071, lng: 33.0226 };

describe("query contract", () => {
  it("requires an explicit origin for radius/nearest and a date for availability", () => {
    expect(
      listDiscoveryBusinessesQuerySchema.safeParse({ nearLat: "35.1", sort: "distance" }).success,
    ).toBe(false);
    expect(listDiscoveryBusinessesQuerySchema.safeParse({ radiusKm: "10" }).success).toBe(false);
    expect(listDiscoveryBusinessesQuerySchema.safeParse({ sort: "distance" }).success).toBe(false);
    expect(
      listDiscoveryBusinessesQuerySchema.safeParse({ nearLat: "95", nearLng: "33" }).success,
    ).toBe(false);
    expect(listDiscoveryBusinessesQuerySchema.safeParse({ availWindow: "EVENING" }).success).toBe(
      false,
    );
    expect(listDiscoveryBusinessesQuerySchema.safeParse({ availDate: "2020-01-01" }).success).toBe(
      false,
    );
    expect(
      listDiscoveryBusinessesQuerySchema.safeParse({
        radiusKm: "500",
        nearLat: "35",
        nearLng: "33",
      }).success,
    ).toBe(false);

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const parsed = listDiscoveryBusinessesQuerySchema.parse({
      nearLat: "35.186",
      nearLng: "33.382",
      radiusKm: "10",
      sort: "distance",
      availDate: tomorrow,
      availWindow: "EVENING",
      availService: "Haircut",
    });
    expect(parsed.origin).toEqual({ lat: 35.186, lng: 33.382 });
    expect(parsed.radiusKm).toBe(10);
    expect(parsed.availability).toEqual({
      date: tomorrow,
      window: "EVENING",
      serviceQuery: "Haircut",
    });
  });
});

describe("Near you / distance", () => {
  it("the aggregation expression matches an independent great-circle distance, in km", () => {
    const km = evaluate(distanceKmExpression(NICOSIA), { location: LIMASSOL });
    expect(km).toBeCloseTo(referenceKm(NICOSIA, LIMASSOL), 6);
    expect(km).toBeGreaterThan(60);
    expect(km).toBeLessThan(64);
    expect(evaluate(distanceKmExpression(NICOSIA), { location: NICOSIA })).toBeCloseTo(0, 9);
    // No usable stored location is never "near".
    expect(evaluate(distanceKmExpression(NICOSIA), {})).toBeNull();
    expect(evaluate(distanceKmExpression(NICOSIA), { location: { lat: 120, lng: 33 } })).toBeNull();
  });

  it("radius filters before paging, excludes missing locations, sorts nearest first and keeps visibility rules", async () => {
    const aggregate = vi
      .spyOn(BusinessModel, "aggregate")
      .mockReturnValue({ exec: async () => [{ data: [], totalCount: [{ count: 0 }] }] } as never);
    await new DiscoveryRepository().search(
      { origin: NICOSIA, radiusKm: 10, minRating: 4 },
      "distance",
      { page: 3, limit: 12 },
    );
    const pipeline = aggregate.mock.calls[0]?.[0] as unknown as Array<Record<string, unknown>>;
    expect(pipeline[0]).toEqual({
      $match: { status: { $in: ["APPROVED", "WARNING"] }, publicVisible: { $ne: false } },
    });
    expect(pipeline[1]).toMatchObject({ $addFields: { distanceKm: expect.any(Object) } });
    expect(pipeline[2]).toEqual({ $match: { distanceKm: { $ne: null, $lte: 10 } } });
    const facet = pipeline.at(-1)?.["$facet"] as { data: Array<Record<string, unknown>> };
    expect(facet.data[0]).toEqual({ $sort: { hasNoDistance: 1, distanceSortValue: 1, _id: 1 } });
    expect(facet.data[1]).toEqual({ $skip: 24 });
    expect(facet.data[3]).toMatchObject({ $project: { distanceKm: 1 } });
  });
});

describe("Recommended and Trending", () => {
  const capture = () =>
    vi
      .spyOn(BusinessModel, "aggregate")
      .mockReturnValue({ exec: async () => [{ data: [], totalCount: [] }] } as never);
  const stagesOf = (spy: ReturnType<typeof capture>) =>
    spy.mock.calls[0]?.[0] as unknown as Array<Record<string, unknown>>;

  it("Recommended uses the signed-in Customer's own affinity, otherwise the public quality ranking", async () => {
    const getCustomerAffinity = vi.fn(async () => ({
      categories: ["Beauty"],
      cities: ["Limassol"],
    }));
    const repository = new DiscoveryRepository();
    Object.assign(repository, { getCustomerAffinity });
    const service = new DiscoveryService(repository, { listProfileByBusinessIds: async () => [] });
    const customer = new Types.ObjectId();

    let spy = capture();
    const personal = await service.search(
      { category: ["Beauty", "Fitness"] },
      "recommended",
      { page: 1, limit: 12 },
      { customerUserId: customer },
    );
    expect(getCustomerAffinity).toHaveBeenCalledWith(customer);
    expect(personal.meta).toMatchObject({ sort: "recommended", personalized: true });
    let stages = stagesOf(spy);
    expect(stages[0]).toMatchObject({ $match: { category: { $in: ["Beauty", "Fitness"] } } });
    expect(JSON.stringify(stages)).toContain('"$in":["$category",["Beauty"]]');
    expect(((stages.at(-1)?.["$facet"] ?? { data: [] }) as { data: unknown[] }).data[0]).toEqual({
      $sort: {
        affinityRank: -1,
        qualityScore: -1,
        reviewCountSortValue: -1,
        averageRatingSortValue: -1,
        _id: 1,
      },
    });

    spy.mockRestore();
    spy = capture();
    const anonymous = await service.search({}, "recommended", { page: 1, limit: 12 });
    expect(getCustomerAffinity).toHaveBeenCalledTimes(1);
    expect(anonymous.meta?.personalized).toBe(false);
    stages = stagesOf(spy);
    expect(JSON.stringify(stages)).toContain('"$in":["$category",[]]');
  });

  it("Trending counts confirmed Bookings created in the last 30 Cyprus days, with stable ties", async () => {
    const spy = capture();
    const service = new DiscoveryService(new DiscoveryRepository(), {
      listProfileByBusinessIds: async () => [],
    });
    // 22:30 UTC 6 Nov = 00:30 7 Nov in Cyprus: the 30-day window starts 9 Oct, Cyprus midnight.
    const result = await service.search(
      { city: ["Larnaca"] },
      "trending",
      { page: 2, limit: 12 },
      { now: new Date("2026-11-06T22:30:00Z") },
    );
    expect(result.meta?.trending).toMatchObject({
      from: "2026-10-08T21:00:00.000Z",
      timezone: "Europe/Nicosia",
      statuses: ["UPCOMING", "COMPLETED"],
    });
    const stages = stagesOf(spy);
    const lookup = stages
      .map((stage) => stage["$lookup"] as Record<string, unknown> | undefined)
      .find((candidate) => candidate?.["from"] === "bookings");
    expect(lookup).toMatchObject({
      from: "bookings",
      localField: "_id",
      foreignField: "businessId",
      pipeline: [
        {
          $match: {
            status: { $in: ["UPCOMING", "COMPLETED"] },
            createdAt: { $gte: new Date("2026-10-08T21:00:00.000Z") },
          },
        },
        { $count: "count" },
      ],
    });
    const facet = stages.at(-1)?.["$facet"] as { data: Array<Record<string, unknown>> };
    expect(facet.data[0]).toEqual({
      $sort: { recentBookings: -1, qualityScore: -1, reviewCountSortValue: -1, _id: 1 },
    });
    expect(facet.data[1]).toEqual({ $skip: 12 });
    expect(JSON.stringify(stages)).not.toContain("customerUserId");
  });
});

describe("availability filter (existing AvailabilityService, read-only)", () => {
  const row = (id: string, visitType = "AT_BUSINESS_LOCATION") => ({
    _id: new Types.ObjectId(id.padStart(24, "0")),
    name: `Business ${id}`,
    category: "Beauty",
    subcategories: [],
    city: "Limassol",
    visitType,
    averageRating: null,
    reviewCount: 0,
    startingPriceCents: null,
    startingPricingMode: null,
    isAvailable: true,
    location: undefined,
  });

  const build = (rows: ReturnType<typeof row>[], total = rows.length) => {
    const search = vi.fn(async (..._args: unknown[]) => ({ rows, total }));
    const services = rows.flatMap((r, i) => [
      { _id: new Types.ObjectId(), businessId: r._id, name: "Colour" },
      { _id: new Types.ObjectId(), businessId: r._id, name: i === 0 ? "Haircut" : "Massage" },
    ]);
    const getAvailability = vi.fn();
    const service = new DiscoveryService(
      { search } as never,
      { listProfileByBusinessIds: async () => [] },
      undefined,
      { getAvailability },
      { listActiveBookableByBusinessIds: vi.fn(async () => services) as never },
    );
    return { service, search, getAvailability, services };
  };
  const day = (startAts: string[]) => ({
    timezone: "Europe/Nicosia",
    days: [{ date: "2026-03-29", isOpen: true, slots: startAts.map((startAt) => ({ startAt })) }],
  });
  const now = new Date("2026-03-28T10:00:00Z");

  it("matches windows on the Business's own clock across DST and returns the earliest real slot", async () => {
    const { service, getAvailability } = build([row("1"), row("2")]);
    // 29 March 2026 is the spring change (UTC+3 afterwards): 14:30Z is 17:30 local = EVENING,
    // although the UTC hour (14) would look like afternoon. 08:00Z is 11:00 local = MORNING.
    getAvailability.mockImplementation(async ({ businessId }: { businessId: string }) =>
      businessId.endsWith("1")
        ? day(["2026-03-29T08:00:00.000Z"])
        : day(["2026-03-29T14:30:00.000Z"]),
    );
    const evening = await service.search(
      {},
      "mostRelevant",
      { page: 1, limit: 12 },
      {
        availability: { date: "2026-03-29", window: "EVENING" },
        now,
      },
    );
    expect(evening.businesses.map((b) => b.name)).toEqual(["Business 2"]);
    expect(evening.businesses[0]?.availability).toMatchObject({
      firstSlotStartAt: "2026-03-29T14:30:00.000Z",
    });
    expect(evening.pagination.total).toBe(1);

    const morning = await service.search(
      {},
      "mostRelevant",
      { page: 1, limit: 12 },
      {
        availability: { date: "2026-03-29", window: "MORNING" },
        now,
      },
    );
    expect(morning.businesses.map((b) => b.name)).toEqual(["Business 1"]);
    for (const call of getAvailability.mock.calls) {
      expect(call[0]).toMatchObject({ fromDate: "2026-03-29", toDate: "2026-03-29" });
    }
  });

  it("a service query narrows the services checked; unbookable services are skipped, other failures surface", async () => {
    const { service, getAvailability, services } = build([row("1")]);
    getAvailability.mockResolvedValue(day(["2026-03-29T09:00:00.000Z"]));
    await service.search(
      {},
      "mostRelevant",
      { page: 1, limit: 12 },
      {
        availability: { date: "2026-03-29", window: "ANY", serviceQuery: "hair" },
        now,
      },
    );
    expect(getAvailability).toHaveBeenCalledTimes(1);
    expect(getAvailability.mock.calls[0]?.[0]).toMatchObject({
      serviceId: String(services[1]?._id),
    });

    getAvailability.mockReset();
    getAvailability.mockRejectedValueOnce(
      new AvailabilityError("AVAILABILITY_SERVICE_NOT_FOUND", 404),
    );
    getAvailability.mockResolvedValueOnce(day(["2026-03-29T09:00:00.000Z"]));
    const skipped = await service.search(
      {},
      "mostRelevant",
      { page: 1, limit: 12 },
      {
        availability: { date: "2026-03-29", window: "ANY" },
        now,
      },
    );
    expect(skipped.businesses[0]?.availability?.serviceName).toBe("Haircut");

    getAvailability.mockReset();
    getAvailability.mockRejectedValue(new Error("database unavailable"));
    await expect(
      service.search(
        {},
        "mostRelevant",
        { page: 1, limit: 12 },
        { availability: { date: "2026-03-29", window: "ANY" }, now },
      ),
    ).rejects.toThrow("database unavailable");
  });

  it("past slots, mobile businesses without one city, pagination and the candidate bound are truthful", async () => {
    const rows = [row("1"), row("2", "TRAVEL_TO_CUSTOMER"), row("3"), row("4")];
    const { service, getAvailability, search } = build(rows, 75);
    getAvailability.mockImplementation(async ({ businessId }: { businessId: string }) =>
      businessId.endsWith("1")
        ? day(["2026-03-28T09:00:00.000Z"]) // already in the past relative to `now`
        : day(["2026-03-29T09:00:00.000Z"]),
    );
    const page2 = await service.search(
      { city: ["Limassol", "Larnaca"] },
      "trending",
      { page: 2, limit: 1 },
      {
        availability: { date: "2026-03-29", window: "ANY" },
        now,
      },
    );
    expect(search.mock.calls[0]?.[2]).toEqual({ page: 1, limit: 60 });
    expect(page2.pagination.total).toBe(2); // Businesses 3 and 4
    expect(page2.businesses.map((b) => b.name)).toEqual(["Business 4"]);
    expect(page2.meta?.availability).toMatchObject({
      candidatesChecked: 4,
      candidateLimitReached: true,
      travelBusinessesNeedCity: 1,
    });
    expect(
      getAvailability.mock.calls.some((call) => String(call[0].businessId).endsWith("2")),
    ).toBe(false);

    getAvailability.mockClear();
    await service.search(
      { city: ["Limassol"] },
      "mostRelevant",
      { page: 1, limit: 12 },
      {
        availability: { date: "2026-03-29", window: "ANY" },
        now,
      },
    );
    expect(
      getAvailability.mock.calls.find((call) => String(call[0].businessId).endsWith("2"))?.[0],
    ).toMatchObject({
      customerCity: "Limassol",
    });
  });
});

describe("controller", () => {
  it("only a CUSTOMER session personalizes; personal or location results are never cacheable", async () => {
    const search = vi.fn(async () => ({
      businesses: [],
      pagination: { page: 1, limit: 20, total: 0 },
    }));
    const controller = new DiscoveryController({ search } as never);
    const query = listDiscoveryBusinessesQuerySchema.parse({
      sort: "recommended",
      nearLat: "35.1",
      nearLng: "33.3",
    });
    const setHeader = vi.fn();
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      setHeader,
    } as unknown as Response;
    const customer = String(new Types.ObjectId());
    await controller.search(
      { validated: { query }, auth: { userId: customer, role: "CUSTOMER" } } as unknown as Request,
      response,
    );
    await controller.search(
      {
        validated: { query },
        auth: { userId: customer, role: "BUSINESS_OWNER" },
      } as unknown as Request,
      response,
    );
    expect(
      String(
        (search.mock.calls[0] as unknown[])[3] &&
          ((search.mock.calls[0] as unknown[])[3] as { customerUserId: unknown }).customerUserId,
      ),
    ).toBe(customer);
    expect(
      ((search.mock.calls[1] as unknown[])[3] as { customerUserId: unknown }).customerUserId,
    ).toBeUndefined();
    expect(((search.mock.calls[0] as unknown[])[0] as { origin: unknown }).origin).toEqual({
      lat: 35.1,
      lng: 33.3,
    });
    expect(setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });
});
