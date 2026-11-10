import type { Request, Response } from "express";
import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import { createStaffScheduleRoute } from "../../src/modules/staff/staff.route.js";
import { StaffService } from "../../src/modules/staff/staff.service.js";

/** P2.2 — the existing Owner-or-Supervisor time-off contract the new Supervisor UI relies on. */
const fixture = (
  options: { supervisorBusiness?: "same" | "other"; targetFound?: boolean } = {},
) => {
  const actor = new Types.ObjectId();
  const business = { _id: new Types.ObjectId(), ownerUserId: new Types.ObjectId() };
  const supervisor = {
    _id: new Types.ObjectId(),
    userId: actor,
    businessId: options.supervisorBusiness === "other" ? new Types.ObjectId() : business._id,
    role: "SUPERVISOR",
    employmentActive: true,
    removedAt: null,
  };
  const target = { _id: new Types.ObjectId(), businessId: business._id, role: "STAFF" };
  const staff = {
    findActiveByUserId: vi.fn().mockResolvedValue(supervisor),
    // Scoped by Business: a target from another Business resolves to null.
    findActiveById: vi.fn().mockResolvedValue(options.targetFound === false ? null : target),
  };
  const schedule = { findByMembershipId: vi.fn(), replace: vi.fn() };
  const timeOff = {
    listByMembershipId: vi.fn().mockResolvedValue([]),
    create: vi.fn(async (input: Record<string, unknown>) => ({
      _id: new Types.ObjectId(),
      ...input,
    })),
    deleteByIdForMembership: vi.fn().mockResolvedValue(true),
  };
  const service = new StaffService(
    staff as never,
    { findById: vi.fn().mockResolvedValue(business) } as never,
    {} as never,
    {} as never,
    {} as never,
    schedule as never,
    timeOff as never,
    {} as never,
  );
  const args = [String(actor), String(business._id), String(target._id)] as const;
  return { actor, business, target, staff, schedule, timeOff, service, args };
};

describe("Supervisor team time off (existing API contract)", () => {
  it("an active Supervisor adds and removes a team member's time off without any schedule write", async () => {
    const f = fixture();
    const created = await f.service.createTimeOff(...f.args, {
      type: "ANNUAL_HOLIDAY",
      startDate: "2026-12-22",
      endDate: "2026-12-31",
    });
    expect(f.staff.findActiveById).toHaveBeenCalledWith(f.business._id, String(f.target._id));
    expect(f.timeOff.create).toHaveBeenCalledWith(
      expect.objectContaining({
        membershipId: f.target._id,
        businessId: f.business._id,
        type: "ANNUAL_HOLIDAY",
        startDate: "2026-12-22",
        endDate: "2026-12-31",
      }),
    );
    expect(String(f.timeOff.create.mock.calls[0]?.[0]?.["createdByUserId"])).toBe(String(f.actor));
    expect(created).toMatchObject({ type: "ANNUAL_HOLIDAY", startDate: "2026-12-22" });

    const single = await f.service.createTimeOff(...f.args, {
      type: "SICK_LEAVE",
      startDate: "2026-11-20",
    });
    expect(single).toMatchObject({ startDate: "2026-11-20", endDate: "2026-11-20" });

    const timeOffId = String(new Types.ObjectId());
    await f.service.removeTimeOff(...f.args, timeOffId);
    expect(f.timeOff.deleteByIdForMembership).toHaveBeenCalledWith(f.target._id, timeOffId);
    // Recurring off-days and working hours live in the schedule document: never written here.
    expect(f.schedule.replace).not.toHaveBeenCalled();
  });

  it("removing an unknown or other member's entry is not found", async () => {
    const f = fixture();
    f.timeOff.deleteByIdForMembership.mockResolvedValue(false);
    await expect(
      f.service.removeTimeOff(...f.args, String(new Types.ObjectId())),
    ).rejects.toMatchObject({ statusCode: 404, details: [{ code: "STAFF_TIME_OFF_NOT_FOUND" }] });
  });

  it("denies a Supervisor of another Business and a target outside this Business before writes", async () => {
    const wrongBusiness = fixture({ supervisorBusiness: "other" });
    await expect(
      wrongBusiness.service.createTimeOff(...wrongBusiness.args, {
        type: "SICK_LEAVE",
        startDate: "2026-11-20",
      }),
    ).rejects.toMatchObject({ details: [{ code: "STAFF_BUSINESS_NOT_FOUND" }] });
    await expect(wrongBusiness.service.listTimeOff(...wrongBusiness.args)).rejects.toMatchObject({
      details: [{ code: "STAFF_BUSINESS_NOT_FOUND" }],
    });

    const foreignTarget = fixture({ targetFound: false });
    await expect(
      foreignTarget.service.createTimeOff(...foreignTarget.args, {
        type: "SICK_LEAVE",
        startDate: "2026-11-20",
      }),
    ).rejects.toMatchObject({ details: [{ code: "STAFF_NOT_FOUND" }] });
    await expect(
      foreignTarget.service.removeTimeOff(...foreignTarget.args, String(new Types.ObjectId())),
    ).rejects.toMatchObject({ details: [{ code: "STAFF_NOT_FOUND" }] });
    for (const f of [wrongBusiness, foreignTarget]) {
      expect(f.timeOff.create).not.toHaveBeenCalled();
      expect(f.timeOff.deleteByIdForMembership).not.toHaveBeenCalled();
    }
  });

  it("time-off routes admit only active Business Owners and Supervisors", () => {
    const router = createStaffScheduleRoute();
    const layers = router.stack.filter(
      (layer) => layer.route?.path.startsWith("/:businessId/staff/:staffId/time-off") ?? false,
    );
    expect(layers).toHaveLength(3);
    for (const layer of layers) {
      const handlers = (layer.route?.stack ?? []).map((entry) => entry.handle);
      const [activeUser, roles] = [handlers[1], handlers[2]];
      const outcome = (role: string, status = "ACTIVE") => {
        let result: unknown = "allowed";
        for (const guard of [activeUser, roles]) {
          if (result !== "allowed") break;
          guard?.(
            { auth: { userId: String(new Types.ObjectId()), role, status } } as Request,
            {} as Response,
            (error?: unknown) => {
              if (error) result = error;
            },
          );
        }
        return result;
      };
      for (const role of ["STAFF", "CUSTOMER", "SUPER_ADMIN"])
        expect(outcome(role)).toMatchObject({ statusCode: 403 });
      expect(outcome("SUPERVISOR", "SUSPENDED")).toMatchObject({ statusCode: 403 });
      expect(outcome("SUPERVISOR")).toBe("allowed");
      expect(outcome("BUSINESS_OWNER")).toBe("allowed");
    }
  });
});
