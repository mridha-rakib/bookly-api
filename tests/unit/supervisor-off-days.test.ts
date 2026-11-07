import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StaffMembershipModel } from "../../src/modules/staff/staff.model.js";
import { putStaffScheduleBodySchema } from "../../src/modules/staff/staff.schema.js";
import { StaffService } from "../../src/modules/staff/staff.service.js";
import {
  type StaffScheduleDocument,
  StaffScheduleModel,
} from "../../src/modules/staff/staff-schedule.model.js";
import { StaffScheduleRepository } from "../../src/modules/staff/staff-schedule.repository.js";

const fx = vi.hoisted(() => ({ transaction: { name: "existing-business-fence" } }));
vi.mock("../../src/modules/package-progress/package-eligibility.js", () => ({
  withPackageEligibility: async (
    _business: unknown,
    _session: unknown,
    work: (session: unknown) => Promise<unknown>,
  ) => work(fx.transaction),
}));

const owner = new Types.ObjectId(),
  supervisor = new Types.ObjectId(),
  businessId = new Types.ObjectId();
const member = {
  _id: new Types.ObjectId(),
  userId: new Types.ObjectId(),
  businessId,
  role: "STAFF",
  employmentActive: true,
  createdAt: new Date(),
};
const actorMembership = {
  ...member,
  _id: new Types.ObjectId(),
  userId: supervisor,
  role: "SUPERVISOR",
};
const thursday = {
  dayOfWeek: "THURSDAY" as const,
  intervals: [{ startTime: "10:00", endTime: "16:00" }],
};
let stored: StaffScheduleDocument | null;
let actor: typeof actorMembership | null;
let staffLookup: ReturnType<typeof vi.fn>;
let service: StaffService;
const repo = new StaffScheduleRepository();
const sessionQuery = <T>(value: T) => ({
  session: vi.fn((session: unknown) => {
    expect(session === fx.transaction || session === null).toBe(true);
    const result = Promise.resolve(value);
    return Object.assign(result, { exec: () => result });
  }),
});

beforeEach(() => {
  vi.restoreAllMocks();
  stored = {
    membershipId: member._id,
    businessId,
    days: [thursday],
    offDays: ["WEDNESDAY", "SATURDAY", "SUNDAY"],
  } as StaffScheduleDocument;
  actor = { ...actorMembership };
  vi.spyOn(StaffMembershipModel, "findOne").mockImplementation(
    () => ({ session: vi.fn().mockResolvedValue(member) }) as never,
  );
  vi.spyOn(StaffScheduleModel, "findOne").mockImplementation(() => sessionQuery(stored) as never);
  vi.spyOn(StaffScheduleModel, "find").mockImplementation(
    () => sessionQuery(stored ? [stored] : []) as never,
  );
  vi.spyOn(StaffScheduleModel, "findOneAndUpdate").mockImplementation((filter, update, options) => {
    expect(filter).toEqual({ membershipId: member._id, businessId });
    expect(options).toMatchObject({
      session: fx.transaction,
      upsert: true,
      returnDocument: "after",
    });
    stored = { ...stored, ...(update as { $set: object }).$set } as StaffScheduleDocument;
    return { exec: async () => stored } as never;
  });
  staffLookup = vi.fn().mockResolvedValue(member);
  service = new StaffService(
    {
      findActiveByUserId: vi.fn(async () => actor),
      findActiveById: staffLookup,
      listActiveByBusinessId: vi.fn().mockResolvedValue([member]),
    } as never,
    {
      findById: vi.fn(async (id: string) =>
        id === String(businessId)
          ? { _id: businessId, ownerUserId: owner, createdAt: new Date() }
          : null,
      ),
    } as never,
    {
      findManyByIds: vi
        .fn()
        .mockResolvedValue([{ _id: member.userId, normalizedEmail: "staff@example.test" }]),
      findProfilesByUserIds: vi
        .fn()
        .mockResolvedValue([{ userId: member.userId, firstName: "Sam", lastName: "Staff" }]),
    } as never,
    { listPendingForBusiness: vi.fn().mockResolvedValue([]) } as never,
    {} as never,
    repo,
    { findManyByMembershipIds: vi.fn().mockResolvedValue([]) } as never,
    { getAvatarUrlsByUserIds: vi.fn().mockResolvedValue(new Map()) } as never,
  );
});

describe("Supervisor schedule off-day preservation", () => {
  it("keeps omission distinct from an explicit empty replacement through validation", () => {
    expect(putStaffScheduleBodySchema.parse({ days: [] }).offDays).toBeUndefined();
    expect(putStaffScheduleBodySchema.parse({ days: [], offDays: [] }).offDays).toEqual([]);
    expect(
      putStaffScheduleBodySchema.safeParse({ days: [thursday], offDays: ["THURSDAY"] }).success,
    ).toBe(false);
  });
  it("Owner configuration survives a Supervisor Thursday edit and all authorized schedule reads", async () => {
    const unchanged = ["MONDAY", "TUESDAY", "FRIDAY"].map((dayOfWeek) => ({
      ...thursday,
      dayOfWeek: dayOfWeek as "MONDAY" | "TUESDAY" | "FRIDAY",
    }));
    await service.putSchedule(String(owner), String(businessId), String(member._id), {
      days: [...unchanged, thursday],
      offDays: ["WEDNESDAY", "SATURDAY", "SUNDAY"],
    });
    const changed = { ...thursday, intervals: [{ startTime: "11:00", endTime: "17:00" }] };
    await service.putSchedule(
      String(supervisor),
      String(businessId),
      String(member._id),
      putStaffScheduleBodySchema.parse({ days: [...unchanged, changed] }),
    );
    expect(stored?.offDays).toEqual(["WEDNESDAY", "SATURDAY", "SUNDAY"]);
    for (const user of [owner, supervisor]) {
      expect(
        await service.getSchedule(String(user), String(businessId), String(member._id)),
      ).toEqual([...unchanged, changed]);
      const read = (await service.listStaff(String(user), String(businessId))).members.find(
        (row) => !row.isOwner,
      );
      expect(read).toMatchObject({
        schedule: [...unchanged, changed],
        offDays: ["WEDNESDAY", "SATURDAY", "SUNDAY"],
      });
    }
    actor = { ...actorMembership, userId: member.userId, role: "STAFF" };
    expect(await service.getMySchedule(String(member.userId), String(businessId))).toEqual([
      ...unchanged,
      changed,
    ]);
  });
  it("unchanged hours and empty working-day saves preserve all existing off-days", async () => {
    await repo.replace(member._id, businessId, [thursday]);
    expect(stored?.offDays).toEqual(["WEDNESDAY", "SATURDAY", "SUNDAY"]);
    await repo.replace(member._id, businessId, []);
    expect(stored?.offDays).toEqual(["WEDNESDAY", "SATURDAY", "SUNDAY"]);
  });
  it("an explicit valid working shift removes only that weekday from off-days", async () => {
    await service.putSchedule(String(supervisor), String(businessId), String(member._id), {
      days: [thursday, { ...thursday, dayOfWeek: "WEDNESDAY" }],
    });
    expect(stored?.offDays).toEqual(["SATURDAY", "SUNDAY"]);
  });
  it("merges the current persisted off-days inside the transaction, including later Owner edits", async () => {
    stored?.offDays.push("FRIDAY");
    await repo.replace(member._id, businessId, [thursday]);
    expect(stored?.offDays).toEqual(["WEDNESDAY", "SATURDAY", "SUNDAY", "FRIDAY"]);
    expect(StaffScheduleModel.findOne).toHaveBeenCalledWith({
      membershipId: member._id,
      businessId,
    });
  });
  it("explicit [] clears off-days; missing legacy/new schedule defaults safely", async () => {
    await repo.replace(member._id, businessId, [thursday], []);
    expect(stored?.offDays).toEqual([]);
    stored = null;
    const created = await repo.replace(member._id, businessId, []);
    expect(created.offDays).toEqual([]);
  });
  it("rejects wrong Business, inactive/removed Supervisors, Staff and foreign target membership", async () => {
    const write = StaffScheduleModel.findOneAndUpdate;
    await expect(
      service.putSchedule(String(supervisor), String(new Types.ObjectId()), String(member._id), {
        days: [],
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    for (const patch of [
      { employmentActive: false },
      { removedAt: new Date() },
      { role: "STAFF" },
      { businessId: new Types.ObjectId() },
    ]) {
      actor = { ...actorMembership, ...patch };
      await expect(
        service.putSchedule(String(supervisor), String(businessId), String(member._id), {
          days: [],
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    }
    actor = { ...actorMembership };
    staffLookup.mockResolvedValue(null);
    await expect(
      service.putSchedule(String(supervisor), String(businessId), String(new Types.ObjectId()), {
        days: [],
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(write).not.toHaveBeenCalled();
  });
});
