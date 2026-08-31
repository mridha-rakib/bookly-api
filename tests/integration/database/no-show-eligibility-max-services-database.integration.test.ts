import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { businessLocalToUtc } from "../../../src/common/time/business-clock.js";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import { AvailabilityService } from "../../../src/modules/availability/availability.service.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { BookingService } from "../../../src/modules/booking/booking.service.js";
import { NO_SHOW_RESOLUTION_WINDOW_MINUTES } from "../../../src/modules/booking/booking.types.js";
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
import { PlatformSettingsRepository } from "../../../src/modules/platform-settings/platform-settings.repository.js";
import { PlatformSettingsService } from "../../../src/modules/platform-settings/platform-settings.service.js";
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
const DATE = "2030-08-20"; // a Tuesday

/**
 * Batch 21 — category no-show eligibility window + booking-time snapshot + configurable
 * max-services-per-booking, exercised through the real BookingCreationService /
 * BookingLifecycleService with a real PlatformSettingsService wired in.
 */
describe("database-backed no-show eligibility window + max services (Batch 21)", () => {
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
  let cancellationPolicyRepository: BusinessCancellationPolicyRepository;
  let paymentService: PaymentService;
  let platformSettingsService: PlatformSettingsService;
  // Each confirmed booking must occupy a distinct slot (the reservation engine rejects a
  // second booking of the same staff/time). Hand out 09:00, 10:00, 11:00, ... in order.
  let nextHour = 9;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    nextHour = 9;
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
    cancellationPolicyRepository = new BusinessCancellationPolicyRepository();
    bookingRepository = new BookingRepository();
    paymentService = new PaymentService(
      new FakePaymentGateway(),
      new CustomerPaymentProfileRepository(),
      userRepository,
    );
    const financialTransactionService = new BookingFinancialTransactionService(
      new BookingFinancialTransactionRepository(),
    );
    platformSettingsService = new PlatformSettingsService(new PlatformSettingsRepository());

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
      cancellationPolicyRepository,
      bookingRepository,
      new BookingCreationClaimRepository(),
      userRepository,
      clientRepository,
      paymentService,
      financialTransactionService,
      new PromoApplicationService(
        new PromoRepository(),
        new PromoUserUsageRepository(),
        new PromoRedemptionRepository(),
      ),
      undefined,
      platformSettingsService,
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

  // --- Fixtures ----------------------------------------------------------------------------

  const setupBusiness = async (category: string) => {
    const owner = await userRepository.create({
      normalizedEmail: `owner-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const business = await businessRepository.create({
      ownerUserId: owner._id,
      name: "Studio",
      ownerName: "Owner Name",
      email: `biz-${new Types.ObjectId().toString()}@example.com`,
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: "AT_BUSINESS_LOCATION",
      timezone: TIMEZONE,
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "A great business",
      category,
      subcategories: ["Thing"],
    });

    const staffUser = await userRepository.create({
      normalizedEmail: `staff-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "STAFF",
      status: "ACTIVE",
    });
    const membership = await staffRepository.create({
      userId: staffUser._id,
      businessId: business._id,
      role: "STAFF",
      createdByUserId: staffUser._id,
    });

    const service = await serviceRepository.create({
      businessId: business._id,
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: false,
      category,
      name: "Session",
      pricingMode: "FIXED",
      fixedPricing: { priceCents: 10_000, durationMin: 60, bookingIntervalMin: 60 },
      sessionExpiryAlert: { enabled: false },
      scheduleMode: "AUTO",
      manualSchedule: [],
      servedCities: [],
      assignedStaffMembershipIds: [membership._id],
    });

    const days = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] as const;
    await businessHoursService.putOpeningHours(String(owner._id), String(business._id), [
      ...days.map((dayOfWeek) => ({
        dayOfWeek,
        isOpen: true,
        slots: [{ startTime: "09:00", endTime: "18:00" }],
      })),
      { dayOfWeek: "SATURDAY", isOpen: false, slots: [] },
      { dayOfWeek: "SUNDAY", isOpen: false, slots: [] },
    ]);
    await staffScheduleRepository.replace(
      membership._id,
      business._id,
      days.map((dayOfWeek) => ({ dayOfWeek, startTime: "09:00", endTime: "18:00" })),
    );

    return { owner, business, membership, service };
  };

  const createLinkedCustomerWithCard = async (
    businessId: Types.ObjectId,
    ownerId: Types.ObjectId,
  ) => {
    const customer = await userRepository.create({
      normalizedEmail: `cust-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    await clientRepository.create({
      businessId,
      createdByUserId: ownerId,
      firstName: "Test",
      lastName: "Customer",
      normalizedEmail: customer.normalizedEmail,
      phone: { countryCode: "+357", nationalNumber: "99000000", e164: "+35799000000" },
      address: {
        city: "Larnaca",
        propertyType: "House",
        area: "Center",
        streetName: "Main",
        streetNumber: "1",
      },
      linkState: "LINKED",
      linkedUserId: customer._id,
    });
    const setupIntent = await paymentService.createSetupIntent(String(customer._id));
    await paymentService.confirmSavedPaymentMethod(String(customer._id), setupIntent.setupIntentId);
    return customer;
  };

  const bookingInput = (
    serviceId: Types.ObjectId,
    staffId: Types.ObjectId,
    lines = 1,
    time = "10:00",
  ) => ({
    serviceLines: Array.from({ length: lines }, () => ({
      serviceId: String(serviceId),
      staffMembershipId: String(staffId),
      addonIds: [],
      pricingInput: {},
    })),
    startAt: businessLocalToUtc(TIMEZONE, DATE, time).toISOString(),
    idempotencyKey: `key-${new Types.ObjectId().toString()}`,
  });

  const confirmBooking = async (
    customerId: Types.ObjectId,
    businessId: Types.ObjectId,
    serviceId: Types.ObjectId,
    staffId: Types.ObjectId,
  ) => {
    const time = `${String(nextHour).padStart(2, "0")}:00`;
    nextHour += 1;
    const result = await creationService.finalizeCustomerBooking(
      String(customerId),
      String(businessId),
      bookingInput(serviceId, staffId, 1, time),
    );
    if (result.status !== "confirmed") {
      throw new Error(`expected confirmed, got ${result.status}`);
    }
    return result.booking;
  };

  /** Force a booking's scheduled start to a chosen offset from real `now`. */
  const setStartAtRelativeToNow = async (bookingId: Types.ObjectId, minutesFromNow: number) => {
    const startAt = new Date(Date.now() + minutesFromNow * 60_000);
    await BookingModel.updateOne(
      { _id: bookingId },
      {
        $set: {
          "schedule.startAt": startAt,
          "schedule.endAt": new Date(startAt.getTime() + 3_600_000),
        },
      },
    );
  };

  // --- Category identity + snapshot -------------------------------------------------------

  it("a business created with a legacy-style category string resolves the canonical key, and its bookings snapshot the window", async () => {
    const { owner, business, membership, service } = await setupBusiness("HEALTH & FITNESS");
    const stored = await businessRepository.findById(business._id);
    expect(stored?.categoryKey).toBe("HEALTH_FITNESS");

    const customer = await createLinkedCustomerWithCard(business._id, owner._id);
    const booking = await confirmBooking(customer._id, business._id, service._id, membership._id);

    expect(booking.noShowEligibilitySnapshot).toMatchObject({
      categoryKey: "HEALTH_FITNESS",
      opensAfterMinutes: 15,
      closesAfterMinutes: 120,
    });
  });

  it("an unresolvable category string leaves categoryKey unset and writes no eligibility snapshot (legacy fallback)", async () => {
    const { owner, business, membership, service } = await setupBusiness("Barber");
    const stored = await businessRepository.findById(business._id);
    expect(stored?.categoryKey).toBeUndefined();

    const customer = await createLinkedCustomerWithCard(business._id, owner._id);
    const booking = await confirmBooking(customer._id, business._id, service._id, membership._id);
    expect(booking.noShowEligibilitySnapshot).toBeUndefined();

    // Legacy behavior preserved: markNoShow works with only the status gate, even "before" any window.
    await setStartAtRelativeToNow(booking._id, 5);
    const marked = await lifecycleService.markNoShow(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(booking._id),
    );
    expect(marked.status).toBe("PENDING");
  });

  it("a later Super Admin window edit does not retroactively change an existing booking's snapshot", async () => {
    const { owner, business, membership, service } = await setupBusiness("Health & Fitness");
    const customer = await createLinkedCustomerWithCard(business._id, owner._id);
    const booking = await confirmBooking(customer._id, business._id, service._id, membership._id);
    expect(booking.noShowEligibilitySnapshot?.closesAfterMinutes).toBe(120);

    const base = await platformSettingsService.getSettings();
    await platformSettingsService.updateSettings({
      noShowCategoryWindows: base.editable.noShowCategoryWindows.map((w) =>
        w.categoryKey === "HEALTH_FITNESS"
          ? { ...w, opensAfterMinutes: 30, closesAfterMinutes: 240 }
          : w,
      ),
    });

    const reloaded = await bookingRepository.findByIdOnly(booking._id);
    expect(reloaded?.noShowEligibilitySnapshot).toMatchObject({
      opensAfterMinutes: 15,
      closesAfterMinutes: 120,
    });

    // A brand-new booking picks up the new window.
    const booking2 = await confirmBooking(customer._id, business._id, service._id, membership._id);
    expect(booking2.noShowEligibilitySnapshot).toMatchObject({
      opensAfterMinutes: 30,
      closesAfterMinutes: 240,
    });
  });

  // --- Eligibility window enforcement --------------------------------------------------------

  it("markNoShow enforces open<=now<close: before-open rejected, boundary + inside accepted, at/after-close rejected", async () => {
    const { owner, business, membership, service } = await setupBusiness("Health & Fitness");
    const customer = await createLinkedCustomerWithCard(business._id, owner._id);
    const mark = (bookingId: Types.ObjectId) =>
      lifecycleService.markNoShow(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(bookingId),
      );

    // window = opens 15, closes 120 (minutes after start)

    // before open: start is 5 minutes ago -> now is only +5 < +15
    const b1 = await confirmBooking(customer._id, business._id, service._id, membership._id);
    await setStartAtRelativeToNow(b1._id, -5);
    await expect(mark(b1._id)).rejects.toMatchObject({
      statusCode: 409,
      details: [{ code: "BOOKING_NO_SHOW_WINDOW_NOT_OPEN" }],
    });

    // exactly at the open boundary (inclusive): start is 15 minutes ago
    const b2 = await confirmBooking(customer._id, business._id, service._id, membership._id);
    await setStartAtRelativeToNow(b2._id, -15);
    expect((await mark(b2._id)).status).toBe("PENDING");

    // comfortably inside: start is 60 minutes ago
    const b3 = await confirmBooking(customer._id, business._id, service._id, membership._id);
    await setStartAtRelativeToNow(b3._id, -60);
    expect((await mark(b3._id)).status).toBe("PENDING");

    // exactly at the close boundary (exclusive): start is 120 minutes ago -> rejected
    const b4 = await confirmBooking(customer._id, business._id, service._id, membership._id);
    await setStartAtRelativeToNow(b4._id, -120);
    await expect(mark(b4._id)).rejects.toMatchObject({
      statusCode: 409,
      details: [{ code: "BOOKING_NO_SHOW_WINDOW_CLOSED" }],
    });

    // well after close: start is 5 hours ago
    const b5 = await confirmBooking(customer._id, business._id, service._id, membership._id);
    await setStartAtRelativeToNow(b5._id, -300);
    await expect(mark(b5._id)).rejects.toMatchObject({
      statusCode: 409,
      details: [{ code: "BOOKING_NO_SHOW_WINDOW_CLOSED" }],
    });
  });

  it("the 90-minute resolution timer starts at the mark instant, not at appointment start", async () => {
    const { owner, business, membership, service } = await setupBusiness("Health & Fitness");
    const customer = await createLinkedCustomerWithCard(business._id, owner._id);
    const booking = await confirmBooking(customer._id, business._id, service._id, membership._id);
    await setStartAtRelativeToNow(booking._id, -60); // inside the window

    const before = Date.now();
    const marked = await lifecycleService.markNoShow(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(booking._id),
      "Customer did not attend",
    );
    const after = Date.now();

    const started = marked.noShowStartedAt as Date;
    const deadline = marked.noShowDeadlineAt as Date;
    expect(started.getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(started.getTime()).toBeLessThanOrEqual(after + 5);
    expect(deadline.getTime() - started.getTime()).toBe(NO_SHOW_RESOLUTION_WINDOW_MINUTES * 60_000);
    // Definitely NOT anchored to appointment start (which is ~60 min in the past).
    expect(started.getTime()).toBeGreaterThan(marked.schedule.startAt.getTime());

    // Reason persisted as internal-only audit metadata.
    const markEvent = marked.eventHistory.at(-1);
    expect(markEvent?.reason).toBe("Customer did not attend");
  });

  // --- Max services per booking -----------------------------------------------------------

  it("enforces the platform max-services limit end to end (default 5, admin raises to 7)", async () => {
    const { owner, business, membership, service } = await setupBusiness("Health & Fitness");
    const customer = await createLinkedCustomerWithCard(business._id, owner._id);

    const preview = (lines: number) =>
      creationService.previewCustomerBooking(
        String(customer._id),
        String(business._id),
        bookingInput(service._id, membership._id, lines),
      );

    // default limit = 5
    await expect(preview(5)).resolves.toBeDefined();
    await expect(preview(6)).rejects.toMatchObject({
      statusCode: 400,
      details: [{ code: "BOOKING_TOO_MANY_SERVICE_LINES" }],
    });

    // admin raises to 7
    await platformSettingsService.updateSettings({ maxServicesPerBooking: 7 });
    await expect(preview(7)).resolves.toBeDefined();
    await expect(preview(8)).rejects.toMatchObject({
      statusCode: 400,
      details: [{ code: "BOOKING_TOO_MANY_SERVICE_LINES" }],
    });
  });

  // --- Complete booking: FULL / PARTIAL / NOT_PAID --------------------------------------------

  it("records FULL / PARTIAL / NOT_PAID venue settlement without ever charging the saved card", async () => {
    const { owner, business, membership, service } = await setupBusiness("Health & Fitness");
    const customer = await createLinkedCustomerWithCard(business._id, owner._id);

    const complete = (
      bookingId: Types.ObjectId,
      venuePayment?: Parameters<typeof lifecycleService.completeBooking>[4],
    ) =>
      lifecycleService.completeBooking(
        String(owner._id),
        "BUSINESS_OWNER",
        String(business._id),
        String(bookingId),
        venuePayment,
      );

    // €100 service, €20 deposit -> €80 balance due.
    const full = await confirmBooking(customer._id, business._id, service._id, membership._id);
    expect(full.financials.balanceDueCents).toBe(8000);
    const fullDone = await complete(full._id, { settlement: "FULL" });
    expect(fullDone.completionPayment).toMatchObject({ paid: true, amountCents: 8000 });

    const partial = await confirmBooking(customer._id, business._id, service._id, membership._id);
    const partialDone = await complete(partial._id, { settlement: "PARTIAL", amountCents: 3000 });
    expect(partialDone.completionPayment).toMatchObject({ paid: true, amountCents: 3000 });

    const unpaid = await confirmBooking(customer._id, business._id, service._id, membership._id);
    const unpaidDone = await complete(unpaid._id, { settlement: "NOT_PAID" });
    expect(unpaidDone.completionPayment?.paid).toBe(false);
    expect(unpaidDone.completionPayment?.amountCents).toBeUndefined();

    // rejects: PARTIAL equal to the balance, above the balance, and zero/negative
    const bad = await confirmBooking(customer._id, business._id, service._id, membership._id);
    for (const amount of [8000, 9000, 0, -1]) {
      await expect(
        complete(bad._id, { settlement: "PARTIAL", amountCents: amount }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    // still completable afterwards with a valid answer
    expect((await complete(bad._id, { settlement: "NOT_PAID" })).status).toBe("COMPLETED");
  });
});
