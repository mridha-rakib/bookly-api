import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  businessLocalToUtc,
  utcToBusinessLocalDate,
} from "../../../src/common/time/business-clock.js";
import type { CreateBookingInput } from "../../../src/modules/booking/booking.repository.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { generateBookingReference } from "../../../src/modules/booking/booking.utils.js";
import { BookingFinancialTransactionRepository } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { DashboardAnalyticsError } from "../../../src/modules/dashboard-analytics/dashboard-analytics.errors.js";
import { DashboardAnalyticsService } from "../../../src/modules/dashboard-analytics/dashboard-analytics.service.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const TIMEZONE = "Europe/Nicosia";

/**
 * Real, business-scoped backend for the Business Owner dashboard "Analytics" tab — fixtures are
 * inserted directly via BookingRepository.create/BookingFinancialTransactionService.record/
 * ClientRepository.markActivated (bypassing the full creation/payment sagas entirely), matching
 * this codebase's own precedent (see dashboard-overview-database.integration.test.ts's own
 * comment).
 */
describe("database-backed Dashboard Analytics", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let staffRepository: StaffRepository;
  let clientRepository: ClientRepository;
  let bookingRepository: BookingRepository;
  let financialTransactionService: BookingFinancialTransactionService;
  let service: DashboardAnalyticsService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    staffRepository = new StaffRepository();
    clientRepository = new ClientRepository();
    bookingRepository = new BookingRepository();
    financialTransactionService = new BookingFinancialTransactionService(
      new BookingFinancialTransactionRepository(),
    );
    service = new DashboardAnalyticsService(
      businessRepository,
      bookingRepository,
      clientRepository,
      financialTransactionService,
    );
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixtures --------------------------------------------------------------------------------

  const createBusiness = async () => {
    const owner = await userRepository.create({
      normalizedEmail: `owner-${new Types.ObjectId().toString()}@example.com`,
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
      visitType: "AT_BUSINESS_LOCATION",
      timezone: TIMEZONE,
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "A great business",
      category: "Barber",
      subcategories: ["Haircut"],
    });
    return { owner, business };
  };

  const createStaffMember = async (businessId: Types.ObjectId) => {
    const staffUser = await userRepository.create({
      normalizedEmail: `staff-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "STAFF",
      status: "ACTIVE",
    });
    const membership = await staffRepository.create({
      userId: staffUser._id,
      businessId,
      role: "STAFF",
      createdByUserId: staffUser._id,
    });
    return { staffUser, membership };
  };

  const createClient = async (businessId: Types.ObjectId) =>
    clientRepository.create({
      businessId,
      createdByUserId: new Types.ObjectId(),
      firstName: "Jane",
      lastName: "Doe",
      normalizedEmail: `jane-${new Types.ObjectId().toString()}@example.com`,
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

  const todayDateStr = () => utcToBusinessLocalDate(TIMEZONE, new Date()).dateStr;
  const todayAt = (time: string) => businessLocalToUtc(TIMEZONE, todayDateStr(), time);

  const buildBookingInput = (input: {
    businessId: Types.ObjectId;
    clientId: Types.ObjectId;
    staffMembershipId: Types.ObjectId;
    actorUserId: Types.ObjectId;
    startAt: Date;
    status?: CreateBookingInput["status"];
    source?: CreateBookingInput["source"];
    serviceName?: string;
    serviceId?: Types.ObjectId;
    platformFeeCents?: number;
    depositCents?: number;
  }): CreateBookingInput => ({
    businessId: input.businessId,
    reference: generateBookingReference(),
    source: input.source ?? "BOOKLY_MANAGED",
    status: input.status ?? "UPCOMING",
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
        serviceId: input.serviceId ?? new Types.ObjectId(),
        serviceSnapshot: {
          name: input.serviceName ?? "Haircut",
          pricingMode: "FIXED",
          durationMin: 30,
        },
        pricingInput: {},
        responsibleStaffMembershipId: input.staffMembershipId,
        staffSnapshot: { firstName: "Basel" },
        addons: [],
        amountCents: 2000,
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
      platformFeeCents: input.platformFeeCents ?? 0,
      depositCents: input.depositCents ?? 500,
      balanceDueCents: 2000 - (input.depositCents ?? 500),
      totalCents: 2000,
    },
    schedule: {
      timezone: TIMEZONE,
      startAt: input.startAt,
      endAt: new Date(input.startAt.getTime() + 30 * 60 * 1000),
    },
    customerRescheduleCount: 0,
    rescheduleHistory: [],
    eventHistory: [],
  });

  // --- Owner reads real, aggregated analytics ---------------------------------------------------

  it("gives a Business Owner real, business-scoped Analytics for the current month", async () => {
    const { owner, business } = await createBusiness();
    const { membership } = await createStaffMember(business._id);
    const client = await createClient(business._id);

    // Booking 1: BOOKLY_MANAGED, COMPLETED, first-time customer (platformFeeCents>0 -> NEW).
    const completedBooking = await bookingRepository.create(
      buildBookingInput({
        businessId: business._id,
        clientId: client._id,
        staffMembershipId: membership._id,
        actorUserId: owner._id,
        startAt: todayAt("09:00"),
        status: "COMPLETED",
        serviceName: "Haircut",
        platformFeeCents: 500,
      }),
    );
    await financialTransactionService.record({
      businessId: business._id,
      bookingId: completedBooking._id,
      businessClientId: client._id,
      type: "PLATFORM_FEE",
      direction: "DEBIT",
      amountCents: 500,
      currency: "EUR",
      status: "SUCCEEDED",
    });
    await clientRepository.markActivated(client._id, completedBooking._id);

    // Booking 2: BOOKLY_MANAGED, NO_SHOW_CHARGED, returning customer (platformFeeCents=0).
    const noShowBooking = await bookingRepository.create(
      buildBookingInput({
        businessId: business._id,
        clientId: client._id,
        staffMembershipId: membership._id,
        actorUserId: owner._id,
        startAt: todayAt("11:00"),
        status: "NO_SHOW_CHARGED",
        serviceName: "Manicure",
      }),
    );
    await financialTransactionService.record({
      businessId: business._id,
      bookingId: noShowBooking._id,
      businessClientId: client._id,
      type: "DEPOSIT",
      direction: "DEBIT",
      amountCents: 800,
      currency: "EUR",
      status: "SUCCEEDED",
    });
    await financialTransactionService.record({
      businessId: business._id,
      bookingId: noShowBooking._id,
      businessClientId: client._id,
      type: "NO_SHOW_FEE",
      direction: "DEBIT",
      amountCents: 4500,
      currency: "EUR",
      status: "SUCCEEDED",
    });

    // Booking 3: MANUAL, cancelled by customer — no ledger entries (financially outside Bookly).
    await bookingRepository.create(
      buildBookingInput({
        businessId: business._id,
        clientId: client._id,
        staffMembershipId: membership._id,
        actorUserId: owner._id,
        startAt: todayAt("14:00"),
        status: "CANCELLED_BY_CUSTOMER",
        source: "MANUAL",
        serviceName: "Haircut",
        platformFeeCents: 0,
        depositCents: 0,
      }),
    );

    const analytics = await service.getAnalytics(String(owner._id), String(business._id), "MONTH");

    expect(analytics.totalBookingsCount).toBe(3);
    expect(analytics.newCustomersCount).toBe(1);
    expect(analytics.returningCustomersCount).toBe(1);
    expect(analytics.completionRate).toBeCloseTo(1 / 3);
    expect(analytics.noShowRate).toBeCloseTo(1 / 3);
    expect(analytics.noShowCount).toBe(1);
    expect(analytics.noShowChargedCount).toBe(1);

    // avg booking value: (500 PLATFORM_FEE + 800 DEPOSIT) / 2 online bookings (MANUAL excluded).
    expect(analytics.avgBookingValueCents).toBe(650);
    // revenue recovered: NO_SHOW_FEE (4500) + CANCELLATION_FEE (0), gross.
    expect(analytics.revenueRecoveredCents).toBe(4500);

    expect(analytics.topServices.map((s) => s.name).sort()).toEqual([
      "Haircut",
      "Haircut",
      "Manicure",
    ]);
    expect(analytics.topServices.length).toBeLessThanOrEqual(5);

    const byStatus = Object.fromEntries(
      analytics.bookingsByStatus.map((row) => [row.status, row.count]),
    );
    expect(byStatus["COMPLETED"]).toBe(1);
    expect(byStatus["NO_SHOW_CHARGED"]).toBe(1);
    expect(byStatus["CANCELLED_BY_CUSTOMER"]).toBe(1);
    expect(byStatus["NO_SHOW_WAIVED"]).toBe(0);

    const totalBusiestDaysCount = analytics.busiestDays.reduce((sum, row) => sum + row.count, 0);
    expect(totalBusiestDaysCount).toBe(3);
    expect(analytics.busiestDays).toHaveLength(7);
  });

  it("supports the YEAR and ALL period selectors without throwing (ledger reads chunked/unbounded correctly)", async () => {
    const { owner, business } = await createBusiness();

    const yearAnalytics = await service.getAnalytics(
      String(owner._id),
      String(business._id),
      "YEAR",
    );
    expect(yearAnalytics.period).toBe("YEAR");
    expect(yearAnalytics.totalBookingsCount).toBe(0);

    const allTimeAnalytics = await service.getAnalytics(
      String(owner._id),
      String(business._id),
      "ALL",
    );
    expect(allTimeAnalytics.period).toBe("ALL");
    expect(allTimeAnalytics.totalBookingsChangePercent).toBeNull();
  });

  // --- Authorization: anti-enumeration ----------------------------------------------------------

  it("denies access with the SAME not-found error whether the businessId belongs to someone else or does not exist at all", async () => {
    const { owner: ownerA } = await createBusiness();
    const { business: businessB } = await createBusiness();

    let errorForOtherOwnersBusiness: unknown;
    try {
      await service.getAnalytics(String(ownerA._id), String(businessB._id), "MONTH");
    } catch (error) {
      errorForOtherOwnersBusiness = error;
    }

    let errorForNonexistentBusiness: unknown;
    try {
      await service.getAnalytics(String(ownerA._id), String(new Types.ObjectId()), "MONTH");
    } catch (error) {
      errorForNonexistentBusiness = error;
    }

    expect(errorForOtherOwnersBusiness).toBeInstanceOf(DashboardAnalyticsError);
    expect(errorForNonexistentBusiness).toBeInstanceOf(DashboardAnalyticsError);
    expect((errorForOtherOwnersBusiness as DashboardAnalyticsError).statusCode).toBe(404);
    expect((errorForOtherOwnersBusiness as DashboardAnalyticsError).message).toBe(
      (errorForNonexistentBusiness as DashboardAnalyticsError).message,
    );
  });
});
