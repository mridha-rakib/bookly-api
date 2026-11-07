import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import { ClientService } from "../../src/modules/client/client.service.js";
import { ReviewService } from "../../src/modules/review/review.service.js";
import { StaffService } from "../../src/modules/staff/staff.service.js";
import { SupportService } from "../../src/modules/support/support.service.js";

const fixture = (role: "STAFF" | "SUPERVISOR", employmentActive = true, removedAt?: Date) => {
  const actor = new Types.ObjectId();
  const business = { _id: new Types.ObjectId(), ownerUserId: new Types.ObjectId() };
  const membership = {
    _id: new Types.ObjectId(),
    userId: actor,
    businessId: business._id,
    role,
    employmentActive,
    removedAt,
  };
  const staff = {
    findActiveByUserId: vi.fn().mockResolvedValue(membership),
    listActiveByBusinessId: vi.fn().mockResolvedValue([]),
    findActiveById: vi.fn().mockResolvedValue(membership),
  };
  const schedule = { findByMembershipId: vi.fn().mockResolvedValue(null), replace: vi.fn() };
  const timeOff = {
    listByMembershipId: vi.fn(),
    create: vi.fn(),
    deleteByIdForMembership: vi.fn(),
  };
  const services = { listActiveByAssignedStaffMembershipId: vi.fn().mockResolvedValue([]) };
  const service = new StaffService(
    staff as never,
    { findById: vi.fn().mockResolvedValue(business) } as never,
    {} as never,
    {} as never,
    {} as never,
    schedule as never,
    timeOff as never,
    {} as never,
    undefined,
    undefined,
    services,
  );
  return {
    actor: String(actor),
    business,
    membership,
    staff,
    schedule,
    timeOff,
    services,
    service,
  };
};

describe("current employment is required for Staff service access", () => {
  it.each(["inactive", "removed", "foreign-user", "foreign-business", "demoted"])(
    "denies %s Supervisor client and review management before private reads",
    async (state) => {
      const f = fixture("SUPERVISOR");
      if (state === "inactive") f.membership.employmentActive = false;
      if (state === "removed") f.membership.removedAt = new Date();
      if (state === "foreign-user") f.membership.userId = new Types.ObjectId();
      if (state === "foreign-business") f.membership.businessId = new Types.ObjectId();
      if (state === "demoted") f.membership.role = "STAFF";
      const business = { findById: vi.fn().mockResolvedValue(f.business) };
      const privateRead = vi.fn();
      const clients = new ClientService(
        { listByBusinessId: privateRead } as never,
        business as never,
        f.staff as never,
        {} as never,
        {} as never,
      );
      await expect(
        clients.listClients(f.actor, "SUPERVISOR", String(f.business._id), {
          archived: false,
          page: 1,
          limit: 20,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      const reviews = new ReviewService(
        { getAggregate: privateRead } as never,
        {} as never,
        business as never,
        f.staff as never,
      );
      await expect(
        reviews.getBusinessRatingSummaryForActor(f.actor, "SUPERVISOR", String(f.business._id)),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(privateRead).not.toHaveBeenCalled();
    },
  );
  it.each(["STAFF", "SUPERVISOR"] as const)(
    "denies a deactivated %s new business-linked support tickets before persistence",
    async (role) => {
      const f = fixture(role, false),
        create = vi.fn();
      const service = new SupportService(
        { create } as never,
        {} as never,
        {} as never,
        {} as never,
        f.staff as never,
        {} as never,
        {} as never,
      );
      await expect(
        service.createTicket(f.actor, role, { subject: "Help", message: "Question" }),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(create).not.toHaveBeenCalled();
    },
  );
  it.each(["STAFF", "SUPERVISOR"] as const)(
    "denies deactivated %s self-service before reading data",
    async (role) => {
      const f = fixture(role, false);
      await expect(f.service.getMySchedule(f.actor, String(f.business._id))).rejects.toMatchObject({
        statusCode: 404,
        details: [{ code: "STAFF_NOT_FOUND" }],
      });
      await expect(
        f.service.listMyAssignedServices(f.actor, String(f.business._id)),
      ).rejects.toMatchObject({ statusCode: 404, details: [{ code: "STAFF_NOT_FOUND" }] });
      expect(f.schedule.findByMembershipId).not.toHaveBeenCalled();
      expect(f.services.listActiveByAssignedStaffMembershipId).not.toHaveBeenCalled();
    },
  );
  it.each(["STAFF", "SUPERVISOR"] as const)(
    "preserves active %s own schedule and services",
    async (role) => {
      const f = fixture(role);
      await expect(f.service.getMySchedule(f.actor, String(f.business._id))).resolves.toEqual([]);
      await expect(
        f.service.listMyAssignedServices(f.actor, String(f.business._id)),
      ).resolves.toEqual([]);
    },
  );
  it("denies a deactivated Supervisor every shared team-management operation before reads/writes", async () => {
    const f = fixture("SUPERVISOR", false);
    const args = [f.actor, String(f.business._id), String(f.membership._id)] as const;
    const calls = [
      () => f.service.listStaff(args[0], args[1]),
      () => f.service.getSchedule(...args),
      () => f.service.putSchedule(...args, { days: [] }),
      () => f.service.listTimeOff(...args),
      () => f.service.createTimeOff(...args, { type: "ANNUAL_HOLIDAY", startDate: "2026-11-09" }),
      () => f.service.removeTimeOff(...args, String(new Types.ObjectId())),
    ];
    for (const call of calls)
      await expect(call()).rejects.toMatchObject({
        statusCode: 404,
        details: [{ code: "STAFF_BUSINESS_NOT_FOUND" }],
      });
    expect(f.staff.findActiveById).not.toHaveBeenCalled();
    expect(f.staff.listActiveByBusinessId).not.toHaveBeenCalled();
    expect(f.schedule.replace).not.toHaveBeenCalled();
    expect(f.timeOff.create).not.toHaveBeenCalled();
    expect(f.timeOff.deleteByIdForMembership).not.toHaveBeenCalled();
  });
  it.each(["removed", "foreign-business", "foreign-user"])(
    "fails closed for %s membership data",
    async (mismatch) => {
      const f = fixture("SUPERVISOR");
      if (mismatch === "removed") f.membership.removedAt = new Date();
      if (mismatch === "foreign-business") f.membership.businessId = new Types.ObjectId();
      if (mismatch === "foreign-user") f.membership.userId = new Types.ObjectId();
      await expect(f.service.getMySchedule(f.actor, String(f.business._id))).rejects.toMatchObject({
        statusCode: 404,
        details: [{ code: "STAFF_NOT_FOUND" }],
      });
      await expect(f.service.listStaff(f.actor, String(f.business._id))).rejects.toMatchObject({
        statusCode: 404,
        details: [{ code: "STAFF_BUSINESS_NOT_FOUND" }],
      });
    },
  );
});
