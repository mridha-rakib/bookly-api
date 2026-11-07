import { Writable } from "node:stream";
import type { Request, Response } from "express";
import { Types } from "mongoose";
import { afterEach, expect, it, vi } from "vitest";
import { csvRow, streamCsv } from "../../src/common/http/csv.js";
import { businessLocalToUtc } from "../../src/common/time/business-clock.js";
import { updateBusinessBodySchema } from "../../src/modules/business/business.schema.js";
import { BusinessService } from "../../src/modules/business/business.service.js";
import { toCatalogBusinessDto } from "../../src/modules/catalog/catalog.dto.js";
import { ClientController } from "../../src/modules/client/client.controller.js";
import { dashboardOverviewQuerySchema } from "../../src/modules/dashboard-overview/dashboard-overview.schema.js";
import { DashboardOverviewService } from "../../src/modules/dashboard-overview/dashboard-overview.service.js";
import { FinanceController } from "../../src/modules/finance/finance.controller.js";
import { buildBusiness } from "./stage-b-fixtures.js";

afterEach(() => vi.useRealTimers());
it("Client CSV keeps authenticated actor, Business and directory filters on every exported page", async () => {
  const list = vi.fn(
    async (_actor: string, _role: string, _business: string, query: { page: number }) => ({
      clients: [
        {
          firstName: `Client${query.page}`,
          email: "=formula",
          phone: { e164: "+35799" },
          createdAt: "2030-01-15T00:00:00Z",
        },
      ],
      pagination: { total: 2 },
    }),
  );
  const response = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  Object.assign(response, { setHeader: vi.fn() });
  await new ClientController({ listClients: list } as never).exportCsv(
    {
      auth: { userId: "owner", role: "BUSINESS_OWNER" },
      validated: {
        params: { businessId: "business" },
        query: { q: "Client", tag: "VIP", archived: true, page: 6, limit: 20 },
      },
    } as unknown as Request,
    response as unknown as Response,
  );
  expect(list).toHaveBeenCalledTimes(2);
  expect(list).toHaveBeenNthCalledWith(1, "owner", "BUSINESS_OWNER", "business", {
    q: "Client",
    tag: "VIP",
    archived: true,
    page: 1,
    limit: 100,
  });
  expect(list).toHaveBeenNthCalledWith(
    2,
    "owner",
    "BUSINESS_OWNER",
    "business",
    expect.objectContaining({ page: 2 }),
  );
});
it("Finance CSV retains the selected reporting period and Owner scope", async () => {
  const list = vi.fn(async () => ({ rows: [], total: 0 })),
    response = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
  Object.assign(response, { setHeader: vi.fn() });
  const from = new Date("2030-01-01T00:00:00Z"),
    to = new Date("2030-02-01T00:00:00Z");
  await new FinanceController({ listTransactions: list } as never).exportTransactions(
    {
      auth: { userId: "owner" },
      validated: { params: { businessId: "business" }, query: { from, to, page: 6 } },
    } as unknown as Request,
    response as unknown as Response,
  );
  expect(list).toHaveBeenCalledWith("owner", "business", { from, to }, { page: 1, limit: 100 });
});
it("quotes and neutralizes spreadsheet formulas including leading whitespace/control characters", () => {
  expect(csvRow(['=HYPERLINK("bad")', " +cmd", "\t@SUM(1)", "-42", 'a,"b"\nc', "ordinary"])).toBe(
    '"\'=HYPERLINK(""bad"")","\' +cmd","\'\t@SUM(1)","\'-42","a,""b""\nc","ordinary"\r\n',
  );
});
it("streams complete matching pages rather than a loaded page, retaining bounded page reads", async () => {
  const chunks: string[] = [],
    response = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(String(chunk));
        done();
      },
    });
  Object.assign(response, { setHeader: vi.fn() });
  const load = vi.fn(async (page: number) => ({
    rows: Array.from({ length: page === 3 ? 5 : 100 }, (_, i) => (page - 1) * 100 + i),
    total: 205,
  }));
  await streamCsv(response as unknown as Response, "clients.csv", ["ID"], load, (row) => [row]);
  expect(load.mock.calls.map((call) => call[0])).toEqual([1, 2, 3]);
  expect(chunks.join("")).toContain('"204"\r\n');
  expect(chunks.join("").split("\r\n")).toHaveLength(207);
});
it("authorization failure occurs before CSV headers or data are emitted", async () => {
  const setHeader = vi.fn(),
    response = { setHeader } as unknown as Response;
  await expect(
    streamCsv(
      response,
      "clients.csv",
      ["ID"],
      async () => {
        throw Error("Denied");
      },
      () => [],
    ),
  ).rejects.toThrow("Denied");
  expect(setHeader).not.toHaveBeenCalled();
});
it("applies a Business-local selected range to schedule, aggregate totals and ledger reads", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-03-31T22:30:00Z"));
  const business = buildBusiness({ timezone: "Europe/Nicosia" });
  const schedule = vi.fn(async () => []),
    totals = vi.fn(async () => ({ count: 250, remaining: 3, balanceDueCents: 9000 }));
  const noShows = vi.fn(async () => 2),
    aggregate = vi.fn(async () => []),
    recent = vi.fn(async () => []),
    finance = vi.fn(async () => 4000);
  const service = new DashboardOverviewService(
    { findById: async () => business } as never,
    {} as never,
    {
      findScheduleForBusinessOnDate: schedule,
      getOverviewRangeTotals: totals,
      countNoShowsForBusinessInRange: noShows,
      findManyByIds: async () => [],
    } as never,
    { aggregateForBusiness: aggregate, listRecentForBusiness: recent } as never,
    { getNetPayoutForBusiness: finance } as never,
  );
  const result = await service.getOverview(
    String(business.ownerUserId),
    "BUSINESS_OWNER",
    String(business._id),
    { range: "7D" },
  );
  const from = businessLocalToUtc(business.timezone, "2030-03-26", "00:00"),
    to = businessLocalToUtc(business.timezone, "2030-04-02", "00:00");
  expect(schedule).toHaveBeenCalledWith(business._id, from, to, undefined);
  expect(noShows).toHaveBeenCalledWith(business._id, from, to);
  expect(aggregate).toHaveBeenCalledWith(
    expect.objectContaining({ businessId: business._id, from, to }),
  );
  expect(recent).toHaveBeenCalledWith(business._id, 10, { from, to });
  expect(result).toMatchObject({
    todayBookingsCount: 250,
    financials: { payAtVenueDueCents: 9000 },
    period: { fromDate: "2030-03-26", toDate: "2030-04-01" },
  });
  await service.getOverview(String(business.ownerUserId), "BUSINESS_OWNER", String(business._id), {
    range: "Custom",
    fromDate: "2030-03-30",
    toDate: "2030-03-31",
  });
  expect(schedule).toHaveBeenLastCalledWith(
    business._id,
    businessLocalToUtc(business.timezone, "2030-03-30", "00:00"),
    businessLocalToUtc(business.timezone, "2030-04-01", "00:00"),
    undefined,
  );
  expect(
    dashboardOverviewQuerySchema.safeParse({
      range: "Custom",
      fromDate: "2030-04-02",
      toDate: "2030-04-01",
    }).success,
  ).toBe(false);
});
it("persists, clears and reloads Owner profile metadata without leaking registration identity to linked/catalog reads", async () => {
  const business = buildBusiness();
  const update = vi.fn(async (owner: string, _id: string, fields: object) => {
    if (owner !== String(business.ownerUserId)) return null;
    Object.assign(business, fields);
    return business;
  });
  const service = new BusinessService(
    { findById: async () => business, updateOwnedById: update } as never,
    { findByUserAndBusiness: async () => ({}) } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const input = updateBusinessBodySchema.parse({
    registrationNumber: "  REG-123  ",
    additionalInformation: [" First note "],
  });
  expect(
    await service.updateOwnedBusiness(String(business.ownerUserId), String(business._id), input),
  ).toMatchObject({ registrationNumber: "REG-123", additionalInformation: ["First note"] });
  expect(
    await service.getBusinessDetail(String(business.ownerUserId), String(business._id)),
  ).toMatchObject({ registrationNumber: "REG-123", additionalInformation: ["First note"] });
  expect(
    await service.getBusinessDetail(String(new Types.ObjectId()), String(business._id)),
  ).not.toHaveProperty("registrationNumber");
  expect(
    toCatalogBusinessDto(business, {
      openStatus: { isOpenNow: false } as never,
      hours: [],
      media: [],
    }),
  ).not.toHaveProperty("registrationNumber");
  await expect(
    service.updateOwnedBusiness(String(new Types.ObjectId()), String(business._id), input),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(
    await service.updateOwnedBusiness(String(business.ownerUserId), String(business._id), {
      registrationNumber: "",
      additionalInformation: [],
    }),
  ).toMatchObject({ registrationNumber: "", additionalInformation: [] });
  expect(
    updateBusinessBodySchema.safeParse({ additionalInformation: ["1", "2", "3", "4"] }).success,
  ).toBe(false);
});
