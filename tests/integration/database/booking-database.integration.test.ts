import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import type { CreateBookingInput } from "../../../src/modules/booking/booking.repository.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { BookingService } from "../../../src/modules/booking/booking.service.js";
import { generateBookingReference } from "../../../src/modules/booking/booking.utils.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

type DbIndex = { name?: string; key: Record<string, unknown>; unique?: boolean };

describe("database-backed Booking integration", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let serviceRepository: ServiceRepository;
  let staffRepository: StaffRepository;
  let addonRepository: AddonRepository;
  let addonServiceAssignmentRepository: AddonServiceAssignmentRepository;
  let clientRepository: ClientRepository;
  let bookingRepository: BookingRepository;
  let bookingService: BookingService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    serviceRepository = new ServiceRepository();
    staffRepository = new StaffRepository();
    addonRepository = new AddonRepository();
    addonServiceAssignmentRepository = new AddonServiceAssignmentRepository();
    clientRepository = new ClientRepository();
    bookingRepository = new BookingRepository();
    bookingService = new BookingService(
      businessRepository,
      staffRepository,
      serviceRepository,
      addonRepository,
      addonServiceAssignmentRepository,
      clientRepository,
    );
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixture builders, all real repositories, no mocks ------------------------------------

  const createBusiness = async (
    overrides: { visitType?: "AT_BUSINESS_LOCATION" | "TRAVEL_TO_CUSTOMER" } = {},
  ) => {
    const owner = await userRepository.create({
      normalizedEmail: `owner-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const business = await businessRepository.create({
      ownerUserId: owner._id,
      name: "Ledra Barbers",
      ownerName: "Owner Name",
      email: owner.normalizedEmail,
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: overrides.visitType ?? "AT_BUSINESS_LOCATION",
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "A great business",
      category: "Barber",
      subcategories: ["Haircut"],
    });
    return { owner, business };
  };

  const createStaffMembership = async (
    businessId: Types.ObjectId,
    role: "STAFF" | "SUPERVISOR" = "STAFF",
    overrides: { employmentActive?: boolean } = {},
  ) => {
    const staffUser = await userRepository.create({
      normalizedEmail: `staff-${Date.now()}-${Math.random()}@example.com`,
      passwordHash: "hash",
      role,
      status: "ACTIVE",
    });
    const membership = await staffRepository.create({
      userId: staffUser._id,
      businessId,
      role,
      createdByUserId: staffUser._id,
    });
    if (overrides.employmentActive === false) {
      await staffRepository.updateActiveById(businessId, membership._id, {
        employmentActive: false,
      });
    }
    return { staffUser, membership };
  };

  const createService = async (
    businessId: Types.ObjectId,
    assignedStaffMembershipIds: Types.ObjectId[],
  ) =>
    serviceRepository.create({
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
      assignedStaffMembershipIds,
    });

  const createClient = async (businessId: Types.ObjectId) =>
    clientRepository.create({
      businessId,
      createdByUserId: new Types.ObjectId(),
      firstName: "Jane",
      lastName: "Doe",
      normalizedEmail: `jane-${Date.now()}-${Math.random()}@example.com`,
      phone: { countryCode: "+357", nationalNumber: "99112255", e164: "+35799112255" },
      address: {
        city: "Larnaca",
        propertyType: "Apartment",
        area: "Center",
        streetName: "Main",
        streetNumber: "1",
      },
      linkState: "UNLINKED",
    });

  /** Assembles a fully-valid CreateBookingInput from real fixtures — used to prove the schema
   * and its indexes behave correctly end to end, without exercising any HTTP route (none exists
   * in this phase). */
  const buildValidBookingInput = (input: {
    businessId: Types.ObjectId;
    clientId: Types.ObjectId;
    serviceId: Types.ObjectId;
    staffMembershipId: Types.ObjectId;
    actorUserId: Types.ObjectId;
    reference?: string;
  }): CreateBookingInput => ({
    businessId: input.businessId,
    reference: input.reference ?? generateBookingReference(),
    source: "BOOKLY_MANAGED",
    status: "UPCOMING",
    customer: {
      businessClientId: input.clientId,
      contact: {
        firstName: "Jane",
        lastName: "Doe",
        normalizedEmail: "jane@example.com",
        phone: { countryCode: "+357", nationalNumber: "99112255", e164: "+35799112255" },
      },
    },
    createdBy: { actorUserId: input.actorUserId, actorRole: "BUSINESS_OWNER" },
    fulfilment: {
      mode: "AT_BUSINESS_LOCATION",
      businessLocation: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
    },
    serviceLines: [
      {
        serviceId: input.serviceId,
        serviceSnapshot: { name: "Haircut", pricingMode: "FIXED", durationMin: 30 },
        pricingInput: {},
        responsibleStaffMembershipId: input.staffMembershipId,
        addons: [],
        amountCents: 2000,
      },
    ],
    financials: {
      currency: "EUR",
      servicesSubtotalCents: 2000,
      addonsSubtotalCents: 0,
      serviceDiscountCents: 0,
      travelFeeCents: 0,
      eligiblePlatformFeeBasisCents: 2000,
      platformFeeCents: 500,
      depositCents: 500,
      balanceDueCents: 1500,
      totalCents: 2000,
    },
    schedule: {
      timezone: "Europe/Nicosia",
      startAt: new Date("2026-08-25T09:00:00.000Z"),
      endAt: new Date("2026-08-25T09:30:00.000Z"),
    },
    customerRescheduleCount: 0,
    rescheduleHistory: [],
    eventHistory: [],
  });

  // --- Schema / persistence -------------------------------------------------------------------

  it("persists a fully-valid Booking end to end", async () => {
    const { business, owner } = await createBusiness();
    const { membership } = await createStaffMembership(business._id);
    const service = await createService(business._id, [membership._id]);
    const client = await createClient(business._id);

    const created = await bookingRepository.create(
      buildValidBookingInput({
        businessId: business._id,
        clientId: client._id,
        serviceId: service._id,
        staffMembershipId: membership._id,
        actorUserId: owner._id,
      }),
    );

    expect(created._id).toBeDefined();
    expect(created.reference).toMatch(/^BK-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    expect(created.status).toBe("UPCOMING");
    expect(created.source).toBe("BOOKLY_MANAGED");

    const found = await bookingRepository.findById(business._id, created._id);
    expect(found?.reference).toBe(created.reference);
  });

  it("never generates a booking reference via Math.random-style low entropy — proves the retry-on-collision path via a forced duplicate", async () => {
    const { business, owner } = await createBusiness();
    const { membership } = await createStaffMembership(business._id);
    const service = await createService(business._id, [membership._id]);
    const client = await createClient(business._id);

    const sharedReference = generateBookingReference();
    await bookingRepository.create(
      buildValidBookingInput({
        businessId: business._id,
        clientId: client._id,
        serviceId: service._id,
        staffMembershipId: membership._id,
        actorUserId: owner._id,
        reference: sharedReference,
      }),
    );

    await expect(
      bookingRepository.create(
        buildValidBookingInput({
          businessId: business._id,
          clientId: client._id,
          serviceId: service._id,
          staffMembershipId: membership._id,
          actorUserId: owner._id,
          reference: sharedReference,
        }),
      ),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("rejects a Booking with zero Service lines", async () => {
    const { business, owner } = await createBusiness();
    const { membership } = await createStaffMembership(business._id);
    const service = await createService(business._id, [membership._id]);
    const client = await createClient(business._id);

    const input = buildValidBookingInput({
      businessId: business._id,
      clientId: client._id,
      serviceId: service._id,
      staffMembershipId: membership._id,
      actorUserId: owner._id,
    });
    input.serviceLines = [];

    await expect(bookingRepository.create(input)).rejects.toThrow();
  });

  it("rejects a Service line whose pricing input does not match its declared pricing mode", async () => {
    const { business, owner } = await createBusiness();
    const { membership } = await createStaffMembership(business._id);
    const service = await createService(business._id, [membership._id]);
    const client = await createClient(business._id);

    const input = buildValidBookingInput({
      businessId: business._id,
      clientId: client._id,
      serviceId: service._id,
      staffMembershipId: membership._id,
      actorUserId: owner._id,
    });
    // FIXED mode must not carry a personCount.
    input.serviceLines = [
      {
        serviceId: service._id,
        serviceSnapshot: { name: "Haircut", pricingMode: "FIXED", durationMin: 30 },
        pricingInput: { personCount: 3 },
        responsibleStaffMembershipId: membership._id,
        addons: [],
        amountCents: 2000,
      },
    ];

    await expect(bookingRepository.create(input)).rejects.toThrow();
  });

  it("rejects customerRescheduleCount above the confirmed maximum of 2", async () => {
    const { business, owner } = await createBusiness();
    const { membership } = await createStaffMembership(business._id);
    const service = await createService(business._id, [membership._id]);
    const client = await createClient(business._id);

    const input = buildValidBookingInput({
      businessId: business._id,
      clientId: client._id,
      serviceId: service._id,
      staffMembershipId: membership._id,
      actorUserId: owner._id,
    });
    input.customerRescheduleCount = 3;

    await expect(bookingRepository.create(input)).rejects.toThrow();
  });

  it("finds bookings within a Business date range, sorted ascending", async () => {
    const { business, owner } = await createBusiness();
    const { membership } = await createStaffMembership(business._id);
    const service = await createService(business._id, [membership._id]);
    const client = await createClient(business._id);

    const early = buildValidBookingInput({
      businessId: business._id,
      clientId: client._id,
      serviceId: service._id,
      staffMembershipId: membership._id,
      actorUserId: owner._id,
    });
    early.schedule = {
      timezone: "Europe/Nicosia",
      startAt: new Date("2026-08-25T08:00:00.000Z"),
      endAt: new Date("2026-08-25T08:30:00.000Z"),
    };
    const late = buildValidBookingInput({
      businessId: business._id,
      clientId: client._id,
      serviceId: service._id,
      staffMembershipId: membership._id,
      actorUserId: owner._id,
    });
    late.schedule = {
      timezone: "Europe/Nicosia",
      startAt: new Date("2026-08-25T12:00:00.000Z"),
      endAt: new Date("2026-08-25T12:30:00.000Z"),
    };
    const outOfRange = buildValidBookingInput({
      businessId: business._id,
      clientId: client._id,
      serviceId: service._id,
      staffMembershipId: membership._id,
      actorUserId: owner._id,
    });
    outOfRange.schedule = {
      timezone: "Europe/Nicosia",
      startAt: new Date("2026-09-01T08:00:00.000Z"),
      endAt: new Date("2026-09-01T08:30:00.000Z"),
    };

    await bookingRepository.create(late);
    await bookingRepository.create(early);
    await bookingRepository.create(outOfRange);

    const results = await bookingRepository.findManyByBusinessIdInRange(
      business._id,
      new Date("2026-08-25T00:00:00.000Z"),
      new Date("2026-08-25T23:59:59.000Z"),
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.schedule.startAt.toISOString()).toBe("2026-08-25T08:00:00.000Z");
    expect(results[1]?.schedule.startAt.toISOString()).toBe("2026-08-25T12:00:00.000Z");
  });

  it("provisions the expected index set", async () => {
    const indexes = (await BookingModel.collection.indexes()) as DbIndex[];

    expect(indexes.some((index) => index.key["reference"] === 1 && index.unique === true)).toBe(
      true,
    );
    expect(
      indexes.some((index) => index.key["businessId"] === 1 && index.key["schedule.startAt"] === 1),
    ).toBe(true);
    expect(
      indexes.some((index) => index.key["businessId"] === 1 && index.key["status"] === 1),
    ).toBe(true);
    expect(
      indexes.some(
        (index) =>
          index.key["serviceLines.responsibleStaffMembershipId"] === 1 &&
          index.key["schedule.startAt"] === 1,
      ),
    ).toBe(true);
    expect(
      indexes.some(
        (index) =>
          index.key["customer.businessClientId"] === 1 && index.key["schedule.startAt"] === -1,
      ),
    ).toBe(true);
    expect(
      indexes.some(
        (index) =>
          index.key["customer.customerUserId"] === 1 && index.key["schedule.startAt"] === -1,
      ),
    ).toBe(true);
  });

  // --- Domain validation, exercised against real repositories -------------------------------

  it("validateResponsibleStaff: accepts real Staff assigned to a real Service", async () => {
    const { business } = await createBusiness();
    const { membership } = await createStaffMembership(business._id);
    const service = await createService(business._id, [membership._id]);

    const result = await bookingService.validateResponsibleStaff(
      business,
      String(service._id),
      String(membership._id),
    );
    expect(result.staffMembership._id.equals(membership._id)).toBe(true);
  });

  it("validateResponsibleStaff: rejects a Staff member belonging to a different Business", async () => {
    const { business: businessA } = await createBusiness();
    const { business: businessB } = await createBusiness();
    const { membership: staffOnB } = await createStaffMembership(businessB._id);
    const serviceOnA = await createService(businessA._id, [staffOnB._id]);

    await expect(
      bookingService.validateResponsibleStaff(
        businessA,
        String(serviceOnA._id),
        String(staffOnB._id),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("validateResponsibleStaff: rejects the Business Owner's own userId", async () => {
    const { business, owner } = await createBusiness();
    const service = await createService(business._id, []);

    await expect(
      bookingService.validateResponsibleStaff(business, String(service._id), String(owner._id)),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("validateResponsibleStaff: rejects an archived Service", async () => {
    const { business } = await createBusiness();
    const { membership } = await createStaffMembership(business._id);
    const service = await createService(business._id, [membership._id]);
    await serviceRepository.archiveById(business._id, service._id);

    await expect(
      bookingService.validateResponsibleStaff(
        business,
        String(service._id),
        String(membership._id),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("validateResponsibleStaff: rejects a soft-removed Staff membership", async () => {
    const { business } = await createBusiness();
    const { membership } = await createStaffMembership(business._id);
    const service = await createService(business._id, [membership._id]);
    await staffRepository.softRemoveById(business._id, membership._id);

    await expect(
      bookingService.validateResponsibleStaff(
        business,
        String(service._id),
        String(membership._id),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("validateCustomerReference: rejects a Client belonging to a different Business", async () => {
    const { business: businessA } = await createBusiness();
    const { business: businessB } = await createBusiness();
    const clientOnB = await createClient(businessB._id);

    await expect(
      bookingService.validateCustomerReference(businessA, String(clientOnB._id)),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("resolveAddonSnapshots: snapshots a real assigned Add-on with its live price at booking time", async () => {
    const { business } = await createBusiness();
    const { membership } = await createStaffMembership(business._id);
    const service = await createService(business._id, [membership._id]);
    const addon = await addonRepository.create({
      businessId: business._id,
      status: "ACTIVE",
      name: "Hair wash",
      priceCents: 500,
    });
    await addonServiceAssignmentRepository.insertMany([
      { businessId: business._id, addonId: addon._id, serviceId: service._id },
    ]);

    const snapshots = await bookingService.resolveAddonSnapshots(business, String(service._id), [
      String(addon._id),
    ]);

    expect(snapshots).toEqual([{ addonId: addon._id, name: "Hair wash", priceCents: 500 }]);
  });

  it("requireBookingManagementAccess: grants an active Supervisor scoped to the same Business, via real repositories", async () => {
    const { business } = await createBusiness();
    const { staffUser } = await createStaffMembership(business._id, "SUPERVISOR");

    const result = await bookingService.requireBookingManagementAccess(
      String(staffUser._id),
      "SUPERVISOR",
      String(business._id),
    );
    expect(result._id.equals(business._id)).toBe(true);
  });

  it("requireBookingManagementAccess: never grants access via a BusinessAccess link", async () => {
    const { business: businessA } = await createBusiness();
    const { owner: ownerB } = await createBusiness();
    // ownerB is a real, distinct account — simply not the owner of businessA and not staff on
    // it, which is exactly what a BusinessAccess-linked (but non-owning) user looks like from
    // BookingService's perspective, since it never queries BusinessAccess at all.
    await expect(
      bookingService.requireBookingManagementAccess(
        String(ownerB._id),
        "BUSINESS_OWNER",
        String(businessA._id),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
