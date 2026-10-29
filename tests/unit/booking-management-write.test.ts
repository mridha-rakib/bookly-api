import { type ClientSession, Types } from "mongoose";
import { beforeEach, expect, it, vi } from "vitest";
import { withSupervisorBookingWrite } from "../../src/modules/booking/booking-management-write.js";
import { StaffMembershipModel } from "../../src/modules/staff/staff.model.js";

const fence = vi.hoisted(() => ({ enter: vi.fn() }));
vi.mock("../../src/modules/package-progress/package-eligibility.js", () => ({
  withPackageEligibility: (...args: unknown[]) => fence.enter(...args),
}));

beforeEach(() => {
  vi.restoreAllMocks();
  fence.enter.mockReset();
});

it("joins the existing transaction and rechecks exact employed, non-removed Supervisor before work", async () => {
  const businessId = new Types.ObjectId(),
    actorUserId = new Types.ObjectId();
  const session = {} as ClientSession;
  const lookup = { session: vi.fn(async () => ({ _id: actorUserId })) };
  vi.spyOn(StaffMembershipModel, "exists").mockReturnValue(lookup as never);
  fence.enter.mockImplementation(async (business, existing, work) => {
    expect(business).toBe(businessId);
    expect(existing).toBe(session);
    return work(session);
  });
  const work = vi.fn(async () => "committed");
  await expect(
    withSupervisorBookingWrite(businessId, { actorRole: "SUPERVISOR", actorUserId }, session, work),
  ).resolves.toBe("committed");
  expect(StaffMembershipModel.exists).toHaveBeenCalledWith({
    businessId,
    userId: actorUserId,
    role: "SUPERVISOR",
    employmentActive: true,
    removedAt: null,
  });
  expect(lookup.session).toHaveBeenCalledWith(session);
  expect(work).toHaveBeenCalledWith(session);
});

it("a deactivation observed after fence acquisition denies before the persistence callback", async () => {
  const businessId = new Types.ObjectId(),
    actorUserId = new Types.ObjectId();
  vi.spyOn(StaffMembershipModel, "exists").mockReturnValue({
    session: vi.fn(async () => null),
  } as never);
  fence.enter.mockImplementation(async (_business, _existing, work) => work({}));
  const work = vi.fn();
  await expect(
    withSupervisorBookingWrite(
      businessId,
      { actorRole: "SUPERVISOR", actorUserId },
      undefined,
      work,
    ),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(work).not.toHaveBeenCalled();
});

it.each(["BUSINESS_OWNER", "CUSTOMER"] as const)(
  "preserves the existing %s writer without membership fallback",
  async (actorRole) => {
    const session = {} as ClientSession,
      work = vi.fn(async () => "existing result");
    await expect(
      withSupervisorBookingWrite(
        new Types.ObjectId(),
        { actorRole, actorUserId: new Types.ObjectId() },
        session,
        work,
      ),
    ).resolves.toBe("existing result");
    expect(work).toHaveBeenCalledWith(session);
    expect(fence.enter).not.toHaveBeenCalled();
  },
);
