import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { businessLocalToUtc } from "../../../src/common/time/business-clock.js";
import { AddonRepository } from "../../../src/modules/addons/addon.repository.js";
import { AddonServiceAssignmentRepository } from "../../../src/modules/addons/addon-service-assignment.repository.js";
import { AvailabilityService } from "../../../src/modules/availability/availability.service.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
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
import { formatPublicReviewerName } from "../../../src/modules/review/review.dto.js";
import { ReviewModel } from "../../../src/modules/review/review.model.js";
import { ReviewRepository } from "../../../src/modules/review/review.repository.js";
import { ReviewService } from "../../../src/modules/review/review.service.js";
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
 * Batch 14 — Reviews & Ratings, domain-level correctness. Every eligible Booking used here is
 * produced by the REAL booking-creation/lifecycle pipeline (never a fixture asserting against
 * itself) — see the batch report for the confirmed rules these tests prove.
 */
describe("database-backed Review domain (Batch 14)", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let serviceRepository: ServiceRepository;
  let staffRepository: StaffRepository;
  let staffScheduleRepository: StaffScheduleRepository;
  let businessHoursRepository: BusinessHoursRepository;
  let businessHoursService: BusinessHoursService;
  let clientRepository: ClientRepository;
  let bookingRepository: BookingRepository;
  let creationService: BookingCreationService;
  let lifecycleService: BookingLifecycleService;
  let paymentService: PaymentService;
  let reviewRepository: ReviewRepository;
  let reviewService: ReviewService;

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

    reviewRepository = new ReviewRepository();
    reviewService = new ReviewService(reviewRepository, bookingRepository);
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixtures --------------------------------------------------------------------------------

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

  const createFixedService = async (businessId: Types.ObjectId, staffId: Types.ObjectId) =>
    serviceRepository.create({
      businessId,
      status: "ACTIVE",
      isFeatured: false,
      isPackageDeal: false,
      category: "Barber",
      name: "Haircut",
      pricingMode: "FIXED",
      fixedPricing: { priceCents: 8000, durationMin: 60, bookingIntervalMin: 60 },
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
    firstName = "Maria",
    lastName = "Khan",
  ) => {
    const user = await userRepository.findById(customerId);
    const nationalNumber = `9${customerId.toString().slice(-7)}`;
    return clientRepository.create({
      businessId,
      createdByUserId: ownerId,
      firstName,
      lastName,
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

  const setupBookableBusiness = async () => {
    const { owner, business } = await createBusiness("Salon A");
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id);
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);
    return { owner, business, membership, service };
  };

  /** Creates a REAL, COMPLETED, BOOKLY_MANAGED booking end to end (finalize -> lifecycle
   * complete) for the given Customer at a fresh Business — the only booking shape this batch
   * makes review-eligible. */
  const createCompletedBooklyManagedBooking = async (
    customerId: Types.ObjectId,
    time = "10:00",
  ) => {
    const { owner, business, membership, service } = await setupBookableBusiness();
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

  /** `createdAt` is schema-immutable (Mongoose's `timestamps: true` marks it so by default,
   * which silently strips it from `Model.updateOne()` even outside a `.save()`) — bypass
   * Mongoose entirely via the raw driver collection to simulate 15 real days having passed,
   * exactly like backdating any other immutable audit timestamp in a test. */
  const backdateReviewCreatedAt = async (reviewId: Types.ObjectId, daysAgo: number) =>
    ReviewModel.collection.updateOne(
      { _id: reviewId },
      { $set: { createdAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000) } },
    );

  // --- [1][17] eligible creation + business rating aggregate ---------------------------------

  it("[1] a Customer can review their own COMPLETED BOOKLY_MANAGED booking", async () => {
    const customer = await createCustomer("eligible");
    const { booking, business } = await createCompletedBooklyManagedBooking(customer._id);

    const review = await reviewService.createFromBooking(
      String(customer._id),
      String(booking._id),
      {
        rating: 5,
        comment: "Great service!",
      },
    );

    expect(review.rating).toBe(5);
    expect(review.status).toBe("PUBLISHED");
    expect(String(review.businessId)).toBe(String(business._id));
    expect(review.reviewerDisplayName).toBe("Maria K.");
  });

  it("[16] a Customer with multiple completed bookings can leave one Review each", async () => {
    const customer = await createCustomer("multi");
    const first = await createCompletedBooklyManagedBooking(customer._id, "10:00");
    const second = await createCompletedBooklyManagedBooking(customer._id, "11:00");

    const r1 = await reviewService.createFromBooking(
      String(customer._id),
      String(first.booking._id),
      {
        rating: 4,
      },
    );
    const r2 = await reviewService.createFromBooking(
      String(customer._id),
      String(second.booking._id),
      {
        rating: 5,
      },
    );

    expect(String(r1.bookingId)).toBe(String(first.booking._id));
    expect(String(r2.bookingId)).toBe(String(second.booking._id));
  });

  it("[17][20][21] Business aggregate: 5+3=avg 4.0/count 2; hide the 3 -> avg 5.0/count 1; zero-review Business -> null/0", async () => {
    const customerA = await createCustomer("agg-a");
    const customerB = await createCustomer("agg-b");
    const bookingA = await createCompletedBooklyManagedBooking(customerA._id, "10:00");
    const { business, booking: bookingBBooking } = await createCompletedBooklyManagedBooking(
      customerB._id,
      "10:00",
    );

    const reviewA = await reviewService.createFromBooking(
      String(customerA._id),
      String(bookingA.booking._id),
      { rating: 5 },
    );
    const reviewB = await reviewService.createFromBooking(
      String(customerB._id),
      String(bookingBBooking._id),
      { rating: 3 },
    );

    // These two reviews are for DIFFERENT businesses (each createCompletedBooklyManagedBooking
    // spins up its own fresh Business) — force them onto the SAME business to test aggregation.
    await ReviewModel.updateOne(
      { _id: reviewB._id },
      { $set: { businessId: bookingA.business._id } },
    ).exec();

    let summary = await reviewService.getBusinessRatingSummary(String(bookingA.business._id));
    expect(summary.averageRating).toBe(4);
    expect(summary.reviewCount).toBe(2);

    await reviewService.moderate(String(reviewB._id), "HIDE", String(new Types.ObjectId()));

    summary = await reviewService.getBusinessRatingSummary(String(bookingA.business._id));
    expect(summary.averageRating).toBe(5);
    expect(summary.reviewCount).toBe(1);

    const listing = await reviewService.listBusinessReviews(String(bookingA.business._id), {
      page: 1,
      limit: 20,
    });
    expect(listing.reviews.map((r) => String(r._id))).toEqual([String(reviewA._id)]);

    // Zero-review business (the untouched, unrelated `business` from the throwaway fixture pair).
    const zeroSummary = await reviewService.getBusinessRatingSummary(String(business._id));
    expect(zeroSummary.averageRating).toBeNull();
    expect(zeroSummary.reviewCount).toBe(0);
  });

  // --- [2][3][4][5] eligibility rejections -----------------------------------------------------

  it("[2] cannot review an UPCOMING booking", async () => {
    const customer = await createCustomer("upcoming");
    const { owner, business, membership, service } = await setupBookableBusiness();
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

    await expect(
      reviewService.createFromBooking(String(customer._id), String(result.booking._id), {
        rating: 5,
      }),
    ).rejects.toThrow();
  });

  it("[3] cannot review a CANCELLED booking", async () => {
    const customer = await createCustomer("cancelled");
    const { owner, business, membership, service } = await setupBookableBusiness();
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
    const cancelled = await lifecycleService.cancelByCustomer(
      String(customer._id),
      String(result.booking._id),
      "change of plans",
    );
    expect(cancelled.status).toBe("CANCELLED_BY_CUSTOMER");

    await expect(
      reviewService.createFromBooking(String(customer._id), String(cancelled._id), { rating: 5 }),
    ).rejects.toThrow();
  });

  it("[4] cannot review a NO_SHOW booking", async () => {
    const customer = await createCustomer("noshow");
    const { booking } = await createCompletedBooklyManagedBooking(customer._id);
    // Force a NO_SHOW terminal status for this test's purpose (the full no-show timer/resolution
    // flow is already covered by booking-lifecycle-database.integration.test.ts — this test only
    // needs to prove Review eligibility keys off `status === "COMPLETED"`).
    await BookingModel.updateOne(
      { _id: booking._id },
      { $set: { status: "NO_SHOW_CHARGED" } },
    ).exec();

    await expect(
      reviewService.createFromBooking(String(customer._id), String(booking._id), { rating: 5 }),
    ).rejects.toThrow();
  });

  it("[5][20] cannot review a MANUAL booking even when COMPLETED, Customer is linked, and the request is well-formed", async () => {
    const { owner, business } = await createBusiness("Salon Manual");
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id);
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);

    const customer = await createCustomer("manual");
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
    expect(manualBooking.source).toBe("MANUAL");
    expect(String(manualBooking.customer.customerUserId)).toBe(String(customer._id));

    const completed = await lifecycleService.completeBooking(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
      String(manualBooking._id),
    );
    expect(completed.status).toBe("COMPLETED");

    await expect(
      reviewService.createFromBooking(String(customer._id), String(completed._id), { rating: 5 }),
    ).rejects.toThrow();
  });

  it("[6] cannot review another Customer's booking (anti-enumeration: same error as an unknown id)", async () => {
    const owner1 = await createCustomer("owner1");
    const stranger = await createCustomer("stranger");
    const { booking } = await createCompletedBooklyManagedBooking(owner1._id);

    let ownerError: unknown;
    let strangerError: unknown;
    try {
      await reviewService.createFromBooking(String(stranger._id), String(new Types.ObjectId()), {
        rating: 5,
      });
    } catch (error) {
      ownerError = error;
    }
    try {
      await reviewService.createFromBooking(String(stranger._id), String(booking._id), {
        rating: 5,
      });
    } catch (error) {
      strangerError = error;
    }

    expect((ownerError as { statusCode?: number })?.statusCode).toBe(404);
    expect((strangerError as { statusCode?: number })?.statusCode).toBe(404);
    expect((ownerError as Error)?.message).toBe((strangerError as Error)?.message);
  });

  // --- [7][8] duplicate / concurrency ----------------------------------------------------------

  it("[7] cannot submit a second Review for the same Booking", async () => {
    const customer = await createCustomer("dup");
    const { booking } = await createCompletedBooklyManagedBooking(customer._id);

    await reviewService.createFromBooking(String(customer._id), String(booking._id), { rating: 4 });

    await expect(
      reviewService.createFromBooking(String(customer._id), String(booking._id), { rating: 2 }),
    ).rejects.toThrow();
  });

  it("[8] a concurrent double-submit creates exactly one Review", async () => {
    const customer = await createCustomer("race");
    const { booking } = await createCompletedBooklyManagedBooking(customer._id);

    const results = await Promise.allSettled([
      reviewService.createFromBooking(String(customer._id), String(booking._id), { rating: 5 }),
      reviewService.createFromBooking(String(customer._id), String(booking._id), { rating: 1 }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const count = await ReviewModel.countDocuments({ bookingId: booking._id }).exec();
    expect(count).toBe(1);
  });

  // --- [9][10] rating/comment validation --------------------------------------------------------

  it("[9] rating 0 is rejected", async () => {
    const customer = await createCustomer("rate0");
    const { booking } = await createCompletedBooklyManagedBooking(customer._id);
    await expect(
      reviewService.createFromBooking(String(customer._id), String(booking._id), { rating: 0 }),
    ).rejects.toThrow();
  });

  it("[9] rating 6 is rejected", async () => {
    const customer = await createCustomer("rate6");
    const { booking } = await createCompletedBooklyManagedBooking(customer._id);
    await expect(
      reviewService.createFromBooking(String(customer._id), String(booking._id), { rating: 6 }),
    ).rejects.toThrow();
  });

  it("[9] a decimal rating is rejected", async () => {
    const customer = await createCustomer("ratedec");
    const { booking } = await createCompletedBooklyManagedBooking(customer._id);
    await expect(
      reviewService.createFromBooking(String(customer._id), String(booking._id), { rating: 3.5 }),
    ).rejects.toThrow();
  });

  it("[10] a comment beyond the bounded max length is rejected", async () => {
    const customer = await createCustomer("longcomment");
    const { booking } = await createCompletedBooklyManagedBooking(customer._id);
    await expect(
      reviewService.createFromBooking(String(customer._id), String(booking._id), {
        rating: 5,
        comment: "x".repeat(1001),
      }),
    ).rejects.toThrow();
  });

  // --- [11][12][13][14] edit window ------------------------------------------------------------

  it("[11] a Customer can edit their Review within 14 days", async () => {
    const customer = await createCustomer("edit-ok");
    const { booking } = await createCompletedBooklyManagedBooking(customer._id);
    await reviewService.createFromBooking(String(customer._id), String(booking._id), { rating: 5 });

    const updated = await reviewService.updateOwnReview(String(customer._id), String(booking._id), {
      rating: 3,
      comment: "Actually, mixed feelings.",
    });
    expect(updated.rating).toBe(3);
    expect(updated.comment).toBe("Actually, mixed feelings.");
  });

  it("[12] a Customer cannot edit after the 14-day window", async () => {
    const customer = await createCustomer("edit-expired");
    const { booking } = await createCompletedBooklyManagedBooking(customer._id);
    const review = await reviewService.createFromBooking(
      String(customer._id),
      String(booking._id),
      {
        rating: 5,
      },
    );
    await backdateReviewCreatedAt(review._id, 15);

    await expect(
      reviewService.updateOwnReview(String(customer._id), String(booking._id), { rating: 1 }),
    ).rejects.toThrow();
  });

  it("[13] editing does not reset the 14-day deadline — createdAt stays the original submission time", async () => {
    const customer = await createCustomer("edit-no-reset");
    const { booking } = await createCompletedBooklyManagedBooking(customer._id);
    const review = await reviewService.createFromBooking(
      String(customer._id),
      String(booking._id),
      {
        rating: 5,
      },
    );
    const originalCreatedAt = review.createdAt.getTime();

    const updated = await reviewService.updateOwnReview(String(customer._id), String(booking._id), {
      rating: 4,
    });
    expect(updated.createdAt.getTime()).toBe(originalCreatedAt);

    // Now backdate as if 15 days had passed since the ORIGINAL createdAt (not the edit) — a
    // second edit attempt must still be rejected, proving the edit itself never pushed the
    // deadline forward.
    await backdateReviewCreatedAt(review._id, 15);
    await expect(
      reviewService.updateOwnReview(String(customer._id), String(booking._id), { rating: 2 }),
    ).rejects.toThrow();
  });

  it("[14] a Customer cannot edit another Customer's Review", async () => {
    const owner = await createCustomer("edit-owner");
    const stranger = await createCustomer("edit-stranger");
    const { booking } = await createCompletedBooklyManagedBooking(owner._id);
    await reviewService.createFromBooking(String(owner._id), String(booking._id), { rating: 5 });

    await expect(
      reviewService.updateOwnReview(String(stranger._id), String(booking._id), { rating: 1 }),
    ).rejects.toThrow();
  });

  // --- [15] no delete path -----------------------------------------------------------------------

  it("[15] ReviewService exposes no delete method at all", () => {
    expect(
      (reviewService as unknown as { deleteOwnReview?: unknown }).deleteOwnReview,
    ).toBeUndefined();
    expect((reviewService as unknown as { delete?: unknown }).delete).toBeUndefined();
  });

  // --- [18][19] moderation ------------------------------------------------------------------------

  it("[18] a Hidden Review is excluded from the public list and the aggregate, audit is preserved", async () => {
    const customer = await createCustomer("hide");
    const { booking, business } = await createCompletedBooklyManagedBooking(customer._id);
    const review = await reviewService.createFromBooking(
      String(customer._id),
      String(booking._id),
      {
        rating: 5,
      },
    );

    const hidden = await reviewService.moderate(
      String(review._id),
      "HIDE",
      String(new Types.ObjectId()),
    );
    expect(hidden.status).toBe("HIDDEN");
    expect(hidden.moderationHistory).toHaveLength(1);
    expect(hidden.moderationHistory[0]?.action).toBe("HIDE");
    expect(hidden.moderationHistory[0]?.previousStatus).toBe("PUBLISHED");
    expect(hidden.moderationHistory[0]?.resultingStatus).toBe("HIDDEN");

    const listing = await reviewService.listBusinessReviews(String(business._id), {
      page: 1,
      limit: 20,
    });
    expect(listing.reviews).toHaveLength(0);
    const summary = await reviewService.getBusinessRatingSummary(String(business._id));
    expect(summary.reviewCount).toBe(0);

    // The row itself is preserved, never erased.
    const stillExists = await reviewRepository.findById(review._id);
    expect(stillExists?.status).toBe("HIDDEN");
  });

  it("[19] a Removed Review is excluded from the public list and the aggregate, audit is preserved", async () => {
    const customer = await createCustomer("remove");
    const { booking, business } = await createCompletedBooklyManagedBooking(customer._id);
    const review = await reviewService.createFromBooking(
      String(customer._id),
      String(booking._id),
      {
        rating: 5,
      },
    );

    const removed = await reviewService.moderate(
      String(review._id),
      "REMOVE",
      String(new Types.ObjectId()),
    );
    expect(removed.status).toBe("REMOVED");

    const listing = await reviewService.listBusinessReviews(String(business._id), {
      page: 1,
      limit: 20,
    });
    expect(listing.reviews).toHaveLength(0);
    const summary = await reviewService.getBusinessRatingSummary(String(business._id));
    expect(summary.reviewCount).toBe(0);

    const stillExists = await reviewRepository.findById(review._id);
    expect(stillExists?.status).toBe("REMOVED");
  });

  it("[22] moderating an already-Hidden Review is rejected (no Restore, no double-transition)", async () => {
    const customer = await createCustomer("double-mod");
    const { booking } = await createCompletedBooklyManagedBooking(customer._id);
    const review = await reviewService.createFromBooking(
      String(customer._id),
      String(booking._id),
      {
        rating: 5,
      },
    );
    await reviewService.moderate(String(review._id), "HIDE", String(new Types.ObjectId()));

    await expect(
      reviewService.moderate(String(review._id), "HIDE", String(new Types.ObjectId())),
    ).rejects.toThrow();
    await expect(
      reviewService.moderate(String(review._id), "REMOVE", String(new Types.ObjectId())),
    ).rejects.toThrow();
  });

  // --- [23] public identity formatter --------------------------------------------------------

  it("[23] formatPublicReviewerName: 'Maria Khan' -> 'Maria K.', single name stays as-is", () => {
    expect(formatPublicReviewerName("Maria", "Khan")).toBe("Maria K.");
    expect(formatPublicReviewerName("John", "Doe")).toBe("John D.");
    expect(formatPublicReviewerName("Maria")).toBe("Maria");
    expect(formatPublicReviewerName("Maria", "")).toBe("Maria");
  });
});
