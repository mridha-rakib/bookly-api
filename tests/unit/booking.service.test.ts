import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import type { AddonDocument } from "../../src/modules/addons/addon.model.js";
import type { AddonRepository } from "../../src/modules/addons/addon.repository.js";
import type { AddonServiceAssignmentDocument } from "../../src/modules/addons/addon-service-assignment.model.js";
import type { AddonServiceAssignmentRepository } from "../../src/modules/addons/addon-service-assignment.repository.js";
import type { BookingFulfilment } from "../../src/modules/booking/booking.model.js";
import type { BookingRepository } from "../../src/modules/booking/booking.repository.js";
import { BookingService } from "../../src/modules/booking/booking.service.js";
import type { BusinessDocument } from "../../src/modules/business/business.model.js";
import type { BusinessRepository } from "../../src/modules/business/business.repository.js";
import type { BusinessClientDocument } from "../../src/modules/client/client.model.js";
import type { ClientRepository } from "../../src/modules/client/client.repository.js";
import type { ServiceDocument } from "../../src/modules/services/service.model.js";
import type { ServiceRepository } from "../../src/modules/services/service.repository.js";
import type { StaffMembershipDocument } from "../../src/modules/staff/staff.model.js";
import type { StaffRepository } from "../../src/modules/staff/staff.repository.js";

const buildBusiness = (overrides: Partial<BusinessDocument> = {}): BusinessDocument =>
  ({
    _id: new Types.ObjectId(),
    ownerUserId: new Types.ObjectId(),
    name: "Ledra Barbers",
    ownerName: "Owner Name",
    email: "owner@example.com",
    phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
    status: "APPROVED",
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

const buildService = (
  businessId: Types.ObjectId,
  overrides: Partial<ServiceDocument> = {},
): ServiceDocument =>
  ({
    _id: new Types.ObjectId(),
    businessId,
    status: "ACTIVE",
    isFeatured: false,
    isPackageDeal: false,
    category: "Barber",
    name: "Haircut",
    pricingMode: "FIXED",
    fixedPricing: { priceCents: 2000, durationMin: 30 },
    sessionExpiryAlert: { enabled: false },
    scheduleMode: "AUTO",
    manualSchedule: [],
    servedCities: [],
    assignedStaffMembershipIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as ServiceDocument;

const buildStaffMembership = (
  businessId: Types.ObjectId,
  overrides: Partial<StaffMembershipDocument> = {},
): StaffMembershipDocument =>
  ({
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    businessId,
    role: "STAFF",
    employmentActive: true,
    createdByUserId: new Types.ObjectId(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as StaffMembershipDocument;

const buildClient = (
  businessId: Types.ObjectId,
  overrides: Partial<BusinessClientDocument> = {},
): BusinessClientDocument =>
  ({
    _id: new Types.ObjectId(),
    businessId,
    createdByUserId: new Types.ObjectId(),
    firstName: "Jane",
    lastName: "Doe",
    normalizedEmail: "jane@example.com",
    phone: { countryCode: "+357", nationalNumber: "99112244", e164: "+35799112244" },
    address: {
      city: "Larnaca",
      propertyType: "Apartment",
      area: "Center",
      streetName: "Main",
      streetNumber: "1",
    },
    linkState: "UNLINKED",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as BusinessClientDocument;

const buildAddon = (
  businessId: Types.ObjectId,
  overrides: Partial<AddonDocument> = {},
): AddonDocument =>
  ({
    _id: new Types.ObjectId(),
    businessId,
    status: "ACTIVE",
    name: "Hair wash",
    priceCents: 500,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as AddonDocument;

const buildHarness = () => {
  const business = buildBusiness();
  const ownerUserId = business.ownerUserId;

  const staffRepository = {
    findActiveById: vi.fn(),
    findActiveByUserId: vi.fn(),
  };
  const serviceRepository = { findById: vi.fn() };
  const addonRepository = { findManyByIdsForBusiness: vi.fn() };
  const addonServiceAssignmentRepository = { findByServiceIds: vi.fn() };
  const clientRepository = { findById: vi.fn() };
  const businessRepository = { findById: vi.fn().mockResolvedValue(business) };
  const bookingRepository = { findManyByBusinessIdInRange: vi.fn().mockResolvedValue([]) };

  const service = new BookingService(
    businessRepository as unknown as BusinessRepository,
    staffRepository as unknown as StaffRepository,
    serviceRepository as unknown as ServiceRepository,
    addonRepository as unknown as AddonRepository,
    addonServiceAssignmentRepository as unknown as AddonServiceAssignmentRepository,
    clientRepository as unknown as ClientRepository,
    bookingRepository as unknown as BookingRepository,
  );

  return {
    business,
    ownerUserId,
    service,
    staffRepository,
    serviceRepository,
    addonRepository,
    addonServiceAssignmentRepository,
    clientRepository,
    businessRepository,
    bookingRepository,
  };
};

describe("BookingService.requireBookingManagementAccess", () => {
  it("grants the owning Business Owner", async () => {
    const { service, business, ownerUserId } = buildHarness();
    const result = await service.requireBookingManagementAccess(
      String(ownerUserId),
      "BUSINESS_OWNER",
      String(business._id),
    );
    expect(result._id.equals(business._id)).toBe(true);
  });

  it("rejects an unrelated Business Owner", async () => {
    const { service, business } = buildHarness();
    await expect(
      service.requireBookingManagementAccess(
        String(new Types.ObjectId()),
        "BUSINESS_OWNER",
        String(business._id),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("grants an active SUPERVISOR membership on the same Business", async () => {
    const { service, business, staffRepository } = buildHarness();
    const supervisorUserId = new Types.ObjectId();
    staffRepository.findActiveByUserId.mockResolvedValue(
      buildStaffMembership(business._id, { userId: supervisorUserId, role: "SUPERVISOR" }),
    );

    const result = await service.requireBookingManagementAccess(
      String(supervisorUserId),
      "SUPERVISOR",
      String(business._id),
    );
    expect(result._id.equals(business._id)).toBe(true);
  });

  it("rejects a SUPERVISOR whose active membership is on a different Business", async () => {
    const { service, business, staffRepository } = buildHarness();
    const supervisorUserId = new Types.ObjectId();
    staffRepository.findActiveByUserId.mockResolvedValue(
      buildStaffMembership(new Types.ObjectId(), { userId: supervisorUserId, role: "SUPERVISOR" }),
    );

    await expect(
      service.requireBookingManagementAccess(
        String(supervisorUserId),
        "SUPERVISOR",
        String(business._id),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects a STAFF membership even when it claims the SUPERVISOR role param", async () => {
    const { service, business, staffRepository } = buildHarness();
    const staffUserId = new Types.ObjectId();
    staffRepository.findActiveByUserId.mockResolvedValue(
      buildStaffMembership(business._id, { userId: staffUserId, role: "STAFF" }),
    );

    await expect(
      service.requireBookingManagementAccess(
        String(staffUserId),
        "SUPERVISOR",
        String(business._id),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects STAFF and CUSTOMER actor roles outright — no booking-management permission in this phase", async () => {
    const { service, business } = buildHarness();
    await expect(
      service.requireBookingManagementAccess(
        String(new Types.ObjectId()),
        "STAFF",
        String(business._id),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.requireBookingManagementAccess(
        String(new Types.ObjectId()),
        "CUSTOMER",
        String(business._id),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects an invalid business id and an unknown business", async () => {
    const { service, businessRepository } = buildHarness();
    await expect(
      service.requireBookingManagementAccess(
        String(new Types.ObjectId()),
        "BUSINESS_OWNER",
        "bad-id",
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    businessRepository.findById.mockResolvedValueOnce(null);
    await expect(
      service.requireBookingManagementAccess(
        String(new Types.ObjectId()),
        "BUSINESS_OWNER",
        String(new Types.ObjectId()),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("BookingService.validateResponsibleStaff", () => {
  it("accepts a STAFF membership assigned to the Service", async () => {
    const { service, business, staffRepository, serviceRepository } = buildHarness();
    const membership = buildStaffMembership(business._id, { role: "STAFF" });
    const svc = buildService(business._id, { assignedStaffMembershipIds: [membership._id] });
    serviceRepository.findById.mockResolvedValue(svc);
    staffRepository.findActiveById.mockResolvedValue(membership);

    const result = await service.validateResponsibleStaff(
      business,
      String(svc._id),
      String(membership._id),
    );
    expect(result.staffMembership._id.equals(membership._id)).toBe(true);
    expect(result.service._id.equals(svc._id)).toBe(true);
  });

  it("accepts a SUPERVISOR membership assigned to the Service", async () => {
    const { service, business, staffRepository, serviceRepository } = buildHarness();
    const membership = buildStaffMembership(business._id, { role: "SUPERVISOR" });
    const svc = buildService(business._id, { assignedStaffMembershipIds: [membership._id] });
    serviceRepository.findById.mockResolvedValue(svc);
    staffRepository.findActiveById.mockResolvedValue(membership);

    await expect(
      service.validateResponsibleStaff(business, String(svc._id), String(membership._id)),
    ).resolves.toBeDefined();
  });

  it("rejects when the Service does not exist for this Business", async () => {
    const { service, business, serviceRepository } = buildHarness();
    serviceRepository.findById.mockResolvedValue(null);

    await expect(
      service.validateResponsibleStaff(
        business,
        String(new Types.ObjectId()),
        String(new Types.ObjectId()),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects an archived Service", async () => {
    const { service, business, serviceRepository } = buildHarness();
    serviceRepository.findById.mockResolvedValue(
      buildService(business._id, { status: "ARCHIVED" }),
    );

    await expect(
      service.validateResponsibleStaff(
        business,
        String(new Types.ObjectId()),
        String(new Types.ObjectId()),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects an unknown StaffMembership id", async () => {
    const { service, business, serviceRepository, staffRepository } = buildHarness();
    serviceRepository.findById.mockResolvedValue(buildService(business._id));
    staffRepository.findActiveById.mockResolvedValue(null);

    await expect(
      service.validateResponsibleStaff(
        business,
        String(new Types.ObjectId()),
        String(new Types.ObjectId()),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects the Business Owner's own userId — Owner has no StaffMembership row at all", async () => {
    const { service, business, serviceRepository, staffRepository } = buildHarness();
    serviceRepository.findById.mockResolvedValue(buildService(business._id));
    // findActiveById(businessId, ownerUserId) correctly returns null in the real repository —
    // there is no StaffMembership document for the Owner to find.
    staffRepository.findActiveById.mockResolvedValue(null);

    await expect(
      service.validateResponsibleStaff(
        business,
        String(new Types.ObjectId()),
        String(business.ownerUserId),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects a StaffMembership that is not employmentActive", async () => {
    const { service, business, serviceRepository, staffRepository } = buildHarness();
    const membership = buildStaffMembership(business._id, { employmentActive: false });
    serviceRepository.findById.mockResolvedValue(
      buildService(business._id, { assignedStaffMembershipIds: [membership._id] }),
    );
    staffRepository.findActiveById.mockResolvedValue(membership);

    await expect(
      service.validateResponsibleStaff(
        business,
        String(new Types.ObjectId()),
        String(membership._id),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a StaffMembership not assigned to the selected Service", async () => {
    const { service, business, serviceRepository, staffRepository } = buildHarness();
    const membership = buildStaffMembership(business._id);
    serviceRepository.findById.mockResolvedValue(
      buildService(business._id, { assignedStaffMembershipIds: [] }),
    );
    staffRepository.findActiveById.mockResolvedValue(membership);

    await expect(
      service.validateResponsibleStaff(
        business,
        String(new Types.ObjectId()),
        String(membership._id),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("BookingService.validateCustomerReference", () => {
  it("accepts a BusinessClient belonging to this Business", async () => {
    const { service, business, clientRepository } = buildHarness();
    const client = buildClient(business._id);
    clientRepository.findById.mockResolvedValue(client);

    const result = await service.validateCustomerReference(business, String(client._id));
    expect(result._id.equals(client._id)).toBe(true);
  });

  it("rejects a cross-Business Client reference the same way as an unknown id", async () => {
    // ClientRepository.findById(businessId, clientId) already scopes by businessId in the real
    // repository, so a Client belonging to a different Business simply never resolves —
    // simulated here by the fake returning null, exactly like a genuinely unknown id.
    const { service, business, clientRepository } = buildHarness();
    clientRepository.findById.mockResolvedValue(null);

    await expect(
      service.validateCustomerReference(business, String(new Types.ObjectId())),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects an invalid client id", async () => {
    const { service, business } = buildHarness();
    await expect(service.validateCustomerReference(business, "bad-id")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("BookingService.resolveAddonSnapshots", () => {
  it("returns an empty array for no requested Add-ons without querying anything", async () => {
    const { service, business, addonRepository, addonServiceAssignmentRepository } = buildHarness();
    const result = await service.resolveAddonSnapshots(business, String(new Types.ObjectId()), []);
    expect(result).toEqual([]);
    expect(addonRepository.findManyByIdsForBusiness).not.toHaveBeenCalled();
    expect(addonServiceAssignmentRepository.findByServiceIds).not.toHaveBeenCalled();
  });

  it("snapshots Add-ons assigned to the Service, batched in two queries", async () => {
    const { service, business, addonRepository, addonServiceAssignmentRepository } = buildHarness();
    const serviceId = new Types.ObjectId();
    const addonA = buildAddon(business._id, { name: "Hair wash", priceCents: 500 });
    const addonB = buildAddon(business._id, { name: "Scalp treatment", priceCents: 800 });
    addonRepository.findManyByIdsForBusiness.mockResolvedValue([addonA, addonB]);
    addonServiceAssignmentRepository.findByServiceIds.mockResolvedValue([
      { addonId: addonA._id, serviceId } as AddonServiceAssignmentDocument,
      { addonId: addonB._id, serviceId } as AddonServiceAssignmentDocument,
    ]);

    const result = await service.resolveAddonSnapshots(business, String(serviceId), [
      String(addonA._id),
      String(addonB._id),
    ]);

    expect(result).toEqual(
      expect.arrayContaining([
        { addonId: addonA._id, name: "Hair wash", priceCents: 500 },
        { addonId: addonB._id, name: "Scalp treatment", priceCents: 800 },
      ]),
    );
    expect(addonRepository.findManyByIdsForBusiness).toHaveBeenCalledTimes(1);
    expect(addonServiceAssignmentRepository.findByServiceIds).toHaveBeenCalledTimes(1);
  });

  it("dedupes repeated addonIds in the request", async () => {
    const { service, business, addonRepository, addonServiceAssignmentRepository } = buildHarness();
    const serviceId = new Types.ObjectId();
    const addon = buildAddon(business._id);
    addonRepository.findManyByIdsForBusiness.mockResolvedValue([addon]);
    addonServiceAssignmentRepository.findByServiceIds.mockResolvedValue([
      { addonId: addon._id, serviceId } as AddonServiceAssignmentDocument,
    ]);

    const result = await service.resolveAddonSnapshots(business, String(serviceId), [
      String(addon._id),
      String(addon._id),
    ]);

    expect(result).toHaveLength(1);
  });

  it("rejects an Add-on that does not exist for this Business", async () => {
    const { service, business, addonRepository, addonServiceAssignmentRepository } = buildHarness();
    addonRepository.findManyByIdsForBusiness.mockResolvedValue([]);
    addonServiceAssignmentRepository.findByServiceIds.mockResolvedValue([]);

    await expect(
      service.resolveAddonSnapshots(business, String(new Types.ObjectId()), [
        String(new Types.ObjectId()),
      ]),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects an Add-on that exists but is not assigned to the selected Service", async () => {
    const { service, business, addonRepository, addonServiceAssignmentRepository } = buildHarness();
    const addon = buildAddon(business._id);
    addonRepository.findManyByIdsForBusiness.mockResolvedValue([addon]);
    addonServiceAssignmentRepository.findByServiceIds.mockResolvedValue([]);

    await expect(
      service.resolveAddonSnapshots(business, String(new Types.ObjectId()), [String(addon._id)]),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("BookingService.validateFulfilmentSnapshot", () => {
  it("accepts a matching AT_BUSINESS_LOCATION snapshot", () => {
    const { service, business } = buildHarness();
    const fulfilment: BookingFulfilment = {
      mode: "AT_BUSINESS_LOCATION",
      businessLocation: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
    };
    expect(() => service.validateFulfilmentSnapshot(business, fulfilment)).not.toThrow();
  });

  it("rejects a mode mismatch against the Business's own visitType", () => {
    const { service, business } = buildHarness();
    const fulfilment: BookingFulfilment = {
      mode: "TRAVEL_TO_CUSTOMER",
      travelAddress: {
        city: "Larnaca",
        propertyType: "Apartment",
        area: "Center",
        streetName: "Main",
        streetNumber: "1",
      },
    };
    expect(() => service.validateFulfilmentSnapshot(business, fulfilment)).toThrow(
      expect.objectContaining({ statusCode: 409 }),
    );
  });

  it("rejects AT_BUSINESS_LOCATION missing its business-location snapshot", () => {
    const { service, business } = buildHarness();
    expect(() =>
      service.validateFulfilmentSnapshot(business, { mode: "AT_BUSINESS_LOCATION" }),
    ).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it("rejects AT_BUSINESS_LOCATION that also carries a travel address", () => {
    const { service, business } = buildHarness();
    expect(() =>
      service.validateFulfilmentSnapshot(business, {
        mode: "AT_BUSINESS_LOCATION",
        businessLocation: {
          city: "Larnaca",
          area: "Center",
          streetName: "Main",
          streetNumber: "1",
        },
        travelAddress: {
          city: "Larnaca",
          propertyType: "Apartment",
          area: "Center",
          streetName: "Main",
          streetNumber: "1",
        },
      }),
    ).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it("accepts a matching TRAVEL_TO_CUSTOMER snapshot", () => {
    const { service } = buildHarness();
    const travelBusiness = buildBusiness({ visitType: "TRAVEL_TO_CUSTOMER" });
    const fulfilment: BookingFulfilment = {
      mode: "TRAVEL_TO_CUSTOMER",
      travelAddress: {
        city: "Larnaca",
        propertyType: "Apartment",
        area: "Center",
        streetName: "Main",
        streetNumber: "1",
      },
    };
    expect(() => service.validateFulfilmentSnapshot(travelBusiness, fulfilment)).not.toThrow();
  });

  it("rejects TRAVEL_TO_CUSTOMER missing its travel-address snapshot", () => {
    const { service } = buildHarness();
    const travelBusiness = buildBusiness({ visitType: "TRAVEL_TO_CUSTOMER" });
    expect(() =>
      service.validateFulfilmentSnapshot(travelBusiness, { mode: "TRAVEL_TO_CUSTOMER" }),
    ).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});

describe("BookingService.validateManualBookingHasNoBooklyFee", () => {
  it("accepts a MANUAL booking with zero fee and zero deposit", () => {
    const { service } = buildHarness();
    expect(() =>
      service.validateManualBookingHasNoBooklyFee("MANUAL", {
        platformFeeCents: 0,
        depositCents: 0,
      }),
    ).not.toThrow();
  });

  it("rejects a MANUAL booking with a non-zero platform fee", () => {
    const { service } = buildHarness();
    expect(() =>
      service.validateManualBookingHasNoBooklyFee("MANUAL", {
        platformFeeCents: 500,
        depositCents: 0,
      }),
    ).toThrow(expect.objectContaining({ statusCode: 409 }));
  });

  it("rejects a MANUAL booking with a non-zero deposit", () => {
    const { service } = buildHarness();
    expect(() =>
      service.validateManualBookingHasNoBooklyFee("MANUAL", {
        platformFeeCents: 0,
        depositCents: 800,
      }),
    ).toThrow(expect.objectContaining({ statusCode: 409 }));
  });

  it("does not constrain a BOOKLY_MANAGED booking's fee/deposit", () => {
    const { service } = buildHarness();
    expect(() =>
      service.validateManualBookingHasNoBooklyFee("BOOKLY_MANAGED", {
        platformFeeCents: 500,
        depositCents: 800,
      }),
    ).not.toThrow();
  });
});

describe("BookingService.calculateBookingDepositCents (Batch 6.5 — renamed from calculatePlatformFeeCents; same formula, corrected name)", () => {
  it("clamps small amounts to the €5 floor (rule M example: €10 -> €5)", () => {
    const { service } = buildHarness();
    expect(service.calculateBookingDepositCents(1000)).toBe(500);
  });

  it("applies the flat 20% in the middle of the range (rule M example: €100 -> €20)", () => {
    const { service } = buildHarness();
    expect(service.calculateBookingDepositCents(10_000)).toBe(2000);
  });

  it("clamps large amounts to the €35 ceiling (rule M example: €2,000 -> €35)", () => {
    const { service } = buildHarness();
    expect(service.calculateBookingDepositCents(200_000)).toBe(3500);
  });

  it("floors at exactly €5 for a zero-eligible basis", () => {
    const { service } = buildHarness();
    expect(service.calculateBookingDepositCents(0)).toBe(500);
  });

  it("is exclusive of any travel fee by contract — callers must exclude it from the basis", () => {
    // This is a documentation-style test: the function has no travel-fee parameter at all, so
    // there is no way to accidentally include it — the exclusion is structural.
    const { service } = buildHarness();
    expect(service.calculateBookingDepositCents.length).toBe(1);
  });

  it("rejects a negative basis", () => {
    const { service } = buildHarness();
    expect(() => service.calculateBookingDepositCents(-1)).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("rejects a non-integer basis", () => {
    const { service } = buildHarness();
    expect(() => service.calculateBookingDepositCents(10.5)).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });
});

describe("BookingService.requireBoundedRange (item 11)", () => {
  it("accepts a same-day range", () => {
    const { service } = buildHarness();
    expect(() =>
      service.requireBoundedRange(
        new Date("2026-08-25T00:00:00.000Z"),
        new Date("2026-08-25T23:59:59.000Z"),
      ),
    ).not.toThrow();
  });

  it("accepts a range at exactly the maximum width", () => {
    const { service } = buildHarness();
    const startAt = new Date("2026-01-01T00:00:00.000Z");
    const endAt = new Date(startAt.getTime() + 366 * 24 * 60 * 60 * 1000);
    expect(() => service.requireBoundedRange(startAt, endAt)).not.toThrow();
  });

  it("rejects a range wider than the maximum", () => {
    const { service } = buildHarness();
    const startAt = new Date("2026-01-01T00:00:00.000Z");
    const endAt = new Date(startAt.getTime() + 367 * 24 * 60 * 60 * 1000);
    expect(() => service.requireBoundedRange(startAt, endAt)).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("rejects an inverted range (start at or after end)", () => {
    const { service } = buildHarness();
    const at = new Date("2026-08-25T00:00:00.000Z");
    expect(() => service.requireBoundedRange(at, at)).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(() => service.requireBoundedRange(new Date(at.getTime() + 1000), at)).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });
});

describe("BookingService.findBookingsInRange (item 11)", () => {
  it("validates the range before ever calling the repository", async () => {
    const { service, business, bookingRepository } = buildHarness();
    const at = new Date("2026-08-25T00:00:00.000Z");

    await expect(service.findBookingsInRange(business, at, at)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(bookingRepository.findManyByBusinessIdInRange).not.toHaveBeenCalled();
  });

  it("defaults to excludeHistory: true for list reads, and delegates to the repository", async () => {
    const { service, business, bookingRepository } = buildHarness();
    const startAt = new Date("2026-08-25T00:00:00.000Z");
    const endAt = new Date("2026-08-26T00:00:00.000Z");

    await service.findBookingsInRange(business, startAt, endAt);

    expect(bookingRepository.findManyByBusinessIdInRange).toHaveBeenCalledWith(
      business._id,
      startAt,
      endAt,
      { excludeHistory: true },
    );
  });
});
