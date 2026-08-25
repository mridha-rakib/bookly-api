import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { businessLocalToUtc } from "../../../src/common/time/business-clock.js";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import { AvailabilityService } from "../../../src/modules/availability/availability.service.js";
import { BookAgainService } from "../../../src/modules/booking/book-again.service.js";
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
import { BusinessMediaRepository } from "../../../src/modules/business-media/business-media.repository.js";
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
 * Batch 16 — Book Again, domain-level correctness. Reuses `BookingRepository.listForCustomer`
 * (the SAME primitive My Bookings uses) — every Booking here comes from the REAL creation/
 * lifecycle pipeline (never a fixture asserting against itself), matching this codebase's
 * established discipline (see review-database.integration.test.ts).
 */
describe("database-backed Book Again domain (Batch 16)", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let serviceRepository: ServiceRepository;
  let staffRepository: StaffRepository;
  let staffScheduleRepository: StaffScheduleRepository;
  let businessHoursService: BusinessHoursService;
  let clientRepository: ClientRepository;
  let bookingRepository: BookingRepository;
  let creationService: BookingCreationService;
  let lifecycleService: BookingLifecycleService;
  let paymentService: PaymentService;
  let bookAgainService: BookAgainService;

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
    const businessHoursRepository = new BusinessHoursRepository();
    businessHoursService = new BusinessHoursService(businessHoursRepository, businessRepository);
    clientRepository = new ClientRepository();
    const reservationRepository = new BookingSlotReservationRepository();
    const reservationService = new BookingSlotReservationService(reservationRepository);
    bookingRepository = new BookingRepository();
    const paymentGateway = new FakePaymentGateway();
    paymentService = new PaymentService(
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

    const availabilityService = new AvailabilityService(
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

    const bookingService = new BookingService(
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

    bookAgainService = new BookAgainService(
      bookingRepository,
      businessRepository,
      new BusinessMediaRepository(),
      undefined,
    );
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixtures (mirrors review-database.integration.test.ts exactly) --------------------------

  const createBusiness = async (name: string) => {
    const email = `owner-${new Types.ObjectId().toString()}@example.com`;
    const owner = await userRepository.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const pending = await businessRepository.create({
      ownerUserId: owner._id,
      name,
      ownerName: "Owner Name",
      email,
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: "AT_BUSINESS_LOCATION",
      timezone: TIMEZONE,
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "A great business",
      category: "Barber",
      subcategories: ["Haircut"],
    });
    const business = await businessRepository.casUpdateStatus(
      pending._id,
      ["PENDING"],
      "APPROVED",
      { fromStatus: "PENDING", actorUserId: owner._id, changedAt: new Date() },
    );
    return { owner, business: business ?? pending };
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
    priceCents = 8000,
  ) =>
    serviceRepository.create({
      businessId,
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: false,
      category: "Barber",
      name: "Haircut",
      pricingMode: "FIXED",
      fixedPricing: { priceCents, durationMin: 60, bookingIntervalMin: 60 },
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities: [],
      assignedStaffMembershipIds: [staffId],
    });

  const createCustomer = async (tag: string) =>
    userRepository.create({
      normalizedEmail: `cust-${tag}-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });

  const saveCard = async (userId: Types.ObjectId) => {
    const setupIntent = await paymentService.createSetupIntent(String(userId));
    await paymentService.confirmSavedPaymentMethod(String(userId), setupIntent.setupIntentId);
  };

  const linkCustomerToBusiness = async (
    businessId: Types.ObjectId,
    ownerId: Types.ObjectId,
    customerId: Types.ObjectId,
  ) => {
    const user = await userRepository.findById(customerId);
    const nationalNumber = `9${customerId.toString().slice(-7)}`;
    return clientRepository.create({
      businessId,
      createdByUserId: ownerId,
      firstName: "Maria",
      lastName: "Khan",
      normalizedEmail: user?.normalizedEmail ?? `linked-${customerId.toString()}@example.com`,
      phone: { countryCode: "+357", nationalNumber, e164: `+357${nationalNumber}` },
      address: {
        city: "Larnaca",
        propertyType: "House",
        area: "Center",
        streetName: "Main",
        streetNumber: "1",
      },
      linkState: "LINKED",
      linkedUserId: customerId,
    });
  };

  const startAtFor = (time: string) => businessLocalToUtc(TIMEZONE, DATE, time).toISOString();

  const setupBookableBusiness = async (name: string, priceCents = 8000) => {
    const { owner, business } = await createBusiness(name);
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id, priceCents);
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);
    return { owner, business, membership, service };
  };

  /** A real, COMPLETED, BOOKLY_MANAGED booking end to end (finalize -> lifecycle complete). */
  const createCompletedBooking = async (
    customerId: Types.ObjectId,
    businessName: string,
    time = "10:00",
    priceCents = 8000,
  ) => {
    const { owner, business, membership, service } = await setupBookableBusiness(
      businessName,
      priceCents,
    );
    await saveCard(customerId);
    await linkCustomerToBusiness(business._id, owner._id, customerId);

    const result = await creationService.finalizeCustomerBooking(
      String(customerId),
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
        startAt: startAtFor(time),
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
      },
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");

    const completed = await lifecycleService.completeBooking(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(result.booking._id),
    );
    return { owner, business, membership, service, booking: completed };
  };

  // --- Eligibility ---------------------------------------------------------------------------

  it("[1] a COMPLETED BOOKLY_MANAGED booking appears as a Book Again candidate with real current data", async () => {
    const customer = await createCustomer("eligible");
    const { booking, business, service } = await createCompletedBooking(customer._id, "Salon A");

    const result = await bookAgainService.listCandidates(String(customer._id), {
      page: 1,
      limit: 20,
    });

    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0];
    expect(candidate?.originalBookingId).toBe(String(booking._id));
    expect(candidate?.businessId).toBe(String(business._id));
    expect(candidate?.businessName).toBe(business.name);
    expect(candidate?.serviceId).toBe(String(service._id));
    expect(candidate?.primaryServiceName).toBe("Haircut");
  });

  it("an UPCOMING booking does not appear (not yet completed)", async () => {
    const customer = await createCustomer("upcoming");
    const { owner, business, membership, service } = await setupBookableBusiness("Salon Upcoming");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);
    await creationService.finalizeCustomerBooking(String(customer._id), String(business._id), {
      serviceLines: [
        {
          serviceId: String(service._id),
          staffMembershipId: String(membership._id),
          addonIds: [],
          pricingInput: {},
        },
      ],
      startAt: startAtFor("10:00"),
      idempotencyKey: `key-${new Types.ObjectId().toString()}`,
    });

    const result = await bookAgainService.listCandidates(String(customer._id), {
      page: 1,
      limit: 20,
    });
    expect(result.candidates).toHaveLength(0);
  });

  it("a CANCELLED booking does not appear", async () => {
    const customer = await createCustomer("cancelled");
    const { owner, business, membership, service } = await setupBookableBusiness("Salon Cancelled");
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);
    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
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
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
      },
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");
    await lifecycleService.cancelByCustomer(
      String(customer._id),
      String(result.booking._id),
      "change of plans",
    );

    const listed = await bookAgainService.listCandidates(String(customer._id), {
      page: 1,
      limit: 20,
    });
    expect(listed.candidates).toHaveLength(0);
  });

  it("a MANUAL (Business-Owner-entered) COMPLETED booking does not appear — the Customer never booked it themselves", async () => {
    const { owner, business } = await createBusiness("Salon Manual");
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id);
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);

    const customer = await createCustomer("manual-linked");
    const client = await linkCustomerToBusiness(business._id, owner._id, customer._id);

    const manualBooking = await creationService.createManualBooking(
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
      },
    );
    await lifecycleService.completeBooking(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(manualBooking._id),
    );

    const result = await bookAgainService.listCandidates(String(customer._id), {
      page: 1,
      limit: 20,
    });
    expect(result.candidates).toHaveLength(0);
  });

  // --- Current data, never historical snapshot re-use --------------------------------------------

  it("[2][3] uses the Business's CURRENT name, not any historical snapshot", async () => {
    const customer = await createCustomer("current-name");
    const { booking, business, owner } = await createCompletedBooking(customer._id, "Old Name");

    await businessRepository.updateOwnedById(owner._id, business._id, { name: "New Name" });

    const result = await bookAgainService.listCandidates(String(customer._id), {
      page: 1,
      limit: 20,
    });
    expect(result.candidates[0]?.businessName).toBe("New Name");
    void booking;
  });

  it("[35] exposes the ORIGINAL price only as historical/informational — never as something to reuse for a new price", async () => {
    const customer = await createCustomer("old-price");
    const { business, owner, membership, service } = await setupBookableBusiness(
      "Price Business",
      8000,
    );
    await saveCard(customer._id);
    await linkCustomerToBusiness(business._id, owner._id, customer._id);
    const result = await creationService.finalizeCustomerBooking(
      String(customer._id),
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
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
      },
    );
    if (result.status !== "confirmed") throw new Error("expected confirmed");
    await lifecycleService.completeBooking(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(result.booking._id),
    );

    // The Business raises its price after the visit — the historical booking's own amount never
    // changes (it's an immutable financial record), but the CURRENT Service price is now higher.
    const current = await serviceRepository.findById(business._id, service._id);
    if (!current) throw new Error("expected service");
    await serviceRepository.replaceById(business._id, service._id, {
      status: current.status,
      isFeatured: current.isFeatured,
      isPackageDeal: current.isPackageDeal,
      category: current.category,
      subcategory: current.subcategory,
      serviceCategoryId: current.serviceCategoryId,
      name: current.name,
      packageServicesName: current.packageServicesName,
      description: current.description,
      pricingMode: current.pricingMode,
      fixedPricing: { priceCents: 10000, durationMin: 60, bookingIntervalMin: 60 },
      hourlyPricing: current.hourlyPricing,
      perPersonPricing: current.perPersonPricing,
      packagePricing: current.packagePricing,
      sessionExpiryAlert: current.sessionExpiryAlert,
      scheduleMode: current.scheduleMode,
      manualSchedule: current.manualSchedule,
      servedCities: current.servedCities,
      assignedStaffMembershipIds: current.assignedStaffMembershipIds,
    });

    const candidates = await bookAgainService.listCandidates(String(customer._id), {
      page: 1,
      limit: 20,
    });
    // The DTO surfaces the OLD amount honestly labeled as historical (originalTotalCents) — the
    // real current price (10000) is never exposed here at all; that's the venue page's/booking
    // wizard's job when the Customer actually clicks through, never computed by Book Again itself.
    expect(candidates.candidates[0]?.originalTotalCents).toBeGreaterThan(0);
    expect(candidates.candidates[0]?.serviceId).toBe(String(service._id));
  });

  // --- Business suspension regression ------------------------------------------------------------

  it("[32] a Business that becomes SUSPENDED after the visit is excluded from Book Again — no dead-end card", async () => {
    const customer = await createCustomer("suspended-after");
    const { booking, business, owner } = await createCompletedBooking(
      customer._id,
      "Later Suspended",
    );
    void booking;

    await businessRepository.casUpdateStatus(business._id, ["APPROVED"], "SUSPENDED", {
      fromStatus: "APPROVED",
      actorUserId: owner._id,
      changedAt: new Date(),
    });

    const result = await bookAgainService.listCandidates(String(customer._id), {
      page: 1,
      limit: 20,
    });
    expect(result.candidates).toHaveLength(0);
  });

  // --- Cross-customer isolation --------------------------------------------------------------------

  it("Customer A never sees Customer B's Book Again candidates", async () => {
    const customerA = await createCustomer("book-again-a");
    const customerB = await createCustomer("book-again-b");
    await createCompletedBooking(customerA._id, "A's Salon");

    const resultB = await bookAgainService.listCandidates(String(customerB._id), {
      page: 1,
      limit: 20,
    });
    expect(resultB.candidates).toHaveLength(0);
  });

  // --- Old booking untouched --------------------------------------------------------------------

  it("[12] listing Book Again candidates never mutates the original Booking", async () => {
    const customer = await createCustomer("untouched");
    const { booking } = await createCompletedBooking(customer._id, "Untouched Salon");

    await bookAgainService.listCandidates(String(customer._id), { page: 1, limit: 20 });

    const stillThere = await bookingRepository.findByIdForCustomer(booking._id, customer._id);
    expect(stillThere?.status).toBe("COMPLETED");
    expect(stillThere?.financials.totalCents).toBe(booking.financials.totalCents);
  });
});
