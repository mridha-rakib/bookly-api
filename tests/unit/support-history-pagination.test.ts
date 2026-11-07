import type { Request, Response } from "express";
import { Types } from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminSupportController } from "../../src/modules/super-admin/super-admin-support.controller.js";
import { SuperAdminSupportService } from "../../src/modules/super-admin/super-admin-support.service.js";
import { SupportController } from "../../src/modules/support/support.controller.js";
import { createSupportRoute } from "../../src/modules/support/support.route.js";
import {
  listSupportMessagesQuerySchema,
  listSupportTicketsQuerySchema,
} from "../../src/modules/support/support.schema.js";
import { SupportService } from "../../src/modules/support/support.service.js";
import { SupportMessageModel } from "../../src/modules/support/support-message.model.js";
import { SupportMessageRepository } from "../../src/modules/support/support-message.repository.js";
import { SupportTicketModel } from "../../src/modules/support/support-ticket.model.js";
import { SupportTicketRepository } from "../../src/modules/support/support-ticket.repository.js";

afterEach(() => vi.restoreAllMocks());

const base = new Date("2026-11-01T09:00:00.000Z").getTime();
/** 130 messages; three share each createdAt, so page boundaries fall inside identical timestamps. */
const conversation = Array.from({ length: 130 }, (_, index) => ({
  _id: new Types.ObjectId(),
  ticketId: new Types.ObjectId(),
  senderUserId: new Types.ObjectId(),
  senderRole: index % 2 ? "SUPER_ADMIN" : "CUSTOMER",
  message: `Message ${index + 1}`,
  createdAt: new Date(base + Math.floor(index / 3) * 60_000),
}));

type Row = (typeof conversation)[number];
const compareDesc = (a: Row, b: Row) =>
  b.createdAt.getTime() - a.createdAt.getTime() || String(b._id).localeCompare(String(a._id));

/** In-memory evaluation of exactly the filter/sort/limit the repository sends to MongoDB. */
const mockMessageModel = (rows: Row[]) => {
  const finds: Array<{ filter: Record<string, unknown>; sort?: unknown; limit?: number }> = [];
  vi.spyOn(SupportMessageModel, "find").mockImplementation(((filter: Record<string, unknown>) => {
    const call: (typeof finds)[number] = { filter };
    finds.push(call);
    const chain = {
      sort: (sort: unknown) => {
        call.sort = sort;
        return chain;
      },
      limit: (limit: number) => {
        call.limit = limit;
        return chain;
      },
      exec: async () => {
        const or = filter["$or"] as
          | [{ createdAt: { $lt: Date } }, { createdAt: Date; _id: { $lt: Types.ObjectId } }]
          | undefined;
        const matching = rows.filter((row) => {
          if (!or) return true;
          const time = or[0].createdAt.$lt.getTime();
          return (
            row.createdAt.getTime() < time ||
            (row.createdAt.getTime() === time && String(row._id) < String(or[1]._id.$lt))
          );
        });
        return matching.sort(compareDesc).slice(0, call.limit);
      },
    };
    return chain;
  }) as never);
  const counts = vi
    .spyOn(SupportMessageModel, "countDocuments")
    .mockReturnValue({ exec: async () => rows.length } as never);
  return { finds, counts };
};

const ticketFor = (requesterUserId: Types.ObjectId) => ({
  _id: new Types.ObjectId(),
  requesterUserId,
  status: "OPEN",
});

const buildService = (ticketRepository: object) =>
  new SupportService(
    ticketRepository as never,
    new SupportMessageRepository(),
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

describe("message history query contract", () => {
  it("selects latest-first cursor mode, validates cursors and keeps the legacy page contract", () => {
    const cursor = `${base}_${"a".repeat(24)}`;
    expect(listSupportMessagesQuerySchema.parse({ history: "latest" })).toEqual({
      mode: "history",
      limit: 50,
      before: undefined,
    });
    expect(listSupportMessagesQuerySchema.parse({ before: cursor, limit: "500" })).toEqual({
      mode: "history",
      limit: 100,
      before: { createdAt: new Date(base), id: "a".repeat(24) },
    });
    expect(listSupportMessagesQuerySchema.parse({ limit: "100" })).toEqual({
      mode: "page",
      page: 1,
      limit: 100,
    });
    for (const invalid of [
      { before: "not-a-cursor" },
      { before: `${base}_${"z".repeat(24)}` },
      { history: "oldest" },
      { page: "2", before: cursor },
      { history: "latest", requesterUserId: "forged" },
    ]) {
      expect(listSupportMessagesQuerySchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("G4 — bounded latest-first message history", () => {
  it("walks a >100-message conversation newest-first with no duplicate or missing message", async () => {
    const owner = new Types.ObjectId();
    const ticket = ticketFor(owner);
    const findByIdForRequester = vi.fn(async () => ticket);
    const service = buildService({ findByIdForRequester });
    const { finds, counts } = mockMessageModel(conversation);

    const first = await service.listOwnMessages(String(ticket._id), String(owner), {
      mode: "history",
      limit: 50,
    });
    expect(first.messages.map((m) => m.message)).toEqual(
      conversation.slice(80).map((m) => m.message),
    );
    expect(first.total).toBe(130);
    expect(first.history?.hasOlder).toBe(true);

    const loaded = [...first.messages];
    let cursor = first.history?.olderCursor ?? null;
    while (cursor) {
      const before = listSupportMessagesQuerySchema.parse({ before: cursor });
      const page = await service.listOwnMessages(String(ticket._id), String(owner), before);
      loaded.unshift(...page.messages);
      cursor = page.history?.olderCursor ?? null;
      if (!page.history?.hasOlder) expect(cursor).toBeNull();
    }

    expect(loaded.map((m) => m.message)).toEqual(conversation.map((m) => m.message));
    expect(new Set(loaded.map((m) => String(m._id))).size).toBe(130);
    expect(finds).toHaveLength(3);
    expect(finds.every((call) => call.limit === 51)).toBe(true);
    expect(finds[0]?.sort).toEqual({ createdAt: -1, _id: -1 });
    expect(finds[0]?.filter).toEqual({ ticketId: ticket._id });
    expect(finds[1]?.filter["ticketId"]).toBe(ticket._id);
    expect(counts).toHaveBeenCalledWith({ ticketId: ticket._id });
    // Every page, not only the first, re-ran the requester ownership check.
    expect(findByIdForRequester).toHaveBeenCalledTimes(3);
    expect(findByIdForRequester).toHaveBeenNthCalledWith(3, String(ticket._id), String(owner));
  });

  it("an older page is unaffected by replies created after its cursor", async () => {
    const owner = new Types.ObjectId();
    const ticket = ticketFor(owner);
    const service = buildService({ findByIdForRequester: async () => ticket });
    const rows = [...conversation];
    mockMessageModel(rows);
    const first = await service.listOwnMessages(String(ticket._id), String(owner), {
      mode: "history",
      limit: 50,
    });
    rows.push({
      ...(conversation[0] as Row),
      _id: new Types.ObjectId(),
      message: "New reply",
      createdAt: new Date(base + 86_400_000),
    });
    const older = await service.listOwnMessages(
      String(ticket._id),
      String(owner),
      listSupportMessagesQuerySchema.parse({ before: first.history?.olderCursor }),
    );
    expect(older.messages.map((m) => m.message)).toEqual(
      conversation.slice(30, 80).map((m) => m.message),
    );
    expect(older.total).toBe(131);
  });

  it("legacy page reads are unchanged (oldest-first offset)", async () => {
    const owner = new Types.ObjectId();
    const ticket = ticketFor(owner);
    const service = buildService({ findByIdForRequester: async () => ticket });
    const chain = {
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      exec: async () => [],
    };
    vi.spyOn(SupportMessageModel, "find").mockReturnValue(chain as never);
    vi.spyOn(SupportMessageModel, "countDocuments").mockReturnValue({
      exec: async () => 0,
    } as never);
    const result = await service.listOwnMessages(String(ticket._id), String(owner), {
      page: 3,
      limit: 100,
    });
    expect(chain.sort).toHaveBeenCalledWith({ createdAt: 1, _id: 1 });
    expect(chain.skip).toHaveBeenCalledWith(200);
    expect(result.history).toBeUndefined();
  });
});

describe("authorization and tenant isolation", () => {
  it("another requester's ticket is not found and no message page is read, for any cursor", async () => {
    const findByIdForRequester = vi.fn(async () => null);
    const service = buildService({ findByIdForRequester });
    const find = vi.spyOn(SupportMessageModel, "find");
    const attacker = String(new Types.ObjectId());
    const victimTicket = String(new Types.ObjectId());
    for (const query of [
      { mode: "history" as const, limit: 50 },
      listSupportMessagesQuerySchema.parse({ before: `${base}_${"b".repeat(24)}` }),
    ]) {
      await expect(service.listOwnMessages(victimTicket, attacker, query)).rejects.toMatchObject({
        statusCode: 404,
        details: [{ code: "SUPPORT_TICKET_NOT_FOUND" }],
      });
    }
    expect(findByIdForRequester).toHaveBeenCalledWith(victimTicket, attacker);
    expect(find).not.toHaveBeenCalled();
  });

  it("the requester controller uses only the authenticated actor, never a submitted identity", async () => {
    const listOwnMessages = vi.fn(async () => ({
      messages: [conversation[129] as Row],
      total: 130,
      history: { hasOlder: true, olderCursor: "cursor" },
    }));
    const controller = new SupportController({ listOwnMessages } as never);
    const actor = String(new Types.ObjectId());
    const ticketId = String(new Types.ObjectId());
    const query = listSupportMessagesQuerySchema.parse({ history: "latest" });
    const json = vi.fn();
    await controller.listMessages(
      {
        auth: { userId: actor, role: "CUSTOMER", status: "ACTIVE" },
        validated: { params: { ticketId }, query },
        body: { requesterUserId: "forged" },
      } as unknown as Request,
      { status: vi.fn().mockReturnThis(), json } as unknown as Response,
    );
    expect(listOwnMessages).toHaveBeenCalledWith(ticketId, actor, query);
    expect(json.mock.calls[0]?.[0]).toMatchObject({
      data: {
        messages: [{ message: "Message 130" }],
        pagination: { limit: 50, total: 130 },
        history: { hasOlder: true, olderCursor: "cursor" },
      },
    });
    expect(JSON.stringify(json.mock.calls[0]?.[0])).not.toContain("senderUserId");
  });

  it("route gates deny suspended users and non-requester roles before any message read", () => {
    const router = createSupportRoute();
    const guards = router.stack.slice(1, 3).map((layer) => layer.handle);
    for (const [role, status] of [
      ["CUSTOMER", "SUSPENDED"],
      ["STAFF", "SUSPENDED"],
      ["SUPER_ADMIN", "ACTIVE"],
    ] as const) {
      let rejection: unknown;
      for (const guard of guards) {
        if (rejection) break;
        guard(
          { auth: { userId: String(new Types.ObjectId()), role, status } } as Request,
          {} as Response,
          (error?: unknown) => {
            rejection = error;
          },
        );
      }
      expect(rejection).toMatchObject({ statusCode: 403 });
    }
  });

  it("an inactive professional membership cannot establish Business support context", async () => {
    const actor = new Types.ObjectId();
    const create = vi.fn();
    const service = new SupportService(
      { create } as never,
      new SupportMessageRepository(),
      {} as never,
      {} as never,
      {
        findActiveByUserId: async () => ({
          userId: actor,
          businessId: new Types.ObjectId(),
          role: "STAFF",
          employmentActive: false,
          removedAt: null,
        }),
      } as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.createTicket(String(actor), "STAFF", { subject: "Help", message: "Hello" }),
    ).rejects.toMatchObject({ details: [{ code: "SUPPORT_BUSINESS_CONTEXT_UNAVAILABLE" }] });
    expect(create).not.toHaveBeenCalled();
  });

  it("Super Admin message pages require an existing ticket and return the same history envelope", async () => {
    const ticket = ticketFor(new Types.ObjectId());
    const findById = vi.fn(async (id: string) => (id === String(ticket._id) ? ticket : null));
    const service = buildService({ findById });
    mockMessageModel(conversation);
    const admin = new SuperAdminSupportService(service, {} as never, {} as never, {} as never);
    const controller = new SuperAdminSupportController(admin);
    const json = vi.fn();
    await controller.listMessages(
      {
        auth: { userId: String(new Types.ObjectId()), role: "SUPER_ADMIN", status: "ACTIVE" },
        validated: {
          params: { ticketId: String(ticket._id) },
          query: listSupportMessagesQuerySchema.parse({ history: "latest", limit: "40" }),
        },
      } as unknown as Request,
      { status: vi.fn().mockReturnThis(), json } as unknown as Response,
    );
    const body = json.mock.calls[0]?.[0] as {
      data: { messages: Array<{ message: string }>; history: { hasOlder: boolean } };
    };
    expect(body.data.messages.map((m) => m.message)).toEqual(
      conversation.slice(90).map((m) => m.message),
    );
    expect(body.data.history.hasOlder).toBe(true);
    await expect(
      admin.listMessages(String(new Types.ObjectId()), { mode: "history", limit: 50 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("G3 — requester ticket list pagination", () => {
  it("pages one requester's tickets with a stable tie-broken order and accurate total", async () => {
    const chain = {
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      exec: async () => [],
    };
    const find = vi.spyOn(SupportTicketModel, "find").mockReturnValue(chain as never);
    const count = vi
      .spyOn(SupportTicketModel, "countDocuments")
      .mockReturnValue({ exec: async () => 51 } as never);
    const requester = new Types.ObjectId();
    const query = listSupportTicketsQuerySchema.parse({ page: "3", limit: "20" });
    const result = await new SupportTicketRepository().listByRequester(requester, query);
    expect(find).toHaveBeenCalledWith({ requesterUserId: requester });
    expect(count).toHaveBeenCalledWith({ requesterUserId: requester });
    expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(chain.skip).toHaveBeenCalledWith(40);
    expect(chain.limit).toHaveBeenCalledWith(20);
    expect(result.total).toBe(51);
    expect(listSupportTicketsQuerySchema.parse({ limit: "500" }).limit).toBe(50);
    expect(listSupportTicketsQuerySchema.safeParse({ requesterUserId: "forged" }).success).toBe(
      false,
    );
  });
});
