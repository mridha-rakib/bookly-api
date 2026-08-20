import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

import type { BusinessDocument } from "../../src/modules/business/business.model.js";
import type { BusinessRepository } from "../../src/modules/business/business.repository.js";
import type {
  BusinessOpeningHoursDay,
  BusinessOpeningHoursDocument,
} from "../../src/modules/business-hours/business-hours.model.js";
import type { BusinessHoursRepository } from "../../src/modules/business-hours/business-hours.repository.js";
import { BusinessHoursService } from "../../src/modules/business-hours/business-hours.service.js";

const buildBusiness = (overrides: Partial<BusinessDocument> = {}): BusinessDocument =>
  ({
    _id: new Types.ObjectId(),
    ownerUserId: new Types.ObjectId(),
    name: "Ledra Barbers",
    ownerName: "Owner Name",
    email: "owner@example.com",
    phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
    status: "PENDING",
    visitType: "AT_BUSINESS_LOCATION",
    timezone: "Europe/Nicosia",
    address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
    briefDescription: "A great business",
    category: "Barber",
    subcategories: ["Haircut"],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  }) as BusinessDocument;

class FakeBusinessHoursRepository implements Partial<BusinessHoursRepository> {
  public byBusinessId = new Map<string, BusinessOpeningHoursDocument>();

  public readonly findByBusinessId = vi.fn(async (businessId: Types.ObjectId | string) => {
    return this.byBusinessId.get(String(businessId)) ?? null;
  });

  public readonly replace = vi.fn(
    async (businessId: Types.ObjectId, days: BusinessOpeningHoursDay[]) => {
      const existing = this.byBusinessId.get(String(businessId));
      const now = new Date();
      const document = {
        _id: existing?._id ?? new Types.ObjectId(),
        businessId,
        days,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      } as BusinessOpeningHoursDocument;
      this.byBusinessId.set(String(businessId), document);
      return document;
    },
  );
}

const createService = (input: { business?: BusinessDocument | null } = {}) => {
  const ownerUserId = new Types.ObjectId();
  const business = input.business === undefined ? buildBusiness({ ownerUserId }) : input.business;
  const businessRepository = { findById: vi.fn().mockResolvedValue(business) };
  const businessHoursRepository = new FakeBusinessHoursRepository();
  const service = new BusinessHoursService(
    businessHoursRepository as unknown as BusinessHoursRepository,
    businessRepository as unknown as BusinessRepository,
  );

  return { ownerUserId, business, businessRepository, businessHoursRepository, service };
};

describe("BusinessHoursService", () => {
  it("reports not-configured (never fabricated Mon-Fri) when no document exists", async () => {
    const { service, business, ownerUserId } = createService();

    const result = await service.getOpeningHours(String(ownerUserId), String(business?._id));

    expect(result).toEqual({ businessId: String(business?._id), configured: false, days: [] });
  });

  it("owner configures opening hours with multiple slots on one day", async () => {
    const { service, business, ownerUserId } = createService();

    const result = await service.putOpeningHours(String(ownerUserId), String(business?._id), [
      {
        dayOfWeek: "MONDAY",
        isOpen: true,
        slots: [
          { startTime: "15:00", endTime: "19:00" },
          { startTime: "09:00", endTime: "13:00" },
        ],
      },
      { dayOfWeek: "SUNDAY", isOpen: false, slots: [] },
    ]);

    expect(result.configured).toBe(true);
    const monday = result.days.find((day) => day.dayOfWeek === "MONDAY");
    // Slots are sorted by startTime regardless of input order.
    expect(monday?.slots).toEqual([
      { startTime: "09:00", endTime: "13:00" },
      { startTime: "15:00", endTime: "19:00" },
    ]);
    const sunday = result.days.find((day) => day.dayOfWeek === "SUNDAY");
    expect(sunday).toMatchObject({ isOpen: false, slots: [] });
  });

  it("dedupes duplicate day entries, keeping the last one (defense in depth beyond Zod)", async () => {
    const { service, business, ownerUserId } = createService();

    const result = await service.putOpeningHours(String(ownerUserId), String(business?._id), [
      { dayOfWeek: "TUESDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "12:00" }] },
      { dayOfWeek: "TUESDAY", isOpen: false, slots: [] },
    ]);

    const tuesdayEntries = result.days.filter((day) => day.dayOfWeek === "TUESDAY");
    expect(tuesdayEntries).toHaveLength(1);
    expect(tuesdayEntries[0]).toMatchObject({ isOpen: false, slots: [] });
  });

  it("reloads persisted opening hours", async () => {
    const { service, business, ownerUserId } = createService();
    await service.putOpeningHours(String(ownerUserId), String(business?._id), [
      { dayOfWeek: "WEDNESDAY", isOpen: true, slots: [{ startTime: "10:00", endTime: "18:00" }] },
    ]);

    const result = await service.getOpeningHours(String(ownerUserId), String(business?._id));

    expect(result.configured).toBe(true);
    expect(result.days).toHaveLength(1);
    expect(result.days[0]).toMatchObject({ dayOfWeek: "WEDNESDAY", isOpen: true });
  });

  it("a closed day (or a day simply omitted) never means always-open", async () => {
    const { service, business, ownerUserId } = createService();
    const result = await service.putOpeningHours(String(ownerUserId), String(business?._id), [
      { dayOfWeek: "MONDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "17:00" }] },
    ]);

    // Only MONDAY was submitted — every other day of the week is simply absent, not
    // fabricated as open.
    expect(result.days).toHaveLength(1);
    expect(result.days[0]?.dayOfWeek).toBe("MONDAY");
  });

  it("rejects a non-owner user", async () => {
    const { service, business } = createService();
    const unrelatedUserId = String(new Types.ObjectId());

    await expect(
      service.getOpeningHours(unrelatedUserId, String(business?._id)),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.putOpeningHours(unrelatedUserId, String(business?._id), []),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("BusinessAccess-linked users are never consulted — any non-owner id is rejected the same way", async () => {
    // BusinessHoursService only depends on BusinessRepository (ownership check) — there is no
    // BusinessAccessRepository dependency at all, so a linked/secondary-business user can never
    // be granted access here regardless of their link state.
    const { service, business } = createService();
    const linkedButNotOwnerUserId = String(new Types.ObjectId());

    await expect(
      service.putOpeningHours(linkedButNotOwnerUserId, String(business?._id), [
        { dayOfWeek: "MONDAY", isOpen: true, slots: [{ startTime: "09:00", endTime: "17:00" }] },
      ]),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects an unknown business id format", async () => {
    const { service, ownerUserId } = createService();
    await expect(service.getOpeningHours(String(ownerUserId), "not-an-id")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("does not change Business ownership while updating opening hours", async () => {
    const { service, business, ownerUserId } = createService();
    await service.putOpeningHours(String(ownerUserId), String(business?._id), []);
    expect(business?.ownerUserId.equals(ownerUserId)).toBe(true);
  });
});
