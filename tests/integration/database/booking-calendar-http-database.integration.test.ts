import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import {
  addCalendarDays,
  businessLocalToUtc,
  enumerateCalendarDates,
  utcToBusinessLocalDate,
} from "../../../src/common/time/business-clock.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import {
  type BookingCalendarEntryDto,
  toBookingCalendarEntryDto,
} from "../../../src/modules/booking/booking.dto.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { createBusinessBookingRoute } from "../../../src/modules/booking/booking.route.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessHoursRepository } from "../../../src/modules/business-hours/business-hours.repository.js";
import { BusinessHoursService } from "../../../src/modules/business-hours/business-hours.service.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const TIMEZONE = "Europe/Nicosia";
// Monday..Sunday, safely in the future relative to any real "now" (2030-08-20 is a Tuesday).
const WEEK = { first: "2030-08-19", last: "2030-08-25" };
// The week EU summer time ends (Sunday 2030-10-27), so Sunday-late is UTC+2, Monday is UTC+3.
const DST_WEEK = { first: "2030-10-21", last: "2030-10-27" };

/**
 * Mirrors DashboardCalendar.tsx's request window for a browser whose own timezone is
 * `browserTz`: full ISO instants from local midnight one day before the first visible date to
 * local 23:59:59.999 one day after the last. The padding exists because columns are browser-
 * local dates while cards are bucketed by each Booking's own snapshotted timezone.
 */
const clientWindow = (browserTz: string, firstVisible: string, lastVisible: string) => ({
  fromDate: businessLocalToUtc(browserTz, addCalendarDays(firstVisible, -1), "00:00").toISOString(),
  toDate: new Date(
    businessLocalToUtc(browserTz, addCalendarDays(lastVisible, 1), "23:59").getTime() + 59_999,
  ).toISOString(),
});

/** Mirrors DashboardCalendar.tsx's bookingLocalDateKey: the column a card renders in is the
 * Booking's start date in ITS OWN snapshotted timezone. A fetched row whose key is not one of
 * the visible dates never renders. */
const renderedDateKey = (entry: BookingCalendarEntryDto): string =>
  utcToBusinessLocalDate(entry.schedule.timezone, new Date(entry.schedule.startAt)).dateStr;

/**
 * The Business Calendar read path end to end: the request contract the client actually sends,
 * the narrow `findManyForCalendar` projection feeding `toBookingCalendarEntryDto`, and the
 * visible-week boundaries. Before this suite the route had no test at all — the client's
 * date-only params were rejected with 400, and once past validation the projection omitted
 * `serviceLines.pricingInput`, so the mapper threw for every returned Booking.
 */
describe("Business Calendar read path (GET /businesses/:businessId/bookings/calendar)", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let serviceRepository: ServiceRepository;
  let staffRepository: StaffRepository;
  let staffScheduleRepository: StaffScheduleRepository;
  let businessHoursService: BusinessHoursService;
  let clientRepository: ClientRepository;
  let tokenService: TokenService;
  let referenceSeq = 0;

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
    businessHoursService = new BusinessHoursService(
      new BusinessHoursRepository(),
      businessRepository,
    );
    clientRepository = new ClientRepository();
    tokenService = new TokenService(new SessionRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixtures --------------------------------------------------------------------------------

  const createBusiness = async () => {
    const email = `owner-${new Types.ObjectId().toString()}@example.com`;
    const owner = await userRepository.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const pending = await businessRepository.create({
      ownerUserId: owner._id,
      name: "Calendar Salon",
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
    // Manual booking creation is gated on approval; the calendar read itself is not.
    const business = await businessRepository.casUpdateStatus(
      pending._id,
      ["PENDING"],
      "APPROVED",
      {
        fromStatus: "PENDING",
        actorUserId: owner._id,
        changedAt: new Date(),
      },
    );
    return { owner, business: business ?? pending };
  };

  const createStaff = async (
    businessId: Types.ObjectId,
    role: "STAFF" | "SUPERVISOR" = "STAFF",
  ) => {
    const user = await userRepository.create({
      normalizedEmail: `staff-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role,
      status: "ACTIVE",
    });
    await userRepository.createProfile({
      userId: user._id,
      firstName: "Test",
      lastName: "Staff",
      gender: "other",
    });
    const membership = await staffRepository.create({
      userId: user._id,
      businessId,
      role,
      createdByUserId: user._id,
    });
    return { user, membership };
  };

  /** Everything the REAL manual-create and owner-reschedule routes need to accept a slot. */
  const setupBookableBusiness = async () => {
    const { owner, business } = await createBusiness();
    const { membership } = await createStaff(business._id);
    const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] as const;
    await businessHoursService.putOpeningHours(String(owner._id), String(business._id), [
      ...weekdays.map((dayOfWeek) => ({
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
      weekdays.map((dayOfWeek) => ({
        dayOfWeek,
        intervals: [{ startTime: "09:00", endTime: "18:00" }],
      })),
    );
    const service = await serviceRepository.create({
      businessId: business._id,
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
      assignedStaffMembershipIds: [membership._id],
    });
    const client = await clientRepository.create({
      businessId: business._id,
      createdByUserId: owner._id,
      firstName: "Walk",
      lastName: "In",
      normalizedEmail: `walkin-${new Types.ObjectId().toString()}@example.com`,
      phone: { countryCode: "+357", nationalNumber: "96000011", e164: "+35796000011" },
      address: {
        city: "Larnaca",
        propertyType: "House",
        area: "Center",
        streetName: "Main",
        streetNumber: "1",
      },
      linkState: "UNLINKED",
    });
    return { owner, business, membership, service, client };
  };

  type SeedLine =
    | { pricingMode: "FIXED" }
    | {
        pricingMode: "PACKAGE";
        packageProgressId: Types.ObjectId;
        sessionIndex: number;
        sessionsInPackage: number;
      };

  /** A model-valid Booking inserted directly — for shapes the manual-create route cannot
   * produce (customer-originated, package sessions, travel, out-of-hours boundary times). The
   * Calendar read path has no dependency on how a Booking was created. */
  const insertBooking = async (input: {
    businessId: Types.ObjectId;
    membershipId: Types.ObjectId;
    date: string;
    time: string;
    source?: "BOOKLY_MANAGED" | "MANUAL";
    line?: SeedLine;
    travel?: boolean;
    noShowWindow?: boolean;
  }) => {
    const startAt = businessLocalToUtc(TIMEZONE, input.date, input.time);
    const line = input.line ?? { pricingMode: "FIXED" };
    referenceSeq += 1;
    return BookingModel.create({
      businessId: input.businessId,
      reference: `CAL${String(referenceSeq).padStart(5, "0")}`,
      source: input.source ?? "BOOKLY_MANAGED",
      status: "UPCOMING",
      customer: {
        businessClientId: new Types.ObjectId(),
        contact: {
          firstName: "Cal",
          lastName: "Customer",
          normalizedEmail: `cal-${referenceSeq}@example.com`,
          phone: { countryCode: "+357", nationalNumber: "99000000", e164: "+35799000000" },
        },
      },
      createdBy: {
        actorUserId: new Types.ObjectId(),
        actorRole: input.source === "MANUAL" ? "BUSINESS_OWNER" : "CUSTOMER",
      },
      fulfilment: input.travel
        ? {
            mode: "TRAVEL_TO_CUSTOMER",
            travelAddress: {
              city: "Larnaca",
              propertyType: "Apartment",
              area: "Center",
              streetName: "Main",
              streetNumber: "1",
            },
          }
        : { mode: "AT_BUSINESS_LOCATION" },
      serviceLines: [
        {
          serviceId: new Types.ObjectId(),
          serviceSnapshot: {
            name: line.pricingMode === "PACKAGE" ? "Signature Package" : "Haircut",
            pricingMode: line.pricingMode,
            durationMin: 60,
          },
          pricingInput:
            line.pricingMode === "PACKAGE"
              ? {
                  packageProgressId: line.packageProgressId,
                  sessionIndex: line.sessionIndex,
                  sessionsInPackage: line.sessionsInPackage,
                }
              : {},
          responsibleStaffMembershipId: input.membershipId,
          staffSnapshot: { firstName: "Test", lastName: "Staff" },
          addons: [],
          amountCents: 10_000,
          reservationId: new Types.ObjectId(),
        },
      ],
      financials: {
        currency: "EUR",
        servicesSubtotalCents: 10_000,
        addonsSubtotalCents: 0,
        serviceDiscountCents: 0,
        travelFeeCents: 0,
        eligiblePlatformFeeBasisCents: 10_000,
        platformFeeCents: 0,
        depositCents: 0,
        balanceDueCents: 10_000,
        totalCents: 10_000,
      },
      schedule: {
        timezone: TIMEZONE,
        startAt,
        endAt: new Date(startAt.getTime() + 60 * 60_000),
      },
      customerRescheduleCount: 0,
      rescheduleHistory: [],
      eventHistory: [],
      ...(input.noShowWindow
        ? {
            noShowEligibilitySnapshot: {
              categoryKey: "barber",
              opensAfterMinutes: 15,
              closesAfterMinutes: 1440,
            },
          }
        : {}),
    });
  };

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/businesses", createBusinessBookingRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "BUSINESS_OWNER" | "SUPERVISOR",
  ) => `Bearer ${await issueTestAccessToken(tokenService, { userId, role })}`;

  const getCalendar = async (
    businessId: Types.ObjectId,
    authorization: string,
    query: { fromDate: string; toDate: string },
  ) =>
    request(buildApp())
      .get(`/businesses/${businessId}/bookings/calendar`)
      .query(query)
      .set("Authorization", authorization);

  /** The full-document DTO — what the Calendar entry must equal if the projection supplies
   * every field the mapper reads. */
  const fullDocumentDto = async (bookingId: Types.ObjectId | string) =>
    JSON.parse(
      JSON.stringify(
        toBookingCalendarEntryDto(await BookingModel.findById(bookingId).orFail().exec()),
      ),
    ) as BookingCalendarEntryDto;

  // --- A. Request contract ----------------------------------------------------------------------

  it("accepts the exact Today/Weekly/Monthly windows the Calendar client sends", async () => {
    const { owner, business } = await createBusiness();
    const auth = await bearerFor(owner._id, "BUSINESS_OWNER");

    const views = {
      Today: clientWindow("Asia/Dhaka", "2030-08-20", "2030-08-20"),
      Weekly: clientWindow("Asia/Dhaka", WEEK.first, WEEK.last),
      Monthly: clientWindow("Asia/Dhaka", "2030-08-01", "2030-08-31"),
    };

    for (const [view, query] of Object.entries(views)) {
      expect(new Date(query.fromDate).getTime(), view).toBeLessThan(
        new Date(query.toDate).getTime(),
      );
      const response = await getCalendar(business._id, auth, query);
      expect(response.status, view).toBe(200);
      expect(response.body.data.bookings, view).toEqual([]);
    }
  });

  it("rejects the old date-only window (the pre-fix client shape) with 400", async () => {
    const { owner, business } = await createBusiness();

    const response = await getCalendar(business._id, await bearerFor(owner._id, "BUSINESS_OWNER"), {
      fromDate: WEEK.first,
      toDate: WEEK.last,
    });

    expect(response.status).toBe(400);
  });

  // --- B. Projection / DTO across every booking origin ---------------------------------------

  it("returns every booking origin in the week, each mapped identically to its full document", async () => {
    const { owner, business, membership, service, client } = await setupBookableBusiness();
    const auth = await bearerFor(owner._id, "BUSINESS_OWNER");
    const app = buildApp();

    const createManual = async (date: string, time: string) => {
      const response = await request(app)
        .post(`/businesses/${business._id}/bookings`)
        .set("Authorization", auth)
        .send({
          serviceLines: [
            {
              serviceId: String(service._id),
              staffMembershipId: String(membership._id),
              addonIds: [],
              pricingInput: {},
            },
          ],
          startAt: businessLocalToUtc(TIMEZONE, date, time).toISOString(),
          businessClientId: String(client._id),
          idempotencyKey: `key-${new Types.ObjectId().toString()}`,
        });
      expect(response.status).toBe(201);
      return String(response.body.data.id);
    };

    // Real routes: Owner manual booking, and an Owner-rescheduled one (Mon 10:00 -> Thu 14:00).
    const manualId = await createManual("2030-08-20", "10:00");
    const rescheduledId = await createManual("2030-08-19", "10:00");
    const rescheduleResponse = await request(app)
      .post(`/businesses/${business._id}/bookings/${rescheduledId}/reschedule`)
      .set("Authorization", auth)
      .send({ startAt: businessLocalToUtc(TIMEZONE, "2030-08-22", "14:00").toISOString() });
    expect(rescheduleResponse.status).toBe(200);

    // Shapes the manual route cannot produce.
    const packageProgressId = new Types.ObjectId();
    const customer = await insertBooking({
      businessId: business._id,
      membershipId: membership._id,
      date: "2030-08-21",
      time: "12:00",
      noShowWindow: true,
    });
    const packageOrigin = await insertBooking({
      businessId: business._id,
      membershipId: membership._id,
      date: "2030-08-22",
      time: "09:00",
      line: { pricingMode: "PACKAGE", packageProgressId, sessionIndex: 1, sessionsInPackage: 3 },
    });
    const packageRedemption = await insertBooking({
      businessId: business._id,
      membershipId: membership._id,
      date: "2030-08-23",
      time: "09:00",
      line: { pricingMode: "PACKAGE", packageProgressId, sessionIndex: 2, sessionsInPackage: 3 },
    });
    const travel = await insertBooking({
      businessId: business._id,
      membershipId: membership._id,
      date: "2030-08-24",
      time: "15:00",
      travel: true,
    });

    const response = await getCalendar(
      business._id,
      auth,
      clientWindow(TIMEZONE, WEEK.first, WEEK.last),
    );

    expect(response.status).toBe(200);
    const entries = response.body.data.bookings as BookingCalendarEntryDto[];
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const expectedIds = [
      manualId,
      rescheduledId,
      String(customer._id),
      String(packageOrigin._id),
      String(packageRedemption._id),
      String(travel._id),
    ];
    expect([...byId.keys()].sort()).toEqual([...expectedIds].sort());
    expect(entries).toHaveLength(expectedIds.length); // the rescheduled booking appears once

    for (const id of expectedIds) {
      expect(byId.get(id)).toEqual(await fullDocumentDto(id));
      expect(byId.get(id)?.staffMembershipIds).toEqual([String(membership._id)]);
    }

    expect(byId.get(manualId)?.source).toBe("MANUAL");
    expect(byId.get(rescheduledId)?.schedule.startAt).toBe(
      businessLocalToUtc(TIMEZONE, "2030-08-22", "14:00").toISOString(),
    );
    expect(byId.get(String(packageOrigin._id))?.packageSessions).toEqual([
      { packageProgressId: String(packageProgressId), sessionIndex: 1, sessionsInPackage: 3 },
    ]);
    expect(byId.get(String(packageRedemption._id))?.packageSessions).toEqual([
      { packageProgressId: String(packageProgressId), sessionIndex: 2, sessionsInPackage: 3 },
    ]);
    expect(byId.get(String(customer._id))?.noShowEligibilitySnapshot).toEqual({
      opensAfterMinutes: 15,
      closesAfterMinutes: 1440,
      opensAt: businessLocalToUtc(TIMEZONE, "2030-08-21", "12:15").toISOString(),
      closesAt: businessLocalToUtc(TIMEZONE, "2030-08-22", "12:00").toISOString(),
    });
    // Ascending by start time, as the client renders it.
    const starts = entries.map((entry) => entry.schedule.startAt);
    expect(starts).toEqual([...starts].sort());
  });

  // --- C. Projection completeness ----------------------------------------------------------

  it("findManyForCalendar projects every field toBookingCalendarEntryDto reads", async () => {
    const { business } = await createBusiness();
    const { membership } = await createStaff(business._id);
    // Every optional mapper input populated: package identity, no-show window, staff snapshot.
    const booking = await insertBooking({
      businessId: business._id,
      membershipId: membership._id,
      date: "2030-08-21",
      time: "11:00",
      noShowWindow: true,
      line: {
        pricingMode: "PACKAGE",
        packageProgressId: new Types.ObjectId(),
        sessionIndex: 2,
        sessionsInPackage: 4,
      },
    });

    const [projected] = await new BookingRepository().findManyForCalendar(
      business._id,
      businessLocalToUtc(TIMEZONE, WEEK.first, "00:00"),
      businessLocalToUtc(TIMEZONE, WEEK.last, "23:59"),
    );
    if (!projected) throw new Error("the seeded booking must be inside the calendar range");

    expect(JSON.parse(JSON.stringify(toBookingCalendarEntryDto(projected)))).toEqual(
      await fullDocumentDto(booking._id),
    );
  });

  // --- D. Visible-week boundaries ----------------------------------------------------------

  for (const week of [WEEK, DST_WEEK]) {
    for (const browserTz of ["Europe/Nicosia", "Asia/Dhaka", "America/Los_Angeles"]) {
      it(`week ${week.first}..${week.last}, browser ${browserTz}: Monday 00:00 and Sunday 23:59 render; neighbours never do`, async () => {
        const { owner, business } = await createBusiness();
        const { membership } = await createStaff(business._id);
        const seed = (date: string, time: string) =>
          insertBooking({ businessId: business._id, membershipId: membership._id, date, time });

        const previousSunday = await seed(addCalendarDays(week.first, -1), "23:59");
        const mondayStart = await seed(week.first, "00:00");
        const sundayLate = await seed(week.last, "23:59");
        const nextMonday = await seed(addCalendarDays(week.last, 1), "00:00");

        const response = await getCalendar(
          business._id,
          await bearerFor(owner._id, "BUSINESS_OWNER"),
          clientWindow(browserTz, week.first, week.last),
        );

        expect(response.status).toBe(200);
        const entries = response.body.data.bookings as BookingCalendarEntryDto[];
        const visibleDates = new Set(enumerateCalendarDates(week.first, week.last));
        const rendered = entries.filter((entry) => visibleDates.has(renderedDateKey(entry)));
        const renderedKeyOf = (id: Types.ObjectId) => {
          const entry = rendered.find((candidate) => candidate.id === String(id));
          return entry ? renderedDateKey(entry) : undefined;
        };

        expect(rendered.map((entry) => entry.id).sort()).toEqual(
          [String(mondayStart._id), String(sundayLate._id)].sort(),
        );
        expect(renderedKeyOf(mondayStart._id)).toBe(week.first);
        expect(renderedKeyOf(sundayLate._id)).toBe(week.last);
        // The padding may fetch a neighbour, but it buckets outside the visible columns.
        for (const neighbour of [previousSunday, nextMonday]) {
          const fetched = entries.find((entry) => entry.id === String(neighbour._id));
          if (fetched) expect(visibleDates.has(renderedDateKey(fetched))).toBe(false);
        }
      });
    }
  }

  it("Today view on a Sunday: valid from < to window, Sunday 23:59 renders, next Monday does not", async () => {
    const { owner, business } = await createBusiness();
    const { membership } = await createStaff(business._id);
    const sundayLate = await insertBooking({
      businessId: business._id,
      membershipId: membership._id,
      date: WEEK.last,
      time: "23:59",
    });
    const nextMonday = await insertBooking({
      businessId: business._id,
      membershipId: membership._id,
      date: addCalendarDays(WEEK.last, 1),
      time: "00:00",
    });
    const query = clientWindow("Asia/Dhaka", WEEK.last, WEEK.last);

    const response = await getCalendar(
      business._id,
      await bearerFor(owner._id, "BUSINESS_OWNER"),
      query,
    );

    expect(response.status).toBe(200);
    const rendered = (response.body.data.bookings as BookingCalendarEntryDto[]).filter(
      (entry) => renderedDateKey(entry) === WEEK.last,
    );
    expect(rendered.map((entry) => entry.id)).toEqual([String(sundayLate._id)]);
    expect(rendered.some((entry) => entry.id === String(nextMonday._id))).toBe(false);
  });

  // --- Authorization is unchanged ------------------------------------------------------------

  it("an active Supervisor reads the same calendar; another Business's Owner cannot", async () => {
    const { owner, business } = await createBusiness();
    const { user: supervisor, membership } = await createStaff(business._id, "SUPERVISOR");
    const booking = await insertBooking({
      businessId: business._id,
      membershipId: membership._id,
      date: "2030-08-21",
      time: "10:00",
    });
    const { owner: foreignOwner } = await createBusiness();
    const query = clientWindow(TIMEZONE, WEEK.first, WEEK.last);

    const asOwner = await getCalendar(
      business._id,
      await bearerFor(owner._id, "BUSINESS_OWNER"),
      query,
    );
    const asSupervisor = await getCalendar(
      business._id,
      await bearerFor(supervisor._id, "SUPERVISOR"),
      query,
    );
    const asForeignOwner = await getCalendar(
      business._id,
      await bearerFor(foreignOwner._id, "BUSINESS_OWNER"),
      query,
    );

    expect(asOwner.status).toBe(200);
    expect(asOwner.body.data.bookings.map((entry: BookingCalendarEntryDto) => entry.id)).toEqual([
      String(booking._id),
    ]);
    expect(asSupervisor.status).toBe(200);
    expect(asSupervisor.body.data.bookings).toEqual(asOwner.body.data.bookings);
    expect(asForeignOwner.status).toBe(404);
    expect(asForeignOwner.body.data).toBeUndefined();
  });
});
