import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { businessLocalToUtc } from "../../../src/common/time/business-clock.js";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import { AvailabilityService } from "../../../src/modules/availability/availability.service.js";
import {
  toBookingDetailDto,
  toBookingListItemDto,
} from "../../../src/modules/booking/booking.dto.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { BookingService } from "../../../src/modules/booking/booking.service.js";
import { BookingCreationService } from "../../../src/modules/booking/booking-creation.service.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import { BookingLifecycleService } from "../../../src/modules/booking/booking-lifecycle.service.js";
import { BookingFinancialTransactionRepository } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { BookingSlotReservationRepository } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.repository.js";
import { BookingSlotReservationService } from "../../../src/modules/booking-slot-reservation/booking-slot-reservation.service.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessBookingSettingsRepository } from "../../../src/modules/business-booking-settings/business-booking-settings.repository.js";
import { BusinessCancellationPolicyRepository } from "../../../src/modules/business-cancellation-policy/business-cancellation-policy.repository.js";
import { BusinessHoursRepository } from "../../../src/modules/business-hours/business-hours.repository.js";
import { BusinessHoursService } from "../../../src/modules/business-hours/business-hours.service.js";
import { BusinessTravelSettingsRepository } from "../../../src/modules/business-travel-settings/business-travel-settings.repository.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { PromoRepository } from "../../../src/modules/promo/promo.repository.js";
import { PromoApplicationService } from "../../../src/modules/promo/promo-application.service.js";
import { PromoRedemptionRepository } from "../../../src/modules/promo/promo-redemption.repository.js";
import { PromoUserUsageRepository } from "../../../src/modules/promo/promo-user-usage.repository.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { StaffTimeOffRepository } from "../../../src/modules/staff/staff-time-off.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { FakePaymentGateway } from "../../helpers/fake-payment-gateway.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const TIMEZONE = "Europe/Nicosia";
const DATE = "2030-08-20"; // a Tuesday, safely in the future relative to any real "now"

/**
 * Batch — proves the booking historical-location-snapshot hardening: a future booking freezes
 * `business.location` at creation time (when valid), an old/no-coordinate booking stays valid
 * and honest, and NOTHING ever re-reads the Business's current location for an already-created
 * Booking (confirmed rule L; see BookingLocationSnapshot's own doc comment).
 */
describe("database-backed Booking fulfilment location snapshot", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let serviceRepository: ServiceRepository;
  let staffRepository: StaffRepository;
  let staffScheduleRepository: StaffScheduleRepository;
  let businessHoursRepository: BusinessHoursRepository;
  let businessHoursService: BusinessHoursService;
  let clientRepository: ClientRepository;
  let reservationRepository: BookingSlotReservationRepository;
  let reservationService: BookingSlotReservationService;
  let availabilityService: AvailabilityService;
  let bookingService: BookingService;
  let bookingRepository: BookingRepository;
  let creationService: BookingCreationService;
  let lifecycleService: BookingLifecycleService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    serviceRepository = new ServiceRepository();
    staffRepository = new StaffRepository();
    staffScheduleRepository = new StaffScheduleRepository();
    businessHoursRepository = new BusinessHoursRepository();
    businessHoursService = new BusinessHoursService(businessHoursRepository, businessRepository);
    clientRepository = new ClientRepository();
    reservationRepository = new BookingSlotReservationRepository();
    reservationService = new BookingSlotReservationService(reservationRepository);
    bookingRepository = new BookingRepository();
    const paymentGateway = new FakePaymentGateway();
    const paymentService = new PaymentService(
      paymentGateway,
      new CustomerPaymentProfileRepository(),
      userRepository,
    );
    const financialTransactionService = new BookingFinancialTransactionService(
      new BookingFinancialTransactionRepository(),
    );
    const promoApplicationService = new PromoApplicationService(
      new PromoRepository(),
      new PromoUserUsageRepository(),
      new PromoRedemptionRepository(),
    );

    availabilityService = new AvailabilityService(
      businessRepository,
      serviceRepository,
      staffRepository,
      staffScheduleRepository,
      new StaffTimeOffRepository(),
      businessHoursRepository,
      new BusinessBookingSettingsRepository(),
      new BusinessTravelSettingsRepository(),
      reservationRepository,
    );

    bookingService = new BookingService(
      businessRepository,
      staffRepository,
      serviceRepository,
      new AddonRepository(),
      new AddonServiceAssignmentRepository(),
      clientRepository,
      bookingRepository,
    );

    creationService = new BookingCreationService(
      businessRepository,
      bookingService,
      availabilityService,
      reservationService,
      new BusinessTravelSettingsRepository(),
      new BusinessCancellationPolicyRepository(),
      bookingRepository,
      new BookingCreationClaimRepository(),
      userRepository,
      clientRepository,
      paymentService,
      financialTransactionService,
      promoApplicationService,
    );

    lifecycleService = new BookingLifecycleService(
      bookingService,
      bookingRepository,
      businessRepository,
      reservationService,
      availabilityService,
      serviceRepository,
      staffRepository,
      paymentService,
      financialTransactionService,
    );
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixtures ------------------------------------------------------------------------------

  const createBusiness = async (
    options: {
      visitType?: "AT_BUSINESS_LOCATION" | "TRAVEL_TO_CUSTOMER";
      location?: { lat: number; lng: number };
    } = {},
  ) => {
    const owner = await userRepository.create({
      normalizedEmail: `owner-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const business = await businessRepository.create({
      ownerUserId: owner._id,
      name: "Salon A",
      ownerName: "Owner Name",
      email: owner.normalizedEmail,
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: options.visitType ?? "AT_BUSINESS_LOCATION",
      timezone: TIMEZONE,
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      ...(options.location ? { location: options.location } : {}),
      briefDescription: "A great business",
      category: "Barber",
      subcategories: ["Haircut"],
    });
    return { owner, business };
  };

  const createStaff = async (businessId: Types.ObjectId) => {
    const user = await userRepository.create({
      normalizedEmail: `staff-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "STAFF",
      status: "ACTIVE",
    });
    const membership = await staffRepository.create({
      userId: user._id,
      businessId,
      role: "STAFF",
      createdByUserId: user._id,
    });
    return { user, membership };
  };

  const openMondayToFriday = async (businessId: Types.ObjectId, ownerId: Types.ObjectId) => {
    const days = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] as const;
    await businessHoursService.putOpeningHours(String(ownerId), String(businessId), [
      ...days.map((dayOfWeek) => ({
        dayOfWeek,
        isOpen: true,
        slots: [{ startTime: "09:00", endTime: "18:00" }],
      })),
      { dayOfWeek: "SATURDAY", isOpen: false, slots: [] },
      { dayOfWeek: "SUNDAY", isOpen: false, slots: [] },
    ]);
  };

  const staffWorksMondayToFriday = async (
    membershipId: Types.ObjectId,
    businessId: Types.ObjectId,
  ) => {
    const days = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] as const;
    await staffScheduleRepository.replace(
      membershipId,
      businessId,
      days.map((dayOfWeek) => ({ dayOfWeek, startTime: "09:00", endTime: "18:00" })),
    );
  };

  const createFixedService = async (
    businessId: Types.ObjectId,
    staffId: Types.ObjectId,
    servedCities: string[] = [],
  ) =>
    serviceRepository.create({
      businessId,
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: false,
      category: "Barber",
      name: "Haircut",
      pricingMode: "FIXED",
      fixedPricing: { priceCents: 2000, durationMin: 60, bookingIntervalMin: 60 },
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities,
      assignedStaffMembershipIds: [staffId],
    });

  const createClientFor = async (businessId: Types.ObjectId, ownerId: Types.ObjectId) =>
    clientRepository.create({
      businessId,
      createdByUserId: ownerId,
      firstName: "Jane",
      lastName: "Doe",
      normalizedEmail: `client-${new Types.ObjectId().toString()}@example.com`,
      phone: { countryCode: "+357", nationalNumber: "99122334", e164: "+35799122334" },
      address: {
        city: "Larnaca",
        propertyType: "House",
        area: "Center",
        streetName: "Main",
        streetNumber: "1",
      },
      linkState: "UNLINKED",
    });

  const startAtFor = (time: string) => businessLocalToUtc(TIMEZONE, DATE, time).toISOString();

  const setupBookableBusiness = async (location?: { lat: number; lng: number }) => {
    const { owner, business } = await createBusiness({ location });
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id);
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);
    const client = await createClientFor(business._id, owner._id);
    return { owner, business, membership, service, client };
  };

  const bookAt = async (
    owner: { _id: Types.ObjectId },
    business: { _id: Types.ObjectId },
    membership: { _id: Types.ObjectId },
    service: { _id: Types.ObjectId },
    client: { _id: Types.ObjectId },
    time = "10:00",
  ) =>
    creationService.createManualBooking(String(owner._id), "BUSINESS_OWNER", String(business._id), {
      serviceLines: [
        {
          serviceId: String(service._id),
          staffMembershipId: String(membership._id),
          addonIds: [],
          pricingInput: {},
        },
      ],
      startAt: startAtFor(time),
      businessClientId: String(client._id),
      idempotencyKey: `key-${new Types.ObjectId().toString()}`,
    });

  // --- 1: valid Business.location is snapshotted -------------------------------------------

  it("snapshots business.location lat/lng at creation time when valid", async () => {
    const location = { lat: 34.9223, lng: 33.6233 };
    const { owner, business, membership, service, client } = await setupBookableBusiness(location);

    const booking = await bookAt(owner, business, membership, service, client);

    expect(booking.fulfilment.mode).toBe("AT_BUSINESS_LOCATION");
    expect(booking.fulfilment.businessLocation?.location).toMatchObject(location);
    // Address is still snapshotted alongside the coordinate — never replaced by it.
    expect(booking.fulfilment.businessLocation?.city).toBe("Larnaca");
  });

  // --- 2: no Business.location -> address only, no fabricated location ---------------------

  it("omits location (address only) when the Business has no location at all", async () => {
    const { owner, business, membership, service, client } = await setupBookableBusiness(undefined);

    const booking = await bookAt(owner, business, membership, service, client);

    expect(booking.fulfilment.businessLocation?.location).toBeUndefined();
    expect(booking.fulfilment.businessLocation?.streetName).toBe("Main");
  });

  // --- 3: invalid Business.location is never fabricated/coerced into the snapshot ----------

  it("omits location when the Business's stored coordinate is out of valid range", async () => {
    // Deliberately invalid latitude — proves resolveValidCoordinate rejects it rather than
    // passing it through as-is.
    const { owner, business, membership, service, client } = await setupBookableBusiness({
      lat: 999,
      lng: 33.6233,
    });

    const booking = await bookAt(owner, business, membership, service, client);

    expect(booking.fulfilment.businessLocation?.location).toBeUndefined();
  });

  // --- 4: a later Business.location change never reaches an already-created Booking -------

  it("keeps the original snapshot after Business.location changes (A -> B never becomes visible on the old booking)", async () => {
    const locationA = { lat: 34.9223, lng: 33.6233 }; // Larnaca
    const { owner, business, membership, service, client } = await setupBookableBusiness(locationA);

    const booking = await bookAt(owner, business, membership, service, client);
    expect(booking.fulfilment.businessLocation?.location).toMatchObject(locationA);

    // Business moves to Location B.
    const locationB = { lat: 34.6786, lng: 33.0413 }; // Limassol
    await businessRepository.updateOwnedById(owner._id, business._id, {
      "location.lat": locationB.lat,
      "location.lng": locationB.lng,
    });

    const reread = await bookingRepository.findById(business._id, booking._id);
    expect(reread?.fulfilment.businessLocation?.location).toMatchObject(locationA);
    expect(reread?.fulfilment.businessLocation?.location).not.toMatchObject(locationB);
  });

  // --- 5: reschedule preserves the original fulfilment snapshot, even across a business move --

  it("preserves the original fulfilment location snapshot through a reschedule, even if the Business moved in between", async () => {
    const locationA = { lat: 34.9223, lng: 33.6233 };
    const { owner, business, membership, service, client } = await setupBookableBusiness(locationA);

    const booking = await bookAt(owner, business, membership, service, client);

    const locationB = { lat: 34.6786, lng: 33.0413 };
    await businessRepository.updateOwnedById(owner._id, business._id, {
      "location.lat": locationB.lat,
      "location.lng": locationB.lng,
    });

    const rescheduled = await lifecycleService.rescheduleByOwner(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(booking._id),
      startAtFor("14:00"),
    );

    expect(rescheduled.schedule.startAt.toISOString()).not.toBe(
      booking.schedule.startAt.toISOString(),
    );
    expect(rescheduled.fulfilment.businessLocation?.location).toMatchObject(locationA);
  });

  // --- 6: travel bookings never get a fabricated/geocoded location -------------------------

  it("never snapshots a location for a travel-to-customer booking (no real coordinate source exists today)", async () => {
    const { owner, business } = await createBusiness({ visitType: "TRAVEL_TO_CUSTOMER" });
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id, ["Larnaca"]);
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);
    const client = await createClientFor(business._id, owner._id);
    await new BusinessTravelSettingsRepository().upsertByBusinessId(business._id, [
      { city: "Larnaca", active: true, feeCents: 0 },
    ]);

    const booking = await creationService.createManualBooking(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      {
        serviceLines: [
          {
            serviceId: String(service._id),
            staffMembershipId: String(membership._id),
            addonIds: [],
            pricingInput: {},
          },
        ],
        startAt: startAtFor("10:00"),
        businessClientId: String(client._id),
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
        customerCity: "Larnaca",
        travelAddress: {
          city: "Larnaca",
          propertyType: "House",
          area: "Center",
          streetName: "Customer Street",
          streetNumber: "9",
        },
      },
    );

    expect(booking.fulfilment.mode).toBe("TRAVEL_TO_CUSTOMER");
    expect(booking.fulfilment.travelAddress?.streetName).toBe("Customer Street");
    expect(booking.fulfilment.travelAddress?.location).toBeUndefined();
  });

  // --- 7: DTOs surface the historical snapshot, never current Business data ----------------

  it("booking detail DTO passes through the historical fulfilment location verbatim", async () => {
    const location = { lat: 34.9223, lng: 33.6233 };
    const { owner, business, membership, service, client } = await setupBookableBusiness(location);
    const booking = await bookAt(owner, business, membership, service, client);

    const dto = toBookingDetailDto(booking);

    expect(dto.fulfilment.businessLocation?.location).toMatchObject(location);
  });

  it("booking list DTO exposes a compact fulfilmentLocation (address + optional location + mode)", async () => {
    const location = { lat: 34.9223, lng: 33.6233 };
    const { owner, business, membership, service, client } = await setupBookableBusiness(location);
    const booking = await bookAt(owner, business, membership, service, client);

    const dto = toBookingListItemDto(booking);

    expect(dto.fulfilmentLocation?.mode).toBe("AT_BUSINESS_LOCATION");
    expect(dto.fulfilmentLocation?.address.city).toBe("Larnaca");
    expect(dto.fulfilmentLocation?.address.streetName).toBe("Main");
    expect(dto.fulfilmentLocation?.location).toEqual(location);
  });

  // --- 8: a pre-migration-shaped Booking (no location field at all) stays valid ------------

  it("stays valid and honest for a Booking with no location field at all (backward compatibility)", async () => {
    const location = { lat: 34.9223, lng: 33.6233 };
    const { owner, business, membership, service, client } = await setupBookableBusiness(location);
    const booking = await bookAt(owner, business, membership, service, client);

    // Simulate a pre-migration document: strip `location` directly at the DB level, exactly as
    // an old Booking created before this field existed would look.
    const original = await bookingRepository.findById(business._id, booking._id);
    if (!original) throw new Error("booking missing");
    if (original.fulfilment.businessLocation) {
      original.fulfilment.businessLocation.location = undefined;
    }
    await original.save();

    const reread = await bookingRepository.findById(business._id, booking._id);
    if (!reread) throw new Error("booking missing after re-fetch");
    expect(reread.fulfilment.businessLocation?.location).toBeUndefined();
    expect(reread.fulfilment.businessLocation?.city).toBe("Larnaca");

    const detailDto = toBookingDetailDto(reread);
    expect(detailDto.fulfilment.businessLocation?.location).toBeUndefined();
    const listDto = toBookingListItemDto(reread);
    expect(listDto.fulfilmentLocation?.location).toBeUndefined();
    expect(listDto.fulfilmentLocation?.address.city).toBe("Larnaca");
  });
});
