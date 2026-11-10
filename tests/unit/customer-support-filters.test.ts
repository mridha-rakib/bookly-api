import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createErrorHandler } from "../../src/common/middleware/error-handler.js";
import { TokenService } from "../../src/modules/auth/token.service.js";
import { createSupportRoute } from "../../src/modules/support/support.route.js";
import { listSupportTicketsQuerySchema } from "../../src/modules/support/support.schema.js";
import { supportTicketStatuses } from "../../src/modules/support/support.types.js";
import {
  type SupportTicketDocument,
  SupportTicketModel,
} from "../../src/modules/support/support-ticket.model.js";
import { SupportTicketRepository } from "../../src/modules/support/support-ticket.repository.js";
import { UserRepository } from "../../src/modules/user/user.repository.js";

const A = "650000000000000000000001",
  B = "650000000000000000000002",
  SUSPENDED = "650000000000000000000003";
let rows: SupportTicketDocument[];
const base = Date.parse("2026-11-01T09:00:00Z");
const matches = (row: SupportTicketDocument, filter: Record<string, unknown>) => {
  if (String(filter["requesterUserId"]) !== String(row.requesterUserId)) return false;
  if (filter["status"] && filter["status"] !== row.status) return false;
  const or = filter["$or"] as Array<{ subject?: RegExp; reference?: RegExp }> | undefined;
  return (
    !or ||
    or.some((entry) => entry.subject?.test(row.subject) || entry.reference?.test(row.reference))
  );
};
const compare = (a: SupportTicketDocument, b: SupportTicketDocument) =>
  +b.createdAt - +a.createdAt || String(b._id).localeCompare(String(a._id));
beforeEach(() => {
  rows = [A, B].flatMap((owner, ownerIndex) =>
    Array.from({ length: 55 }, (_, index) => ({
      _id: new Types.ObjectId((ownerIndex * 100 + index + 1).toString(16).padStart(24, "0")),
      requesterUserId: new Types.ObjectId(owner),
      requesterRole: "CUSTOMER" as const,
      reference: `SUP-${ownerIndex ? "BBB" : "AAA"}-${index + 1}`,
      subject:
        index === 0
          ? "Literal [card].* (refund)?"
          : `${index % 2 ? "Shared REFUND" : "Account help"} ${index}`,
      status: supportTicketStatuses[index % 4] ?? "OPEN",
      createdAt: new Date(base + Math.floor(index / 3) * 60_000),
      updatedAt: new Date(base),
      statusHistory: [],
    })),
  );
  vi.spyOn(SupportTicketModel, "find").mockImplementation(((filter: Record<string, unknown>) => {
    let skip = 0,
      limit = 20;
    const chain = {
      maxTimeMS: vi.fn().mockReturnThis(),
      sort: vi.fn().mockReturnThis(),
      skip: (value: number) => {
        skip = value;
        return chain;
      },
      limit: (value: number) => {
        limit = value;
        return chain;
      },
      exec: async () =>
        rows
          .filter((row) => matches(row, filter))
          .sort(compare)
          .slice(skip, skip + limit),
    };
    return chain;
  }) as never);
  vi.spyOn(SupportTicketModel, "countDocuments").mockImplementation(((
    filter: Record<string, unknown>,
  ) => ({
    maxTimeMS: () => ({ exec: async () => rows.filter((row) => matches(row, filter)).length }),
  })) as never);
  vi.spyOn(SupportTicketModel, "findOne").mockImplementation(((
    filter: Record<string, unknown>,
  ) => ({
    exec: async () =>
      rows.find(
        (row) =>
          String(row._id) === String(filter["_id"]) &&
          String(row.requesterUserId) === String(filter["requesterUserId"]),
      ) ?? null,
  })) as never);
  vi.spyOn(TokenService.prototype, "verifyAccessToken").mockImplementation(async (token) => ({
    sub: token,
    role: "CUSTOMER",
    sid: "family",
  }));
  vi.spyOn(TokenService.prototype, "isAccessTokenSessionLive").mockResolvedValue(true);
  vi.spyOn(UserRepository.prototype, "findById").mockImplementation(
    async (id) =>
      ({
        _id: new Types.ObjectId(String(id)),
        role: "CUSTOMER",
        status: String(id) === SUSPENDED ? "SUSPENDED" : "ACTIVE",
      }) as never,
  );
});
afterEach(() => vi.restoreAllMocks());
const app = () => {
  const server = express();
  server.use("/me", createSupportRoute());
  server.use(createErrorHandler());
  return server;
};
const list = (query: object = {}, actor = A) =>
  request(app()).get("/me/support/tickets").set("Authorization", `Bearer ${actor}`).query(query);

describe("Customer ticket search/status HTTP contract", () => {
  it("retains unfiltered 20-item paging with accurate own total and stable tie order", async () => {
    const response = await list();
    expect(response.status).toBe(200);
    expect(response.body.data.pagination).toEqual({ page: 1, limit: 20, total: 55 });
    const expected = rows.filter((row) => String(row.requesterUserId) === A).sort(compare);
    expect(response.body.data.tickets.map((row: { id: string }) => row.id)).toEqual(
      expected.slice(0, 20).map((row) => String(row._id)),
    );
    const pages = await Promise.all([list({ page: "2" }), list({ page: "3" })]);
    expect(pages.map((response) => response.body.data.tickets.length)).toEqual([20, 15]);
    expect(
      new Set(
        [
          ...response.body.data.tickets,
          ...pages.flatMap((response) => response.body.data.tickets),
        ].map((row: { id: string }) => row.id),
      ).size,
    ).toBe(55);
  });
  it("trims and searches subjects case-insensitively before filtering totals and pagination", async () => {
    const response = await list({ q: "  shared refund  ", page: "2" });
    expect(response.status).toBe(200);
    expect(response.body.data.pagination.total).toBe(27);
    expect(response.body.data.tickets).toHaveLength(7);
    expect(
      response.body.data.tickets.every((row: { subject: string }) =>
        row.subject.startsWith("Shared REFUND"),
      ),
    ).toBe(true);
  });
  it("searches the actual persisted public reference with substring matching", async () => {
    const response = await list({ q: "sup-aaa-55" });
    expect(response.body.data.tickets.map((row: { reference: string }) => row.reference)).toEqual([
      "SUP-AAA-55",
    ]);
  });
  it("treats regex metacharacters literally", async () => {
    const response = await list({ q: "[card].* (refund)?" });
    expect(response.body.data.pagination.total).toBe(1);
    expect(response.body.data.tickets[0].subject).toBe("Literal [card].* (refund)?");
    expect((await list({ q: ".*" })).body.data.pagination.total).toBe(1);
    expect((await list({ q: "^.*$" })).body.data.pagination.total).toBe(0);
  });
  it.each(["", "   "])("empty search %j is equivalent to the ordinary list", async (q) => {
    expect((await list({ q })).body.data).toEqual((await list()).body.data);
  });
  it.each(supportTicketStatuses)("uses the persisted %s status", async (status) => {
    const response = await list({ status });
    const expected = rows.filter(
      (row) => String(row.requesterUserId) === A && row.status === status,
    );
    expect(response.body.data.pagination.total).toBe(expected.length);
    expect(
      response.body.data.tickets.every((row: { status: string }) => row.status === status),
    ).toBe(true);
  });
  it("combines status and search, with an empty later page and the correct filtered total", async () => {
    const response = await list({ q: "refund", status: "PENDING", page: "2" });
    expect(response.body.data.pagination).toEqual({ page: 2, limit: 20, total: 14 });
    expect(response.body.data.tickets).toEqual([]);
    const first = await list({ q: "refund", status: "PENDING" });
    expect(first.body.data.tickets).toHaveLength(14);
  });
  it("never discovers another Customer's matching subjects or references", async () => {
    for (const actor of [A, B]) {
      const response = await list({ q: "shared", status: "PENDING" }, actor);
      expect(
        response.body.data.tickets.every((ticket: { reference: string }) =>
          ticket.reference.includes(actor === A ? "AAA" : "BBB"),
        ),
      ).toBe(true);
      expect(JSON.stringify(response.body.data)).not.toContain("requesterUserId");
    }
    expect((await list({ q: "SUP-BBB" })).body.data.pagination.total).toBe(0);
  });
  it.each([
    { status: "IN_PROGRESS" },
    { status: "open" },
    { q: "x".repeat(101) },
    { q: { $ne: "" } },
    { q: ["refund", "help"] },
    { requesterUserId: B },
    { status: { $ne: "CLOSED" } },
    { page: "999999999999999999999" },
    { page: "1.5" },
  ])("rejects invalid queries without any ticket read: %j", async (query) => {
    expect((await list(query)).status).toBe(400);
    expect(SupportTicketModel.find).not.toHaveBeenCalled();
  });
  it("keeps anonymous and suspended requests out of the listing", async () => {
    expect((await request(app()).get("/me/support/tickets?q=refund")).status).toBe(401);
    const suspended = await list({ q: "refund" }, SUSPENDED);
    expect(suspended.status).toBe(403);
    expect(suspended.body.errors[0].code).toBe("USER_SUSPENDED");
    expect(SupportTicketModel.find).not.toHaveBeenCalled();
  });
  it("uses exactly the same ownership/search/status predicate for data and count", async () => {
    await new SupportTicketRepository().listByRequester(A, {
      q: "refund",
      status: "OPEN",
      page: 1,
      limit: 20,
    });
    const filter = vi.mocked(SupportTicketModel.find).mock.calls[0]?.[0];
    expect(SupportTicketModel.countDocuments).toHaveBeenCalledWith(filter);
    expect(filter).toMatchObject({ requesterUserId: A, status: "OPEN" });
  });
  it("leaves own-ticket detail and its anti-enumeration boundary intact", async () => {
    const own = rows.find((row) => String(row.requesterUserId) === A);
    const foreign = rows.find((row) => String(row.requesterUserId) === B);
    const get = (id: unknown) =>
      request(app()).get(`/me/support/tickets/${id}`).set("Authorization", `Bearer ${A}`);
    expect((await get(own?._id)).status).toBe(200);
    expect((await get(foreign?._id)).status).toBe(404);
  });
  it("preserves the page/limit defaults and limit cap without adding undefined filter fields", () => {
    expect(listSupportTicketsQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
    expect(listSupportTicketsQuerySchema.parse({ limit: "500", q: " " })).toEqual({
      page: 1,
      limit: 50,
    });
  });
});
