import { Types } from "mongoose";
import { afterEach, expect, it, vi } from "vitest";
import { BookingModel } from "../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../src/modules/booking/booking.repository.js";
import { BookingService } from "../../src/modules/booking/booking.service.js";
import { BusinessHoursRepository } from "../../src/modules/business-hours/business-hours.repository.js";
import { BusinessClientModel } from "../../src/modules/client/client.model.js";
import { ClientRepository } from "../../src/modules/client/client.repository.js";
import { buildBusiness } from "./stage-b-fixtures.js";

afterEach(() => vi.restoreAllMocks());
function queryChain() {
  const chain = { sort: vi.fn(), skip: vi.fn(), limit: vi.fn(), exec: vi.fn(async () => []) };
  chain.sort.mockReturnValue(chain);
  chain.skip.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return chain;
}
it.each([false, true])(
  "Business Client page 6 retains tenant, archived=%s, literal search and stable ordering",
  async (archivedOnly) => {
    const chain = queryChain(),
      businessId = new Types.ObjectId();
    const find = vi.spyOn(BusinessClientModel, "find").mockReturnValue(chain as never);
    const count = vi
      .spyOn(BusinessClientModel, "countDocuments")
      .mockReturnValue({ exec: async () => 121 } as never);
    expect(
      await new ClientRepository().listByBusinessId(businessId, {
        archivedOnly,
        page: 6,
        limit: 20,
        q: "Client.*",
        tag: "VIP",
      }),
    ).toEqual({ clients: [], total: 121 });
    const predicate = find.mock.calls[0]?.[0];
    expect(predicate).toMatchObject({
      businessId,
      tag: "VIP",
      archivedAt: { $exists: archivedOnly },
    });
    expect(JSON.stringify(predicate)).toBe(JSON.stringify(count.mock.calls[0]?.[0]));
    expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(chain.skip).toHaveBeenCalledWith(100);
    expect(chain.limit).toHaveBeenCalledWith(20);
    const regex = (predicate as unknown as { $or: { firstName: RegExp }[] }).$or[0]?.firstName;
    expect(regex?.test("Client.*")).toBe(true);
    expect(regex?.test("Client ABC")).toBe(false);
  },
);
it("canonical history search keeps Business/Client/status predicates on both page and count", async () => {
  const chain = queryChain(),
    businessId = new Types.ObjectId(),
    clientId = new Types.ObjectId();
  const find = vi.spyOn(BookingModel, "find").mockReturnValue(chain as never);
  const count = vi
    .spyOn(BookingModel, "countDocuments")
    .mockReturnValue({ exec: async () => 121 } as never);
  expect(
    await new BookingRepository().listForBusiness(
      businessId,
      { businessClientId: clientId, reference: "BK-101.*", status: ["COMPLETED"] },
      { page: 6, limit: 20 },
    ),
  ).toEqual({ bookings: [], total: 121 });
  const predicate = find.mock.calls[0]?.[0];
  expect(predicate).toMatchObject({
    businessId,
    "customer.businessClientId": clientId,
    status: { $in: ["COMPLETED"] },
  });
  expect(predicate).toEqual(count.mock.calls[0]?.[0]);
  const regex = (predicate as unknown as { reference: RegExp }).reference;
  expect(regex?.test("bk-101.*")).toBe(true);
  expect(regex?.test("BK-101XXX")).toBe(false);
  expect(chain.skip).toHaveBeenCalledWith(100);
  expect(chain.sort).toHaveBeenCalledWith({ "schedule.startAt": -1, _id: -1 });
});
it.each(["BUSINESS_OWNER", "SUPERVISOR"] as const)(
  "exposes only scoped calendar presentation to authorized %s",
  async (role) => {
    const business = buildBusiness(),
      actor = role === "BUSINESS_OWNER" ? business.ownerUserId : new Types.ObjectId();
    const service = new BookingService(
      { findById: async (id: string) => (id === String(business._id) ? business : null) } as never,
      {
        findActiveByUserId: async () => ({
          businessId: business._id,
          role: "SUPERVISOR",
          employmentActive: true,
          removedAt: null,
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const hours = vi
      .spyOn(BusinessHoursRepository.prototype, "findByBusinessId")
      .mockResolvedValue({
        days: [
          { dayOfWeek: "MONDAY", isOpen: true, slots: [{ startTime: "05:00", endTime: "23:00" }] },
        ],
      } as never);
    expect(
      await service.getCalendarPresentation(String(actor), role, String(business._id)),
    ).toEqual({
      timezone: business.timezone,
      openingHours: [
        { dayOfWeek: "MONDAY", isOpen: true, slots: [{ startTime: "05:00", endTime: "23:00" }] },
      ],
    });
    expect(hours).toHaveBeenCalledWith(business._id);
    await expect(
      service.getCalendarPresentation(String(actor), role, String(new Types.ObjectId())),
    ).rejects.toMatchObject({ statusCode: 404 });
  },
);
it("rejects an unauthorized calendar context before reading hours", async () => {
  const business = buildBusiness(),
    hours = vi.spyOn(BusinessHoursRepository.prototype, "findByBusinessId");
  const service = new BookingService(
    { findById: async () => business } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  await expect(
    service.getCalendarPresentation(
      String(new Types.ObjectId()),
      "BUSINESS_OWNER",
      String(business._id),
    ),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(hours).not.toHaveBeenCalled();
});
