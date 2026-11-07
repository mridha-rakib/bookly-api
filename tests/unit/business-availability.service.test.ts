import { Types } from "mongoose";
import { afterEach, expect, it, vi } from "vitest";
import { BookingModel } from "../../src/modules/booking/booking.model.js";
import { BusinessModel } from "../../src/modules/business/business.model.js";
import type { AvailabilityRules } from "../../src/modules/business-booking-settings/business-availability.rules.js";
import { BusinessAvailabilityService } from "../../src/modules/business-booking-settings/business-availability.service.js";
import { BusinessBookingSettingsModel } from "../../src/modules/business-booking-settings/business-booking-settings.model.js";
import * as eligibility from "../../src/modules/package-progress/package-eligibility.js";
import { StaffMembershipModel } from "../../src/modules/staff/staff.model.js";
import { buildBusiness } from "./stage-b-fixtures.js";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const business = buildBusiness(),
    staffId = String(new Types.ObjectId()),
    session = { inTransaction: () => true } as never;
  const saved: { availability?: AvailabilityRules } = {};
  const fence = vi
    .spyOn(eligibility, "withPackageEligibility")
    .mockImplementation(async (_id, _existing, work) => work(session));
  const read = vi.fn(async (id: string, _session?: unknown) =>
    id === String(business._id) ? business : null,
  );
  const findSettings = vi.fn(async () => saved);
  const write = vi.spyOn(BusinessBookingSettingsModel, "findOneAndUpdate").mockImplementation(
    (_query, update) =>
      ({
        exec: async () => {
          saved.availability ??= {};
          for (const [key, value] of Object.entries(
            (update as { $set: Record<string, unknown> }).$set,
          ))
            Object.assign(saved.availability, { [key.replace("availability.", "")]: value });
          return saved;
        },
      }) as never,
  );
  const visibility = vi.spyOn(BusinessModel, "updateOne").mockImplementation(
    (_query, update) =>
      ({
        exec: async () => {
          business.publicVisible = (
            update as { $set: { publicVisible: boolean } }
          ).$set.publicVisible;
        },
      }) as never,
  );
  const bookings = vi
    .spyOn(BookingModel, "countDocuments")
    .mockReturnValue({ session: () => ({ exec: async () => 2 }) } as never);
  const staff = vi
    .spyOn(StaffMembershipModel, "find")
    .mockReturnValue({ session: () => ({ exec: async () => [{ _id: staffId }] }) } as never);
  const membership = vi
    .spyOn(StaffMembershipModel, "findOne")
    .mockReturnValue({ session: () => ({ exec: async () => ({}) }) } as never);
  const service = new BusinessAvailabilityService(
    { findById: read } as never,
    { findByBusinessId: findSettings } as never,
  );
  const owner = String(business.ownerUserId),
    id = String(business._id);
  const range = {
    staffMembershipId: staffId,
    startDate: "2030-01-15",
    startTime: "09:00",
    endDate: "2030-01-15",
    endTime: "10:00",
  };
  return {
    service,
    business,
    owner,
    id,
    staffId,
    range,
    write,
    read,
    fence,
    bookings,
    staff,
    membership,
    visibility,
  };
}
it("persists and reloads scoped blocks, normalizes duplicates and reopens without touching Bookings", async () => {
  const f = fixture(),
    canonicalWrite = vi.spyOn(BookingModel, "updateOne");
  const saved = await f.service.changeBlocks(f.owner, "BUSINESS_OWNER", f.id, {
    action: "BLOCK",
    intervals: [f.range, f.range],
  });
  expect(saved.blocks).toHaveLength(1);
  expect(saved.overlappingBookings).toBe(2);
  expect((await f.service.getBlocks(f.owner, "BUSINESS_OWNER", f.id)).blocks).toEqual(saved.blocks);
  expect(f.fence).toHaveBeenCalledWith(f.id, undefined, expect.any(Function));
  expect(f.staff).toHaveBeenCalledWith({ _id: { $in: [f.staffId] }, businessId: f.id });
  expect(f.bookings).toHaveBeenCalledWith(
    expect.objectContaining({ businessId: f.id, status: { $in: ["UPCOMING", "PENDING"] } }),
  );
  expect(f.write).toHaveBeenCalledWith(
    { businessId: f.id },
    expect.anything(),
    expect.objectContaining({ session: expect.anything() }),
  );
  await f.service.changeBlocks(f.owner, "BUSINESS_OWNER", f.id, {
    action: "UNBLOCK",
    intervals: [f.range],
  });
  expect((await f.service.getBlocks(f.owner, "BUSINESS_OWNER", f.id)).blocks).toEqual([]);
  expect(canonicalWrite).not.toHaveBeenCalled();
});
it("persists settings and visibility independently of approval, and preserves slot blocks", async () => {
  const f = fixture();
  await f.service.changeBlocks(f.owner, "BUSINESS_OWNER", f.id, {
    action: "BLOCK",
    intervals: [f.range],
  });
  const body = {
    minimumNoticeMinutes: 30 as const,
    maximumAdvanceMonths: 3 as const,
    closedPeriods: [{ startDate: "2030-01-15", endDate: "2030-01-16", note: "Holiday" }],
    publicVisible: false,
  };
  expect(await f.service.updateRules(f.owner, "BUSINESS_OWNER", f.id, body)).toMatchObject({
    ...body,
    overlappingBookings: 2,
  });
  expect(await f.service.getRules(f.owner, "BUSINESS_OWNER", f.id)).toMatchObject(body);
  expect((await f.service.getBlocks(f.owner, "BUSINESS_OWNER", f.id)).blocks).toHaveLength(1);
  await f.service.updateRules(f.owner, "BUSINESS_OWNER", f.id, {
    ...body,
    publicVisible: true,
    closedPeriods: [],
  });
  expect(await f.service.getRules(f.owner, "BUSINESS_OWNER", f.id)).toMatchObject({
    publicVisible: true,
    closedPeriods: [],
  });
  expect(f.visibility).toHaveBeenCalledWith(
    { _id: f.id, ownerUserId: f.owner },
    { $set: { publicVisible: true } },
    expect.anything(),
  );
  expect(f.business.status).toBe("APPROVED");
});
it("defaults only discovery visibility for legacy documents, never notice or window", async () => {
  const f = fixture();
  expect(await f.service.getRules(f.owner, "BUSINESS_OWNER", f.id)).toMatchObject({
    publicVisible: true,
    minimumNoticeMinutes: null,
    maximumAdvanceMonths: null,
    closedPeriods: [],
  });
});
it("supports active Supervisors for blocks, but never private settings or visibility", async () => {
  const f = fixture(),
    actor = String(new Types.ObjectId());
  await f.service.changeBlocks(actor, "SUPERVISOR", f.id, {
    action: "BLOCK",
    intervals: [f.range],
  });
  expect(f.membership).toHaveBeenCalledWith({
    userId: actor,
    businessId: f.id,
    role: "SUPERVISOR",
    employmentActive: true,
    removedAt: null,
  });
  await expect(f.service.getRules(actor, "SUPERVISOR", f.id)).rejects.toMatchObject({
    statusCode: 404,
  });
});
it.each(["STAFF", "CUSTOMER", "BUSINESS_OWNER"] as const)(
  "rejects unauthorized %s actors before mutation",
  async (role) => {
    const f = fixture();
    await expect(
      f.service.changeBlocks(String(new Types.ObjectId()), role, f.id, {
        action: "BLOCK",
        intervals: [f.range],
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.fence).not.toHaveBeenCalled();
  },
);
it("denies a revoked Supervisor and foreign Business/Staff identities", async () => {
  const f = fixture();
  f.membership.mockReturnValue({ session: () => ({ exec: async () => null }) } as never);
  await expect(
    f.service.getBlocks(String(new Types.ObjectId()), "SUPERVISOR", f.id),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    f.service.getBlocks(f.owner, "BUSINESS_OWNER", String(new Types.ObjectId())),
  ).rejects.toMatchObject({ statusCode: 404 });
  f.staff.mockReturnValue({ session: () => ({ exec: async () => [] }) } as never);
  await expect(
    f.service.changeBlocks(f.owner, "BUSINESS_OWNER", f.id, {
      action: "BLOCK",
      intervals: [f.range],
    }),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(f.write).not.toHaveBeenCalled();
});
