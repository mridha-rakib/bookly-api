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
import { DashboardOverviewError } from "../../../src/modules/dashboard-overview/dashboard-overview.errors.js";
import { DashboardOverviewService } from "../../../src/modules/dashboard-overview/dashboard-overview.service.js";
import { BusinessPayoutRepository } from "../../../src/modules/finance/business-payout.repository.js";
import { FinanceService } from "../../../src/modules/finance/finance.service.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const TIMEZONE = "Europe/Nicosia";

/**
 * Real Overview backend for the Business Owner/Supervisor/Staff dashboard — bookings/ledger
 * fixtures are inserted directly via BookingRepository.create/BookingFinancialTransactionService.
 * record (bypassing the full creation/availability/payment sagas entirely), matching this
 * codebase's own precedent (see booking-database.integration.test.ts's own
 * `buildValidBookingInput` — "prove the schema/service behave correctly... without exercising
 * any other module").
 */
describe("database-backed Dashboard Overview", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let staffRepository: StaffRepository;
  let clientRepository: ClientRepository;
  let bookingRepository: BookingRepository;
  let financialTransactionService: BookingFinancialTransactionService;
  let financeService: FinanceService;
  let service: DashboardOverviewService;

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
    financeService = new FinanceService(
      businessRepository,
      financialTransactionService,
      bookingRepository,
      new BusinessPayoutRepository(),
    );
    service = new DashboardOverviewService(
      businessRepository,
      staffRepository,
      bookingRepository,
      financialTransactionService,
      financeService,
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

  const createStaffMember = async (
    businessId: Types.ObjectId,
    role: "STAFF" | "SUPERVISOR" = "STAFF",
  ) => {
    const staffUser = await userRepository.create({
      normalizedEmail: `staff-${new Types.ObjectId().toString()}@example.com`,
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
    staffFirstName?: string;
  }): CreateBookingInput => ({
    businessId: input.businessId,
    reference: generateBookingReference(),
    source: "BOOKLY_MANAGED",
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
        serviceId: new Types.ObjectId(),
        serviceSnapshot: { name: "Haircut", pricingMode: "FIXED", durationMin: 30 },
        pricingInput: {},
        responsibleStaffMembershipId: input.staffMembershipId,
        staffSnapshot: { firstName: input.staffFirstName ?? "Basel" },
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
      platformFeeCents: 500,
      depositCents: 500,
      balanceDueCents: 1500,
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

  // --- Full scope: Owner / Supervisor ----------------------------------------------------------

  it("gives a Business Owner the full Overview: today's schedule/timeline, no-show + monthly-revenue figures, and recent activity", async () => {
    const { owner, business } = await createBusiness();
    const { membership } = await createStaffMember(business._id, "STAFF");
    const client = await createClient(business._id);

    const todayBooking = await bookingRepository.create(
      buildBookingInput({
        businessId: business._id,
        clientId: client._id,
        staffMembershipId: membership._id,
        actorUserId: owner._id,
        startAt: todayAt("09:00"),
      }),
    );

    const noShowBooking = await bookingRepository.create(
      buildBookingInput({
        businessId: business._id,
        clientId: client._id,
        staffMembershipId: membership._id,
        actorUserId: owner._id,
        startAt: todayAt("11:00"),
        status: "NO_SHOW_CHARGED",
      }),
    );

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
    await financialTransactionService.record({
      businessId: business._id,
      bookingId: todayBooking._id,
      businessClientId: client._id,
      type: "PLATFORM_FEE",
      direction: "DEBIT",
      amountCents: 500,
      currency: "EUR",
      status: "SUCCEEDED",
    });

    const overview = await service.getOverview(
      String(owner._id),
      "BUSINESS_OWNER",
      String(business._id),
    );

    expect(overview.scope).toBe("FULL");
    expect(overview.todayBookingsCount).toBe(2);
    expect(overview.schedule.map((row) => row.bookingId).sort()).toEqual(
      [String(todayBooking._id), String(noShowBooking._id)].sort(),
    );
    const scheduleRow = overview.schedule.find((row) => row.bookingId === String(todayBooking._id));
    expect(scheduleRow?.totalPaymentCents).toBe(2000);
    expect(scheduleRow?.platformFeeCents).toBe(500);
    expect(scheduleRow?.remainingFeeCents).toBe(1500);
    expect(scheduleRow?.leadType).toBe("NEW_CUSTOMER");
    expect(scheduleRow?.staffName).toBe("Basel");

    expect(overview.financials).not.toBeNull();
    expect(overview.financials?.noShowMonthCount).toBe(1);
    expect(overview.financials?.noShowMonthChargedCents).toBe(4500);
    // Reuses FinanceService's own net-payout formula (fee-recovery only) — matches
    // FinanceService.getSummary's documented scope exactly, never a second invented formula.
    expect(overview.financials?.monthlyRevenueCents).toBe(4500);
    expect(overview.financials?.recentActivity).toHaveLength(2);
    const activityTypes = overview.financials?.recentActivity.map((entry) => entry.type).sort();
    expect(activityTypes).toEqual(["NO_SHOW_FEE", "PLATFORM_FEE"]);
    const noShowActivity = overview.financials?.recentActivity.find(
      (entry) => entry.type === "NO_SHOW_FEE",
    );
    expect(noShowActivity?.bookingReference).toBe(noShowBooking.reference);
    expect(noShowActivity?.customerName).toBe("Jane Doe");
  });

  it("gives an active Supervisor of the same Business the same full Overview", async () => {
    const { owner, business } = await createBusiness();
    const { membership } = await createStaffMember(business._id, "STAFF");
    const { staffUser: supervisorUser } = await createStaffMember(business._id, "SUPERVISOR");
    const client = await createClient(business._id);

    await bookingRepository.create(
      buildBookingInput({
        businessId: business._id,
        clientId: client._id,
        staffMembershipId: membership._id,
        actorUserId: owner._id,
        startAt: todayAt("09:00"),
      }),
    );

    const overview = await service.getOverview(
      String(supervisorUser._id),
      "SUPERVISOR",
      String(business._id),
    );

    expect(overview.scope).toBe("FULL");
    expect(overview.todayBookingsCount).toBe(1);
    expect(overview.financials).not.toBeNull();
  });

  // --- Scoped-down: Staff -----------------------------------------------------------------------

  it("gives a Staff member ONLY their own scoped bookings and no financial figures", async () => {
    const { owner, business } = await createBusiness();
    const { staffUser: staffA, membership: membershipA } = await createStaffMember(
      business._id,
      "STAFF",
    );
    const { membership: membershipB } = await createStaffMember(business._id, "STAFF");
    const client = await createClient(business._id);

    const bookingForA = await bookingRepository.create(
      buildBookingInput({
        businessId: business._id,
        clientId: client._id,
        staffMembershipId: membershipA._id,
        actorUserId: owner._id,
        startAt: todayAt("09:00"),
        staffFirstName: "A",
      }),
    );
    await bookingRepository.create(
      buildBookingInput({
        businessId: business._id,
        clientId: client._id,
        staffMembershipId: membershipB._id,
        actorUserId: owner._id,
        startAt: todayAt("10:00"),
        staffFirstName: "B",
      }),
    );

    const overview = await service.getOverview(String(staffA._id), "STAFF", String(business._id));

    expect(overview.scope).toBe("STAFF_SCOPED");
    expect(overview.financials).toBeNull();
    expect(overview.todayBookingsCount).toBe(1);
    expect(overview.schedule).toHaveLength(1);
    expect(overview.schedule[0]?.bookingId).toBe(String(bookingForA._id));
  });

  // --- Authorization: anti-enumeration ----------------------------------------------------------

  it("denies access with the SAME not-found error whether the businessId belongs to someone else or does not exist at all", async () => {
    const { owner: ownerA } = await createBusiness();
    const { business: businessB } = await createBusiness();

    let errorForOtherOwnersBusiness: unknown;
    try {
      await service.getOverview(String(ownerA._id), "BUSINESS_OWNER", String(businessB._id));
    } catch (error) {
      errorForOtherOwnersBusiness = error;
    }

    let errorForNonexistentBusiness: unknown;
    try {
      await service.getOverview(String(ownerA._id), "BUSINESS_OWNER", String(new Types.ObjectId()));
    } catch (error) {
      errorForNonexistentBusiness = error;
    }

    expect(errorForOtherOwnersBusiness).toBeInstanceOf(DashboardOverviewError);
    expect(errorForNonexistentBusiness).toBeInstanceOf(DashboardOverviewError);
    expect((errorForOtherOwnersBusiness as DashboardOverviewError).statusCode).toBe(404);
    expect((errorForOtherOwnersBusiness as DashboardOverviewError).message).toBe(
      (errorForNonexistentBusiness as DashboardOverviewError).message,
    );
  });

  it("denies a Staff member of a DIFFERENT business the same way", async () => {
    const { business: businessA } = await createBusiness();
    const { staffUser: staffOfB } = await createStaffMember(
      (await createBusiness()).business._id,
      "STAFF",
    );

    await expect(
      service.getOverview(String(staffOfB._id), "STAFF", String(businessA._id)),
    ).rejects.toThrow(DashboardOverviewError);
  });

  it("denies a CUSTOMER actor outright, same not-found error", async () => {
    const { business } = await createBusiness();
    const customer = await userRepository.create({
      normalizedEmail: `cust-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });

    await expect(
      service.getOverview(String(customer._id), "CUSTOMER", String(business._id)),
    ).rejects.toThrow(DashboardOverviewError);
  });
});
