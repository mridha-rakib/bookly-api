import { describe, expect, it, vi } from "vitest";
import type {
  AvailabilityResult,
  GetAvailabilityInput,
} from "../../src/modules/availability/availability.service.js";
import { CompositeAvailabilityService } from "../../src/modules/availability/composite-availability.service.js";

const base = {
  fromDate: "2030-05-01",
  toDate: "2030-05-01",
  lines: [
    { serviceId: "s1", staffMembershipId: "p1", hours: 2 },
    { serviceId: "s2", staffMembershipId: "p2", partySize: 3 },
  ],
};
const result = (serviceId: string, times: string[], duration: number): AvailabilityResult => ({
  businessId: "b",
  serviceId,
  timezone: "UTC",
  capacityMax: 1,
  days: [
    {
      date: "2030-05-01",
      isOpen: true,
      slots: times.map((time) => ({
        startAt: `2030-05-01T${time}:00.000Z`,
        endAt: new Date(Date.parse(`2030-05-01T${time}:00Z`) + duration * 60000).toISOString(),
        eligibleStaffMembershipIds: [serviceId === "s1" ? "p1" : "p2"],
        source: "AUTO",
      })),
    },
  ],
});
function setup() {
  const getAvailability = vi.fn(async (i: GetAvailabilityInput) =>
    i.serviceId === "s1"
      ? result("s1", ["09:00", "10:00"], 120)
      : result("s2", ["10:00", "11:00"], 30),
  );
  const findById = vi.fn().mockResolvedValue({ isPackageDeal: false });
  const getMaxServicesPerBooking = vi.fn().mockResolvedValue(5);
  return {
    service: new CompositeAvailabilityService(
      { getAvailability },
      { findById },
      { getMaxServicesPerBooking },
    ),
    getAvailability,
    findById,
    getMaxServicesPerBooking,
  };
}
describe("composite availability", () => {
  it("intersects shared starts, preserves quantities and uses the longest occupied end", async () => {
    const { service, getAvailability } = setup();
    const value = await service.get("b", base);
    expect(value.days[0]?.slots).toHaveLength(1);
    expect(value.days[0]?.slots[0]).toMatchObject({
      startAt: "2030-05-01T10:00:00.000Z",
      endAt: "2030-05-01T12:00:00.000Z",
      eligibleStaffMembershipIds: ["p1", "p2"],
    });
    expect(getAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: "s1", staffMembershipId: "p1", hours: 2 }),
    );
    expect(getAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: "s2", staffMembershipId: "p2", partySize: 3 }),
    );
  });
  it("rejects same-staff overlap, package lines and configured-limit violations", async () => {
    const { service, findById, getMaxServicesPerBooking } = setup();
    await expect(
      service.get("b", {
        ...base,
        lines: [base.lines[0]!, { ...base.lines[1]!, staffMembershipId: "p1" }],
      }),
    ).rejects.toThrow();
    findById.mockResolvedValue({ isPackageDeal: true });
    await expect(service.get("b", base)).rejects.toThrow();
    getMaxServicesPerBooking.mockResolvedValue(1);
    await expect(service.get("b", base)).rejects.toThrow();
  });
  it("propagates staff eligibility and availability failures", async () => {
    const { service, getAvailability } = setup();
    getAvailability.mockRejectedValue(new Error("ineligible"));
    await expect(service.get("b", base)).rejects.toThrow("ineligible");
  });
});
