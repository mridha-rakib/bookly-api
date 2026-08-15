import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

import type { BusinessDocument } from "../../src/modules/business/business.model.js";
import type { BusinessRepository } from "../../src/modules/business/business.repository.js";
import type { BusinessAccessRepository } from "../../src/modules/business/business-access.repository.js";
import type {
  BusinessTravelCitySetting,
  BusinessTravelSettingsDocument,
} from "../../src/modules/business-travel-settings/business-travel-settings.model.js";
import type { BusinessTravelSettingsRepository } from "../../src/modules/business-travel-settings/business-travel-settings.repository.js";
import { updateBusinessTravelSettingsBodySchema } from "../../src/modules/business-travel-settings/business-travel-settings.schema.js";
import { BusinessTravelSettingsService } from "../../src/modules/business-travel-settings/business-travel-settings.service.js";

const buildBusiness = (overrides: Partial<BusinessDocument> = {}): BusinessDocument =>
  ({
    _id: new Types.ObjectId(),
    ownerUserId: new Types.ObjectId(),
    name: "Travel Studio",
    ownerName: "Owner Name",
    email: "owner@example.com",
    phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
    status: "PENDING",
    visitType: "TRAVEL_TO_CUSTOMER",
    address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
    briefDescription: "A mobile business",
    category: "Wellness",
    subcategories: ["Massage"],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  }) as BusinessDocument;

class FakeBusinessTravelSettingsRepository implements Partial<BusinessTravelSettingsRepository> {
  public settings = new Map<string, BusinessTravelSettingsDocument>();

  public readonly findByBusinessId = vi.fn(async (businessId: Types.ObjectId | string) => {
    return this.settings.get(String(businessId)) ?? null;
  });

  public readonly upsertByBusinessId = vi.fn(
    async (businessId: Types.ObjectId | string, cities: BusinessTravelCitySetting[]) => {
      const existing = this.settings.get(String(businessId));
      const now = new Date();
      const document = {
        _id: existing?._id ?? new Types.ObjectId(),
        businessId: new Types.ObjectId(String(businessId)),
        cities,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      } as BusinessTravelSettingsDocument;
      this.settings.set(String(businessId), document);
      return document;
    },
  );
}

const createService = (input: { business?: BusinessDocument | null; linked?: boolean } = {}) => {
  const ownerUserId = new Types.ObjectId();
  const business = input.business === undefined ? buildBusiness({ ownerUserId }) : input.business;
  const businessRepository = {
    findById: vi.fn().mockResolvedValue(business),
  };
  const businessAccessRepository = {
    findByUserAndBusiness: vi
      .fn()
      .mockResolvedValue(input.linked ? { _id: new Types.ObjectId() } : null),
  };
  const travelSettingsRepository = new FakeBusinessTravelSettingsRepository();
  const service = new BusinessTravelSettingsService(
    travelSettingsRepository as unknown as BusinessTravelSettingsRepository,
    businessRepository as unknown as BusinessRepository,
    businessAccessRepository as unknown as BusinessAccessRepository,
  );

  return {
    ownerUserId,
    business,
    businessRepository,
    businessAccessRepository,
    travelSettingsRepository,
    service,
  };
};

describe("BusinessTravelSettingsService", () => {
  it("owner reads empty settings as canonical inactive defaults without persisting", async () => {
    const { service, business, ownerUserId, travelSettingsRepository } = createService();

    const result = await service.getBusinessTravelSettings(
      String(ownerUserId),
      String(business?._id),
    );

    expect(result.cities).toHaveLength(6);
    expect(result.cities.every((city) => city.active === false && city.feeCents === 0)).toBe(true);
    expect(travelSettingsRepository.upsertByBusinessId).not.toHaveBeenCalled();
  });

  it("owner configures one city and persists it", async () => {
    const { service, business, ownerUserId } = createService();

    const result = await service.updateBusinessTravelSettings(
      String(ownerUserId),
      String(business?._id),
      [{ city: "Limassol", active: true, feeCents: 2000 }],
    );

    expect(result.cities.find((city) => city.city === "Limassol")).toMatchObject({
      active: true,
      feeCents: 2000,
    });
    expect(result.cities.find((city) => city.city === "Larnaca")).toMatchObject({
      active: false,
      feeCents: 0,
    });
  });

  it("reloads persisted settings", async () => {
    const { service, business, ownerUserId } = createService();
    await service.updateBusinessTravelSettings(String(ownerUserId), String(business?._id), [
      { city: "Larnaca", active: true, feeCents: 0 },
      { city: "Paphos", active: true, feeCents: 3000 },
    ]);

    const result = await service.getBusinessTravelSettings(
      String(ownerUserId),
      String(business?._id),
    );

    expect(result.cities.find((city) => city.city === "Larnaca")).toMatchObject({
      active: true,
      feeCents: 0,
    });
    expect(result.cities.find((city) => city.city === "Paphos")).toMatchObject({
      active: true,
      feeCents: 3000,
    });
  });

  it("supports multiple canonical cities", async () => {
    const { service, business, ownerUserId } = createService();

    const result = await service.updateBusinessTravelSettings(
      String(ownerUserId),
      String(business?._id),
      [
        { city: "Ayia Napa", active: true, feeCents: 4000 },
        { city: "Protaras", active: true, feeCents: 5000 },
      ],
    );

    expect(result.cities.filter((city) => city.active)).toHaveLength(2);
  });

  it("rejects duplicate cities at request validation", () => {
    const result = updateBusinessTravelSettingsBodySchema.safeParse({
      cities: [
        { city: "Larnaca", active: true, feeCents: 0 },
        { city: "Larnaca", active: false, feeCents: 100 },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects invalid cities at request validation", () => {
    const result = updateBusinessTravelSettingsBodySchema.safeParse({
      cities: [{ city: "Famagusta", active: true, feeCents: 1000 }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects negative fees at request validation", () => {
    const result = updateBusinessTravelSettingsBodySchema.safeParse({
      cities: [{ city: "Larnaca", active: true, feeCents: -1 }],
    });

    expect(result.success).toBe(false);
  });

  it("allows zero fee for an active city", async () => {
    const { service, business, ownerUserId } = createService();
    await service.updateBusinessTravelSettings(String(ownerUserId), String(business?._id), [
      { city: "Larnaca", active: true, feeCents: 0 },
    ]);

    const result = await service.resolveTravelFee({
      businessId: String(business?._id),
      customerCity: "Larnaca",
      serviceDeliveryType: "TRAVEL_TO_CUSTOMER",
      serviceSubtotalCents: 8000,
    });

    expect(result).toMatchObject({
      status: "SERVED",
      travelFeeCents: 0,
      totalDueCents: 8000,
      commissionableSubtotalCents: 8000,
    });
  });

  it("resolves inactive cities as NOT_SERVED", async () => {
    const { service, business, ownerUserId } = createService();
    await service.updateBusinessTravelSettings(String(ownerUserId), String(business?._id), [
      { city: "Nicosia", active: false, feeCents: 1000 },
    ]);

    const result = await service.resolveTravelFee({
      businessId: String(business?._id),
      customerCity: "Nicosia",
      serviceDeliveryType: "TRAVEL_TO_CUSTOMER",
    });

    expect(result).toMatchObject({ status: "NOT_SERVED", travelFeeCents: 0 });
  });

  it("resolves active city travel fee and keeps commission basis separate", async () => {
    const { service, business, ownerUserId } = createService();
    await service.updateBusinessTravelSettings(String(ownerUserId), String(business?._id), [
      { city: "Paphos", active: true, feeCents: 2000 },
    ]);

    const result = await service.resolveTravelFee({
      businessId: String(business?._id),
      customerCity: "Paphos",
      serviceDeliveryType: "TRAVEL_TO_CUSTOMER",
      serviceSubtotalCents: 8000,
    });

    expect(result).toMatchObject({
      status: "SERVED",
      travelFeeCents: 2000,
      serviceSubtotalCents: 8000,
      totalDueCents: 10_000,
      commissionableSubtotalCents: 8000,
    });
  });

  it("requires the Business to exist before resolving a travel fee", async () => {
    const { service } = createService({ business: null });

    await expect(
      service.resolveTravelFee({
        businessId: String(new Types.ObjectId()),
        customerCity: "Larnaca",
        serviceDeliveryType: "AT_BUSINESS_LOCATION",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects invalid resolver city input at runtime", async () => {
    const { service, business } = createService();

    await expect(
      service.resolveTravelFee({
        businessId: String(business?._id),
        customerCity: "Famagusta" as never,
        serviceDeliveryType: "TRAVEL_TO_CUSTOMER",
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      details: expect.arrayContaining([
        expect.objectContaining({ code: "BUSINESS_TRAVEL_SETTINGS_INVALID_CITY" }),
      ]),
    });
  });

  it("rejects invalid resolver delivery type input at runtime", async () => {
    const { service, business } = createService();

    await expect(
      service.resolveTravelFee({
        businessId: String(business?._id),
        customerCity: "Larnaca",
        serviceDeliveryType: "CUSTOMER_LOCATION" as never,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      details: expect.arrayContaining([
        expect.objectContaining({ code: "BUSINESS_TRAVEL_SETTINGS_INVALID_DELIVERY_TYPE" }),
      ]),
    });
  });

  it("rejects invalid resolver service subtotal money input", async () => {
    const { service, business } = createService();

    await expect(
      service.resolveTravelFee({
        businessId: String(business?._id),
        customerCity: "Larnaca",
        serviceDeliveryType: "TRAVEL_TO_CUSTOMER",
        serviceSubtotalCents: 10.5,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      details: expect.arrayContaining([
        expect.objectContaining({ code: "BUSINESS_TRAVEL_SETTINGS_INVALID_SERVICE_SUBTOTAL" }),
      ]),
    });

    await expect(
      service.resolveTravelFee({
        businessId: String(business?._id),
        customerCity: "Larnaca",
        serviceDeliveryType: "TRAVEL_TO_CUSTOMER",
        serviceSubtotalCents: -1,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      details: expect.arrayContaining([
        expect.objectContaining({ code: "BUSINESS_TRAVEL_SETTINGS_INVALID_SERVICE_SUBTOTAL" }),
      ]),
    });
  });

  it("resolves at-business services with no travel fee", async () => {
    const { service, business } = createService();

    const result = await service.resolveTravelFee({
      businessId: String(business?._id),
      customerCity: "Limassol",
      serviceDeliveryType: "AT_BUSINESS_LOCATION",
      serviceSubtotalCents: 8000,
    });

    expect(result).toMatchObject({
      status: "NOT_APPLICABLE",
      travelFeeCents: 0,
      totalDueCents: 8000,
      commissionableSubtotalCents: 8000,
    });
  });

  it("blocks linked Secondary users from updating", async () => {
    const ownerUserId = new Types.ObjectId();
    const linkedUserId = new Types.ObjectId();
    const business = buildBusiness({ ownerUserId });
    const { service } = createService({ business, linked: true });

    await expect(
      service.updateBusinessTravelSettings(String(linkedUserId), String(business._id), [
        { city: "Larnaca", active: true, feeCents: 100 },
      ]),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("blocks unrelated users from reading and writing", async () => {
    const business = buildBusiness();
    const { service } = createService({ business });
    const unrelatedUserId = String(new Types.ObjectId());

    await expect(
      service.getBusinessTravelSettings(unrelatedUserId, String(business._id)),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.updateBusinessTravelSettings(unrelatedUserId, String(business._id), []),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("does not let one Business owner mutate another Business settings", async () => {
    const business = buildBusiness();
    const { service } = createService({ business });

    await expect(
      service.updateBusinessTravelSettings(String(new Types.ObjectId()), String(business._id), [
        { city: "Larnaca", active: true, feeCents: 100 },
      ]),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("does not change Business ownership while updating settings", async () => {
    const { service, business, ownerUserId } = createService();

    await service.updateBusinessTravelSettings(String(ownerUserId), String(business?._id), [
      { city: "Larnaca", active: true, feeCents: 100 },
    ]);

    expect(business?.ownerUserId.equals(ownerUserId)).toBe(true);
  });
});
