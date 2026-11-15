import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import type { BookingRepository } from "../../src/modules/booking/booking.repository.js";
import type { PackageProgressRepository } from "../../src/modules/package-progress/package-progress.repository.js";
import { PackageProgressService } from "../../src/modules/package-progress/package-progress.service.js";

const id = new Types.ObjectId(),
  businessId = new Types.ObjectId(),
  originBookingId = new Types.ObjectId();
const progress = {
  _id: id,
  businessId,
  serviceId: new Types.ObjectId(),
  originBookingId,
  remainingSessions: 2,
  totalSessions: 3,
  completedSessions: 0,
  sessions: [],
  purchaseSnapshot: {
    name: "Package",
    bundlePriceCents: 10000,
    durationMin: 60,
    sessionsInPackage: 3,
  },
  createdAt: new Date(),
  updatedAt: new Date(),
};
function setup(bookings: unknown[]) {
  const packages = {
    listForCustomer: vi.fn().mockResolvedValue([progress]),
    findByIdForCustomer: vi.fn().mockResolvedValue(progress),
  };
  const repo = {
    findManyByIds: vi.fn().mockResolvedValue(bookings),
    findManyByIdsForCustomer: vi.fn().mockResolvedValue(bookings),
  };
  return {
    repo,
    service: new PackageProgressService(
      packages as unknown as PackageProgressRepository,
      repo as unknown as BookingRepository,
    ),
  };
}
describe("package settlement read", () => {
  it("reports missing origin as unavailable and keeps scheduling locked in list and detail", async () => {
    const { service } = setup([]);
    const [list] = await service.listForCustomer(String(id));
    const detail = await service.getForCustomer(String(id), String(id));
    for (const value of [list, detail])
      expect(value).toMatchObject({
        status: "AWAITING_BALANCE",
        balanceSettled: false,
        outstandingBalanceCents: null,
        settlementAvailable: false,
      });
  });
  it.each([
    [0, undefined, true, 0],
    [1000, 400, false, 600],
    [1000, 1000, true, 0],
  ] as const)("reports known balance %i and paid %s", async (due, paid, settled, outstanding) => {
    const booking = {
      _id: originBookingId,
      financials: { balanceDueCents: due },
      completionPayment: paid === undefined ? undefined : { paid: true, amountCents: paid },
      fulfilment: { mode: "AT_BUSINESS_LOCATION" },
      serviceLines: [],
    };
    const { service } = setup([booking]);
    const [result] = await service.listForCustomer(String(id));
    expect(result).toMatchObject({
      balanceSettled: settled,
      outstandingBalanceCents: outstanding,
      settlementAvailable: true,
    });
  });
  it("propagates database read failures instead of fabricating a balance", async () => {
    const { service, repo } = setup([]);
    repo.findManyByIds.mockRejectedValue(new Error("read unavailable"));
    await expect(service.listForCustomer(String(id))).rejects.toThrow("read unavailable");
  });
});
