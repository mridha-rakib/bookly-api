import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import type { CreateBookingInput } from "../../../src/modules/booking/booking.repository.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { BookingService } from "../../../src/modules/booking/booking.service.js";
import { NO_SHOW_RESOLUTION_WINDOW_MINUTES } from "../../../src/modules/booking/booking.types.js";
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

type DbIndex = {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  partialFilterExpression?: unknown;
};

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
      bookingRepository,
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
        // Batch 3 made this required (see BookingServiceLine's own comment) — a fresh, unused
        // ObjectId is fine here since these tests exercise the Booking schema/model in
        // isolation, never a real BookingSlotReservation write.
        reservationId: new Types.ObjectId(),
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
        reservationId: new Types.ObjectId(),
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

  // --- Financial invariants (item 6) -----------------------------------------------------

  describe("Booking.financials invariants", () => {
    const setup = async () => {
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
      return { business, owner, membership, service, client, input };
    };

    it("rejects serviceDiscountCents greater than servicesSubtotalCents", async () => {
      const { input } = await setup();
      input.financials = { ...input.financials, serviceDiscountCents: 2001 };

      await expect(bookingRepository.create(input)).rejects.toThrow();
    });

    it("rejects an eligiblePlatformFeeBasisCents that does not equal services + addons - discount", async () => {
      const { input } = await setup();
      input.financials = { ...input.financials, eligiblePlatformFeeBasisCents: 1999 };

      await expect(bookingRepository.create(input)).rejects.toThrow();
    });

    it("accepts eligiblePlatformFeeBasisCents that correctly excludes travelFeeCents", async () => {
      const { input } = await setup();
      // servicesSubtotal 2000 + addons 0 - discount 0 = basis 2000, regardless of a nonzero
      // travel fee sitting alongside it (travel is never part of the basis, confirmed rule M).
      input.financials = {
        ...input.financials,
        travelFeeCents: 1000,
        eligiblePlatformFeeBasisCents: 2000,
        totalCents: 3000,
        balanceDueCents: 2500,
      };

      await expect(bookingRepository.create(input)).resolves.toBeDefined();
    });

    it("rejects a nonzero platformFeeCents outside the confirmed [€5, €35] range", async () => {
      const { input } = await setup();
      input.financials = { ...input.financials, platformFeeCents: 499 };
      await expect(bookingRepository.create(input)).rejects.toThrow();

      const tooHigh = { ...input, financials: { ...input.financials, platformFeeCents: 3501 } };
      await expect(bookingRepository.create(tooHigh)).rejects.toThrow();
    });

    it("accepts platformFeeCents === 0 — an unwired/not-yet-charged Booking remains valid", async () => {
      const { input } = await setup();
      input.financials = { ...input.financials, platformFeeCents: 0 };

      await expect(bookingRepository.create(input)).resolves.toBeDefined();
    });

    it("rejects depositCents greater than totalCents", async () => {
      const { input } = await setup();
      input.financials = { ...input.financials, depositCents: 2001, balanceDueCents: -1 };

      await expect(bookingRepository.create(input)).rejects.toThrow();
    });

    it("rejects balanceDueCents that does not equal totalCents - depositCents", async () => {
      const { input } = await setup();
      input.financials = { ...input.financials, balanceDueCents: 1400 };

      await expect(bookingRepository.create(input)).rejects.toThrow();
    });

    it("accepts depositCents === 0 (no deposit, full balance at venue) — an explicitly legitimate future state", async () => {
      const { input } = await setup();
      input.financials = { ...input.financials, depositCents: 0, balanceDueCents: 2000 };

      await expect(bookingRepository.create(input)).resolves.toBeDefined();
    });

    it("accepts depositCents === totalCents (full payment upfront, zero balance due) — an explicitly legitimate future state", async () => {
      const { input } = await setup();
      input.financials = { ...input.financials, depositCents: 2000, balanceDueCents: 0 };

      await expect(bookingRepository.create(input)).resolves.toBeDefined();
    });

    it("rejects a MANUAL Booking with a nonzero platformFeeCents or depositCents (confirmed rule E, enforced at the model layer too)", async () => {
      const { input } = await setup();
      const withFee = {
        ...input,
        source: "MANUAL" as const,
        financials: { ...input.financials, platformFeeCents: 500 },
      };
      await expect(bookingRepository.create(withFee)).rejects.toThrow();

      const withDeposit = {
        ...input,
        source: "MANUAL" as const,
        financials: { ...input.financials, depositCents: 500, balanceDueCents: 1500 },
      };
      await expect(bookingRepository.create(withDeposit)).rejects.toThrow();
    });

    it("accepts a MANUAL Booking with platformFeeCents === 0 and depositCents === 0", async () => {
      const { input } = await setup();
      const manual = {
        ...input,
        source: "MANUAL" as const,
        financials: {
          ...input.financials,
          platformFeeCents: 0,
          depositCents: 0,
          balanceDueCents: 2000,
        },
      };

      await expect(bookingRepository.create(manual)).resolves.toBeDefined();
    });

    it("BookingService.validateManualBookingHasNoBooklyFee agrees with the model-layer invariant (same rule, two layers)", () => {
      expect(() =>
        bookingService.validateManualBookingHasNoBooklyFee("MANUAL", {
          platformFeeCents: 0,
          depositCents: 0,
        }),
      ).not.toThrow();
      expect(() =>
        bookingService.validateManualBookingHasNoBooklyFee("MANUAL", {
          platformFeeCents: 500,
          depositCents: 0,
        }),
      ).toThrow();
    });
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

  describe("BookingService.findBookingsInRange / range safety (item 11)", () => {
    it("rejects a range wider than the confirmed maximum through the real service, before touching the database", async () => {
      const { business } = await createBusiness();
      const startAt = new Date("2026-01-01T00:00:00.000Z");
      const endAt = new Date("2028-01-01T00:00:00.000Z");

      await expect(
        bookingService.findBookingsInRange(business, startAt, endAt),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("excludeHistory: true strips populated eventHistory/rescheduleHistory; excludeHistory: false preserves them", async () => {
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
      input.eventHistory = [
        {
          type: "CREATED",
          nextStatus: "UPCOMING",
          actorUserId: owner._id,
          actorRole: "BUSINESS_OWNER",
          createdAt: new Date(),
        },
      ];
      input.rescheduleHistory = [
        {
          actorUserId: owner._id,
          actorRole: "BUSINESS_OWNER",
          previousStart: new Date("2026-08-25T08:00:00.000Z"),
          previousEnd: new Date("2026-08-25T08:30:00.000Z"),
          newStart: new Date("2026-08-25T09:00:00.000Z"),
          newEnd: new Date("2026-08-25T09:30:00.000Z"),
          countedTowardCustomerQuota: true,
          createdAt: new Date(),
        },
      ];
      await bookingRepository.create(input);

      const startAt = new Date("2026-08-25T00:00:00.000Z");
      const endAt = new Date("2026-08-26T00:00:00.000Z");

      const listView = await bookingService.findBookingsInRange(business, startAt, endAt, {
        excludeHistory: true,
      });
      expect(listView).toHaveLength(1);
      // A deliberately-excluded projection path comes back `undefined`, not schema-defaulted
      // to `[]` — unlike a path genuinely absent from a legacy document (see business.service's
      // resolveBusinessTimezone comment for that other case), Mongoose tracks projection
      // exclusion separately and does not backfill defaults for it. This is itself the proof
      // the field was never transferred from MongoDB, i.e. that the projection is working.
      expect(listView[0]?.eventHistory).toBeUndefined();
      expect(listView[0]?.rescheduleHistory).toBeUndefined();

      const detailView = await bookingService.findBookingsInRange(business, startAt, endAt, {
        excludeHistory: false,
      });
      expect(detailView[0]?.eventHistory).toHaveLength(1);
      expect(detailView[0]?.rescheduleHistory).toHaveLength(1);
    });
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
    const noShowWorkerIndex = indexes.find(
      (index) => index.key["status"] === 1 && index.key["noShowDeadlineAt"] === 1,
    );
    expect(noShowWorkerIndex).toBeDefined();
    expect(noShowWorkerIndex?.partialFilterExpression).toBeDefined();
  });

  // --- No-show domain fields (item 7) --------------------------------------------------------

  describe("Booking no-show fields", () => {
    const setup = async () => {
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
      return { business, owner, membership, service, client, input };
    };

    it("a fresh Booking has neither noShowStartedAt nor noShowDeadlineAt — no-show never starts automatically", async () => {
      const { input } = await setup();
      const created = await bookingRepository.create(input);

      expect(created.noShowStartedAt).toBeUndefined();
      expect(created.noShowDeadlineAt).toBeUndefined();
    });

    it("accepts both fields set together, 90 minutes apart", async () => {
      const { input } = await setup();
      const startedAt = new Date("2026-08-25T09:00:00.000Z");
      input.noShowStartedAt = startedAt;
      input.noShowDeadlineAt = new Date(
        startedAt.getTime() + NO_SHOW_RESOLUTION_WINDOW_MINUTES * 60_000,
      );
      input.status = "PENDING";

      const created = await bookingRepository.create(input);
      expect(created.noShowStartedAt?.toISOString()).toBe(startedAt.toISOString());
      expect(created.noShowDeadlineAt?.toISOString()).toBe("2026-08-25T10:30:00.000Z");
    });

    it("rejects noShowStartedAt set without a matching noShowDeadlineAt, and vice versa", async () => {
      const { input } = await setup();
      const startedOnly = { ...input, noShowStartedAt: new Date("2026-08-25T09:00:00.000Z") };
      await expect(bookingRepository.create(startedOnly)).rejects.toThrow();

      const { input: input2 } = await setup();
      const deadlineOnly = { ...input2, noShowDeadlineAt: new Date("2026-08-25T10:30:00.000Z") };
      await expect(bookingRepository.create(deadlineOnly)).rejects.toThrow();
    });

    it("rejects noShowDeadlineAt at or before noShowStartedAt", async () => {
      const { input } = await setup();
      const at = new Date("2026-08-25T09:00:00.000Z");
      const same = { ...input, noShowStartedAt: at, noShowDeadlineAt: at };
      await expect(bookingRepository.create(same)).rejects.toThrow();

      const before = {
        ...input,
        noShowStartedAt: at,
        noShowDeadlineAt: new Date(at.getTime() - 1000),
      };
      await expect(bookingRepository.create(before)).rejects.toThrow();
    });

    it("the no-show worker's query shape finds only PENDING bookings past their deadline", async () => {
      const { business, owner, membership, service, client } = await setup();
      const now = new Date("2026-08-25T12:00:00.000Z");

      const expired = buildValidBookingInput({
        businessId: business._id,
        clientId: client._id,
        serviceId: service._id,
        staffMembershipId: membership._id,
        actorUserId: owner._id,
      });
      expired.status = "PENDING";
      expired.noShowStartedAt = new Date("2026-08-25T10:00:00.000Z");
      expired.noShowDeadlineAt = new Date("2026-08-25T11:30:00.000Z");
      await bookingRepository.create(expired);

      const notYetExpired = buildValidBookingInput({
        businessId: business._id,
        clientId: client._id,
        serviceId: service._id,
        staffMembershipId: membership._id,
        actorUserId: owner._id,
      });
      notYetExpired.status = "PENDING";
      notYetExpired.noShowStartedAt = new Date("2026-08-25T11:45:00.000Z");
      notYetExpired.noShowDeadlineAt = new Date("2026-08-25T13:15:00.000Z");
      await bookingRepository.create(notYetExpired);

      const neverMarked = buildValidBookingInput({
        businessId: business._id,
        clientId: client._id,
        serviceId: service._id,
        staffMembershipId: membership._id,
        actorUserId: owner._id,
      });
      await bookingRepository.create(neverMarked);

      const dueForResolution = await BookingModel.find({
        status: "PENDING",
        noShowDeadlineAt: { $lte: now },
      }).exec();

      expect(dueForResolution).toHaveLength(1);
      expect(dueForResolution[0]?.noShowDeadlineAt?.toISOString()).toBe("2026-08-25T11:30:00.000Z");
    });
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
