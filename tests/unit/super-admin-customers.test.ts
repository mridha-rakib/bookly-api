import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorHandler } from "../../src/common/middleware/error-handler.js";
import { TokenService } from "../../src/modules/auth/token.service.js";
import { BookingModel } from "../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../src/modules/booking/booking.repository.js";
import { BusinessClientModel } from "../../src/modules/client/client.model.js";
import { createSuperAdminRoute } from "../../src/modules/super-admin/super-admin.route.js";
import { superAdminCustomerDetailQuerySchema } from "../../src/modules/super-admin/super-admin.schema.js";
import { SuperAdminCustomerRepository } from "../../src/modules/super-admin/super-admin-customer.repository.js";
import {
  customerCsvRow,
  SuperAdminCustomerService,
} from "../../src/modules/super-admin/super-admin-customer.service.js";
import {
  type UserDocument,
  UserModel,
  type UserProfileDocument,
} from "../../src/modules/user/user.model.js";
import { UserRepository } from "../../src/modules/user/user.repository.js";
import { buildBooking } from "./stage-b-fixtures.js";

afterEach(() => vi.restoreAllMocks());
const customerId = new Types.ObjectId();
const user = {
  _id: customerId,
  role: "CUSTOMER",
  status: "ACTIVE",
  normalizedEmail: "customer@example.com",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  passwordHash: "never-expose",
} as UserDocument;
const summary = {
  businessCount: 2,
  hasSavedCard: true,
  savedCard: { brand: "visa", last4: "4242" },
};

function fixture() {
  const list = vi
    .spyOn(UserRepository.prototype, "listByRole")
    .mockResolvedValue({ users: [user], total: 1 });
  vi.spyOn(UserRepository.prototype, "findById").mockImplementation(async (id) => {
    if (String(id) === String(customerId)) return user;
    return {
      ...user,
      _id: new Types.ObjectId(String(id)),
      role: String(id).endsWith("01") ? "BUSINESS_OWNER" : "SUPER_ADMIN",
    };
  });
  vi.spyOn(UserRepository.prototype, "findProfilesByUserIds").mockResolvedValue([
    {
      userId: customerId,
      firstName: "Dana",
      lastName: "Klein",
      notifications: { marketingEmail: true },
    },
  ] as UserProfileDocument[]);
  vi.spyOn(UserRepository.prototype, "findProfileByUserId").mockResolvedValue({
    userId: customerId,
    firstName: "Dana",
    lastName: "Klein",
  } as UserProfileDocument);
  const bookings = [buildBooking({ status: "COMPLETED" }), buildBooking({ status: "UPCOMING" })];
  const history = vi
    .spyOn(BookingRepository.prototype, "listForCustomer")
    .mockResolvedValue({ bookings, total: 62 });
  vi.spyOn(SuperAdminCustomerRepository.prototype, "summaries").mockResolvedValue(
    new Map([[String(customerId), summary]]),
  );
  vi.spyOn(SuperAdminCustomerRepository.prototype, "statistics").mockResolvedValue({
    total: 62,
    completed: 52,
    noShows: 3,
    upcoming: 7,
  });
  vi.spyOn(SuperAdminCustomerRepository.prototype, "businessNames").mockResolvedValue(
    new Map(bookings.map((booking, index) => [String(booking.businessId), `Business ${index}`])),
  );
  vi.spyOn(SuperAdminCustomerRepository.prototype, "listRelationships").mockResolvedValue({
    relationships: [
      {
        id: "a",
        businessId: "a",
        businessName: "Business A",
        classification: "RETURNING",
        financialState: "CONSUMED",
        archived: false,
        lastBooking: null,
        notes: "Actual note",
      },
      {
        id: "b",
        businessId: "b",
        businessName: "Business B",
        classification: "FIRST",
        financialState: "ELIGIBLE",
        archived: false,
        lastBooking: null,
        notes: null,
      },
    ],
    pagination: { page: 1, limit: 20, total: 2 },
  });
  const service = new SuperAdminCustomerService(new UserRepository(), new BookingRepository());
  return { list, history, bookings, service };
}

describe("Super Admin Customers: real routes with mocked persistence", () => {
  let app: express.Express;
  beforeEach(() => {
    fixture();
    vi.spyOn(TokenService.prototype, "verifyAccessToken").mockImplementation(
      async (id) => ({ sub: id }) as never,
    );
    vi.spyOn(TokenService.prototype, "isAccessTokenSessionLive").mockResolvedValue(true);
    app = express();
    app.use("/super-admin", createSuperAdminRoute());
    app.use(createErrorHandler());
  });
  const adminA = "650000000000000000000002",
    adminB = "650000000000000000000003",
    owner = "650000000000000000000001";
  it("gives two authorized Super Admins the same global directory, once per identity", async () => {
    const first = await request(app)
      .get("/super-admin/customers")
      .set("Authorization", `Bearer ${adminA}`);
    const second = await request(app)
      .get("/super-admin/customers")
      .set("Authorization", `Bearer ${adminB}`);
    expect(first.status).toBe(200);
    expect(second.body.data).toEqual(first.body.data);
    expect(first.body.data.customers).toHaveLength(1);
    expect(first.body.data.customers[0]).toMatchObject({
      id: String(customerId),
      businessCount: 2,
      hasSavedCard: true,
      marketingConsent: true,
    });
    expect(JSON.stringify(first.body)).not.toContain("never-expose");
  });
  it("passes combined search/status/pagination to the server directory", async () => {
    const result = await request(app)
      .get("/super-admin/customers?q=Dana&status=SUSPENDED&page=2&limit=10")
      .set("Authorization", `Bearer ${adminA}`);
    expect(result.status).toBe(200);
    expect(UserRepository.prototype.listByRole).toHaveBeenCalledWith(
      "CUSTOMER",
      { status: "SUSPENDED", q: "Dana" },
      { page: 2, limit: 10 },
    );
  });
  it.each([
    "/customers",
    "/customers/export",
    `/customers/${customerId}`,
    `/customers/${customerId}/bookings/export`,
  ])("denies Business Owners at %s", async (path) => {
    const result = await request(app)
      .get(`/super-admin${path}`)
      .set("Authorization", `Bearer ${owner}`);
    expect(result.status).toBe(403);
    expect(UserRepository.prototype.listByRole).not.toHaveBeenCalled();
    expect(BookingRepository.prototype.listForCustomer).not.toHaveBeenCalled();
  });
  it("returns full-history KPIs and independently paginated cross-Business history/relationships", async () => {
    const result = await request(app)
      .get(`/super-admin/customers/${customerId}?page=3&relationshipsPage=2`)
      .set("Authorization", `Bearer ${adminA}`);
    expect(result.status).toBe(200);
    expect(result.body.data.statistics).toEqual({
      total: 62,
      completed: 52,
      noShows: 3,
      upcoming: 7,
    });
    expect(
      result.body.data.relationships.map((row: { classification: string }) => row.classification),
    ).toEqual(["RETURNING", "FIRST"]);
    expect(
      result.body.data.bookings.map((row: { businessName: string }) => row.businessName),
    ).toEqual(["Business 0", "Business 1"]);
    expect(BookingRepository.prototype.listForCustomer).toHaveBeenCalledWith(
      String(customerId),
      {},
      expect.objectContaining({ page: 3, limit: 20 }),
    );
  });
  it("validates detail query and rejects unsupported tenant scoping", async () => {
    const result = await request(app)
      .get(`/super-admin/customers?businessId=${customerId}`)
      .set("Authorization", `Bearer ${adminA}`);
    expect(result.status).toBe(400);
    expect(superAdminCustomerDetailQuerySchema.safeParse({ page: -1 }).success).toBe(false);
  });
  it("exports all filtered customer pages using the protected export route", async () => {
    vi.mocked(UserRepository.prototype.listByRole).mockResolvedValue({ users: [user], total: 1 });
    const result = await request(app)
      .get("/super-admin/customers/export?status=DORMANT&q=Dana")
      .set("Authorization", `Bearer ${adminA}`);
    expect(result.status).toBe(200);
    expect(result.body.data.csv).toContain("customer@example.com");
    expect(UserRepository.prototype.listByRole).toHaveBeenCalledWith(
      "CUSTOMER",
      { status: "DORMANT", q: "Dana" },
      { page: 1, limit: 100 },
    );
  });
  it("exports selected identity history and canonical paid amounts", async () => {
    const result = await request(app)
      .get(`/super-admin/customers/${customerId}/bookings/export`)
      .set("Authorization", `Bearer ${adminA}`);
    expect(result.status).toBe(200);
    expect(result.body.data.csv).toContain("Business 0");
    expect(BookingRepository.prototype.listForCustomer).toHaveBeenCalledWith(
      String(customerId),
      {},
      { page: 1, limit: 100 },
    );
  });
});

describe("Customer data and CSV correctness", () => {
  it("keeps valid Customers with zero relationships and zero bookings", async () => {
    const f = fixture();
    vi.mocked(SuperAdminCustomerRepository.prototype.summaries).mockResolvedValue(new Map());
    f.history.mockResolvedValue({ bookings: [], total: 0 });
    const result = await f.service.list({}, { page: 1, limit: 20 });
    expect(result.customers[0]).toMatchObject({
      id: String(customerId),
      businessCount: 0,
      hasSavedCard: false,
    });
    expect(result.customers).toHaveLength(1);
  });

  it("reads FIRST/RETURNING independently for each actual BusinessClient", async () => {
    const rows = [
      {
        _id: new Types.ObjectId(),
        businessId: new Types.ObjectId(),
        financialRelationship: { state: "CONSUMED" },
        notes: "Real note",
      },
      {
        _id: new Types.ObjectId(),
        businessId: new Types.ObjectId(),
        financialRelationship: { state: "ELIGIBLE" },
        activatedAt: new Date(),
      },
      { _id: new Types.ObjectId(), businessId: new Types.ObjectId() },
    ];
    const query = {
      sort: () => query,
      skip: () => query,
      limit: () => query,
      lean: () => query,
      exec: async () => rows,
    };
    vi.spyOn(BusinessClientModel, "find").mockReturnValue(query as never);
    vi.spyOn(BusinessClientModel, "countDocuments").mockReturnValue({
      exec: async () => 3,
    } as never);
    vi.spyOn(BookingModel, "aggregate").mockReturnValue({ exec: async () => [] } as never);
    vi.spyOn(SuperAdminCustomerRepository.prototype, "businessNames").mockResolvedValue(new Map());
    const result = await new SuperAdminCustomerRepository().listRelationships(
      String(customerId),
      1,
      20,
    );
    expect(result.relationships.map((row) => row.classification)).toEqual([
      "RETURNING",
      "FIRST",
      "FIRST",
    ]);
    expect(result.relationships.map((row) => row.lastBooking)).toEqual([null, null, null]);
    expect(result.relationships[0]?.notes).toBe("Real note");
  });
  it("exports every result page rather than only the visible page", async () => {
    const f = fixture();
    f.list.mockResolvedValueOnce({ users: [user], total: 101 }).mockResolvedValueOnce({
      users: [{ ...user, _id: new Types.ObjectId(), normalizedEmail: "page2@example.com" }],
      total: 101,
    });
    const exported = await f.service.exportCustomers({ q: "matching" });
    expect(exported.csv).toContain("page2@example.com");
    expect(f.list).toHaveBeenCalledTimes(2);
  });
  it("uses the canonical actual online amount rather than the pre-promo deposit", async () => {
    const f = fixture();
    const booking = f.bookings[0];
    if (!booking) throw new Error("Missing booking fixture");
    booking.financials.depositCents = 2000;
    booking.promo = { chargeCents: 500 } as typeof booking.promo;
    const detail = await f.service.getDetail(String(customerId));
    expect(detail.bookings[0]?.actualOnlinePaidCents).toBe(500);
  });
  it("does not invent online payments for manual or zero-deposit sessions", async () => {
    const f = fixture();
    const [first, second] = f.bookings;
    if (!first || !second) throw new Error("Missing booking fixtures");
    first.source = "MANUAL";
    second.financials.depositCents = 0;
    const detail = await f.service.getDetail(String(customerId));
    expect(detail.bookings.map((booking) => booking.actualOnlinePaidCents)).toEqual([0, 0]);
  });
  it("fails closed for a selected identity that is not a Customer", async () => {
    const f = fixture();
    vi.mocked(UserRepository.prototype.findById).mockResolvedValue({
      ...user,
      role: "BUSINESS_OWNER",
    });
    await expect(f.service.getDetail(String(customerId))).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(f.service.exportBookings(String(customerId))).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(f.history).not.toHaveBeenCalled();
  });
  it.each(["=SUM(A1)", "+cmd", "-cmd", "@cmd", "  =cmd", "\t=cmd", "\u0000=cmd"])(
    "neutralizes formula injection %s",
    (value) => {
      expect(customerCsvRow([value])).toBe(`"'${value}"`);
    },
  );
  it("escapes embedded quotes, commas, and line breaks", () => {
    expect(customerCsvRow(['Dana, "D"\nKlein'])).toBe('"Dana, ""D""\nKlein"');
  });
  it("calculates KPI buckets from all canonical Booking statuses", async () => {
    vi.spyOn(BookingModel, "aggregate").mockReturnValue({
      exec: async () => [
        { _id: "COMPLETED", count: 52 },
        { _id: "UPCOMING", count: 4 },
        { _id: "PENDING", count: 3 },
        { _id: "NO_SHOW_CHARGED", count: 1 },
        { _id: "NO_SHOW_WAIVED", count: 1 },
        { _id: "NO_SHOW_CANCELLED", count: 1 },
      ],
    } as never);
    expect(await new SuperAdminCustomerRepository().statistics(String(customerId))).toEqual({
      total: 62,
      completed: 52,
      noShows: 3,
      upcoming: 7,
    });
  });
  it("keeps name/email/phone search, status, and stable pagination in Mongo", async () => {
    const aggregate = vi
      .spyOn(UserModel, "aggregate")
      .mockReturnValue({ exec: async () => [{ users: [user], totals: [{ count: 1 }] }] } as never);
    const result = await new UserRepository().listByRole(
      "CUSTOMER",
      { status: "ACTIVE", q: "Dana.*" },
      { page: 2, limit: 10 },
    );
    expect(result.total).toBe(1);
    expect(JSON.stringify(aggregate.mock.calls[0])).toContain('"_id":-1');
    expect(JSON.stringify(aggregate.mock.calls[0])).toContain('"$skip":10');
    expect(JSON.stringify(aggregate.mock.calls[0])).toContain("searchProfile.phone.e164");
  });
});
