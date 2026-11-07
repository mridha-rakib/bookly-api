import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import type { BookingRepository } from "../../src/modules/booking/booking.repository.js";
import type { BookingFinancialTransactionService } from "../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import type { BusinessRepository } from "../../src/modules/business/business.repository.js";
import { DashboardOverviewService } from "../../src/modules/dashboard-overview/dashboard-overview.service.js";
import type { FinanceService } from "../../src/modules/finance/finance.service.js";
import type { StaffRepository } from "../../src/modules/staff/staff.repository.js";
import { buildBusiness } from "./stage-b-fixtures.js";

function fixture(overrides: Record<string, unknown> = {}) {
  const business = buildBusiness(),
    actor = new Types.ObjectId();
  const membership = {
    _id: new Types.ObjectId(),
    userId: actor,
    businessId: business._id,
    role: "STAFF",
    employmentActive: true,
    removedAt: null,
    ...overrides,
  };
  const schedule = vi.fn(async () => []);
  const service = new DashboardOverviewService(
    { findById: async () => business } as unknown as BusinessRepository,
    { findActiveByUserId: async () => membership } as unknown as StaffRepository,
    {
      findScheduleForBusinessOnDate: schedule,
      countNoShowsForBusinessInRange: async () => 0,
      findManyByIds: async () => [],
    } as unknown as BookingRepository,
    {
      aggregateForBusiness: async () => [],
      listRecentForBusiness: async () => [],
    } as unknown as BookingFinancialTransactionService,
    { getNetPayoutForBusiness: async () => 0 } as unknown as FinanceService,
  );
  return { business, actor, membership, schedule, service };
}
describe("Staff overview employment authorization", () => {
  it.each(["BUSINESS_OWNER", "SUPERVISOR"] as const)("preserves valid %s access", async (role) => {
    const f = fixture({ role: "SUPERVISOR" });
    const actor = role === "BUSINESS_OWNER" ? f.business.ownerUserId : f.actor;
    expect(await f.service.getOverview(String(actor), role, String(f.business._id))).toMatchObject({
      scope: "FULL",
    });
    expect(f.schedule).toHaveBeenCalledWith(
      f.business._id,
      expect.any(Date),
      expect.any(Date),
      undefined,
    );
  });
  it("permits active Staff only in their current Business scope", async () => {
    const f = fixture();
    expect(
      await f.service.getOverview(String(f.actor), "STAFF", String(f.business._id)),
    ).toMatchObject({ scope: "STAFF_SCOPED", financials: null });
    expect(f.schedule).toHaveBeenCalledWith(
      f.business._id,
      expect.any(Date),
      expect.any(Date),
      f.membership._id,
    );
  });
  it.each([
    { employmentActive: false },
    { removedAt: new Date() },
    { userId: new Types.ObjectId() },
    { businessId: new Types.ObjectId() },
    { role: "SUPERVISOR" },
  ])("denies invalid employment before reading Booking data: %s", async (override) => {
    const f = fixture(override);
    await expect(
      f.service.getOverview(String(f.actor), "STAFF", String(f.business._id)),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(f.schedule).not.toHaveBeenCalled();
  });
});
