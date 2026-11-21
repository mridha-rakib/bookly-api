import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { businessLocalToUtc } from "../../../src/common/time/business-clock.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { createBusinessBookingRoute } from "../../../src/modules/booking/booking.route.js";
import { BookingFinancialTransactionModel } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessHoursRepository } from "../../../src/modules/business-hours/business-hours.repository.js";
import { BusinessHoursService } from "../../../src/modules/business-hours/business-hours.service.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { PaymentAttemptModel } from "../../../src/modules/payment/payment-attempt.model.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffMembershipModel } from "../../../src/modules/staff/staff.model.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * Fix #5 — server-side start-time boundaries for completion and no-show, exercised through the
 * real Business Booking routes with a deterministic clock (`Date` only is faked; timers and the
 * database stay real). This file deliberately does NOT install the started-appointment fixture
 * helper used by older suites.
 */
const TIMEZONE = "Europe/Nicosia";
const DATE = "2030-08-20"; // Tuesday
const START = businessLocalToUtc(TIMEZONE, DATE, "10:00");
const MINUTE = 60_000;

describe("Fix #5 — completion and no-show time boundaries", () => {
  const users = new UserRepository();
  const businesses = new BusinessRepository();
  const services = new ServiceRepository();
  const staff = new StaffRepository();
  const schedules = new StaffScheduleRepository();
  const clients = new ClientRepository();
  let tokens: TokenService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);
  beforeEach(async () => {
    vi.useRealTimers();
    await clearIsolatedDatabase();
    tokens = new TokenService(new SessionRepository());
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const at = (instant: Date | number) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant);
  };

  const app = () => {
    const server = express();
    server.use(express.json());
    server.use("/businesses", createBusinessBookingRoute());
    server.use(createErrorHandler({ isProduction: true }));
    return server;
  };

  const bearer = async (
    userId: Types.ObjectId,
    role: "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF" | "CUSTOMER",
  ) => `Bearer ${await issueTestAccessToken(tokens, { userId, role })}`;

  const member = async (businessId: Types.ObjectId, role: "STAFF" | "SUPERVISOR") => {
    const user = await users.create({
      normalizedEmail: `${role.toLowerCase()}-${new Types.ObjectId()}@example.com`,
      passwordHash: "hash",
      role,
      status: "ACTIVE",
    });
    await users.createProfile({
      userId: user._id,
      firstName: "T",
      lastName: role,
      gender: "other",
    });
    const membership = await staff.create({
      userId: user._id,
      businessId,
      role,
      createdByUserId: user._id,
    });
    return { user, membership };
  };

  /** An approved Business with one bookable Staff member and one manual Booking at START. */
  const setup = async () => {
    const email = `owner-${new Types.ObjectId()}@example.com`;
    const owner = await users.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const pending = await businesses.create({
      ownerUserId: owner._id,
      name: "Time Salon",
      ownerName: "Owner",
      email,
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: "AT_BUSINESS_LOCATION",
      timezone: TIMEZONE,
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "Boundary fixture",
      category: "Barber",
      subcategories: ["Haircut"],
    });
    const business =
      (await businesses.casUpdateStatus(pending._id, ["PENDING"], "APPROVED", {
        fromStatus: "PENDING",
        actorUserId: owner._id,
        changedAt: new Date(),
      })) ?? pending;
    const worker = await member(business._id, "STAFF");
    const days = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] as const;
    await new BusinessHoursService(new BusinessHoursRepository(), businesses).putOpeningHours(
      String(owner._id),
      String(business._id),
      [
        ...days.map((dayOfWeek) => ({
          dayOfWeek,
          isOpen: true,
          slots: [{ startTime: "09:00", endTime: "18:00" }],
        })),
        { dayOfWeek: "SATURDAY", isOpen: false, slots: [] },
        { dayOfWeek: "SUNDAY", isOpen: false, slots: [] },
      ],
    );
    await schedules.replace(
      worker.membership._id,
      business._id,
      days.map((dayOfWeek) => ({
        dayOfWeek,
        intervals: [{ startTime: "09:00", endTime: "18:00" }],
      })),
    );
    const service = await services.create({
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
      assignedStaffMembershipIds: [worker.membership._id],
    });
    const client = await clients.create({
      businessId: business._id,
      createdByUserId: owner._id,
      firstName: "Walk",
      lastName: "In",
      normalizedEmail: `walkin-${new Types.ObjectId()}@example.com`,
      phone: { countryCode: "+357", nationalNumber: "99887766", e164: "+35799887766" },
      address: {
        city: "Larnaca",
        propertyType: "House",
        area: "Center",
        streetName: "Main",
        streetNumber: "1",
      },
      linkState: "UNLINKED",
    });
    const server = app();
    const ownerAuth = await bearer(owner._id, "BUSINESS_OWNER");
    const created = await request(server)
      .post(`/businesses/${business._id}/bookings`)
      .set("Authorization", ownerAuth)
      .send({
        serviceLines: [
          {
            serviceId: String(service._id),
            staffMembershipId: String(worker.membership._id),
            addonIds: [],
            pricingInput: {},
          },
        ],
        startAt: START.toISOString(),
        businessClientId: String(client._id),
        idempotencyKey: `t-${new Types.ObjectId()}`,
      })
      .expect(201);
    const id = created.body.data.id as string;
    const base = `/businesses/${business._id}/bookings/${id}`;
    return { owner, business, worker, service, client, server, id, base };
  };

  /** Legacy = no category snapshot; window = an explicit snapshot with known boundaries. */
  const asLegacy = (id: string) =>
    BookingModel.updateOne({ _id: id }, { $unset: { noShowEligibilitySnapshot: "" } }).exec();
  const withWindow = (id: string, opensAfterMinutes: number, closesAfterMinutes: number) =>
    BookingModel.updateOne(
      { _id: id },
      {
        $set: {
          noShowEligibilitySnapshot: {
            categoryKey: "barber",
            opensAfterMinutes,
            closesAfterMinutes,
          },
        },
      },
    ).exec();

  const sideEffects = async (id: string) => {
    const booking = await BookingModel.findById(id).orFail().lean();
    return {
      status: booking.status,
      completionPayment: booking.completionPayment ?? null,
      noShowStartedAt: booking.noShowStartedAt ?? null,
      events: booking.eventHistory.length,
      ledger: await BookingFinancialTransactionModel.countDocuments({ bookingId: booking._id }),
      attempts: await PaymentAttemptModel.countDocuments({}),
    };
  };

  describe("completion", () => {
    it("is refused one millisecond before start, with no venue payment or other effect", async () => {
      const f = await setup();
      const before = await sideEffects(f.id);
      at(START.getTime() - 1);
      const auth = await bearer(f.owner._id, "BUSINESS_OWNER");
      const refused = await request(f.server)
        .post(`${f.base}/complete`)
        .set("Authorization", auth)
        .send({ venuePayment: { settlement: "FULL" } })
        .expect(409);
      expect(refused.body.errors[0].code).toBe("BOOKING_COMPLETION_TOO_EARLY");
      expect(refused.body.message).toContain("has not started yet");
      expect(await sideEffects(f.id)).toEqual(before);
    });

    it("is allowed exactly at the start boundary and records the venue payment", async () => {
      const f = await setup();
      at(START);
      const auth = await bearer(f.owner._id, "BUSINESS_OWNER");
      const done = await request(f.server)
        .post(`${f.base}/complete`)
        .set("Authorization", auth)
        .send({ venuePayment: { settlement: "PARTIAL", amountCents: 2500 } })
        .expect(200);
      expect(done.body.data.status).toBe("COMPLETED");
      expect((await sideEffects(f.id)).completionPayment).toMatchObject({
        paid: true,
        amountCents: 2500,
      });
    });

    it("is allowed after start without waiting for the scheduled end", async () => {
      const f = await setup();
      at(START.getTime() + 5 * MINUTE); // the appointment runs until +60 minutes
      const auth = await bearer(f.owner._id, "BUSINESS_OWNER");
      await request(f.server)
        .post(`${f.base}/complete`)
        .set("Authorization", auth)
        .send({})
        .expect(200);
    });

    it("uses the rescheduled authoritative start", async () => {
      const f = await setup();
      const ownerAuth = await bearer(f.owner._id, "BUSINESS_OWNER");
      const later = businessLocalToUtc(TIMEZONE, DATE, "14:00");
      await request(f.server)
        .post(`${f.base}/reschedule`)
        .set("Authorization", ownerAuth)
        .send({ startAt: later.toISOString() })
        .expect(200);
      at(START.getTime() + 30 * MINUTE); // after the ORIGINAL start, before the new one
      const auth = await bearer(f.owner._id, "BUSINESS_OWNER");
      const refused = await request(f.server)
        .post(`${f.base}/complete`)
        .set("Authorization", auth)
        .send({})
        .expect(409);
      expect(refused.body.errors[0].code).toBe("BOOKING_COMPLETION_TOO_EARLY");
      at(later);
      const laterAuth = await bearer(f.owner._id, "BUSINESS_OWNER");
      await request(f.server)
        .post(`${f.base}/complete`)
        .set("Authorization", laterAuth)
        .send({})
        .expect(200);
    });

    it("concurrent and duplicate completions after start commit exactly once", async () => {
      const f = await setup();
      at(START.getTime() + MINUTE);
      const auth = await bearer(f.owner._id, "BUSINESS_OWNER");
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(f.server)
            .post(`${f.base}/complete`)
            .set("Authorization", auth)
            .send({ venuePayment: { settlement: "FULL" } }),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
      expect(
        await BookingFinancialTransactionModel.countDocuments({
          idempotencyKey: `venue-payment:${f.id}`,
        }),
      ).toBe(1);
    });

    it("concurrent early completions are all refused", async () => {
      const f = await setup();
      at(START.getTime() - MINUTE);
      const auth = await bearer(f.owner._id, "BUSINESS_OWNER");
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          request(f.server).post(`${f.base}/complete`).set("Authorization", auth).send({}),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([409, 409, 409]);
      expect((await sideEffects(f.id)).status).toBe("UPCOMING");
    });
  });

  describe("no-show", () => {
    it("legacy booking: refused before start, allowed at start, with no closing bound", async () => {
      const f = await setup();
      await asLegacy(f.id);
      const before = await sideEffects(f.id);
      at(START.getTime() - 1);
      let auth = await bearer(f.owner._id, "BUSINESS_OWNER");
      const refused = await request(f.server)
        .post(`${f.base}/no-show`)
        .set("Authorization", auth)
        .send({})
        .expect(409);
      expect(refused.body.errors[0].code).toBe("BOOKING_NO_SHOW_BEFORE_START");
      expect(await sideEffects(f.id)).toEqual(before);

      at(START);
      auth = await bearer(f.owner._id, "BUSINESS_OWNER");
      const marked = await request(f.server)
        .post(`${f.base}/no-show`)
        .set("Authorization", auth)
        .send({})
        .expect(200);
      expect(marked.body.data.status).toBe("PENDING");
      // The existing 90-minute resolution deadline still starts at the mark instant.
      expect(Date.parse(marked.body.data.noShowDeadlineAt) - START.getTime()).toBe(90 * MINUTE);
    });

    it("legacy booking long after start stays markable (no invented maximum window)", async () => {
      const f = await setup();
      await asLegacy(f.id);
      at(START.getTime() + 30 * 24 * 60 * MINUTE);
      const auth = await bearer(f.owner._id, "BUSINESS_OWNER");
      await request(f.server)
        .post(`${f.base}/no-show`)
        .set("Authorization", auth)
        .send({})
        .expect(200);
    });

    it("category window keeps its own grace period and opening/closing boundaries", async () => {
      for (const [offset, status, code] of [
        [0, 409, "BOOKING_NO_SHOW_WINDOW_NOT_OPEN"], // started, but inside the 15-minute grace period
        [15 * MINUTE - 1, 409, "BOOKING_NO_SHOW_WINDOW_NOT_OPEN"],
        [120 * MINUTE, 409, "BOOKING_NO_SHOW_WINDOW_CLOSED"], // close is exclusive
        [15 * MINUTE, 200, undefined], // open is inclusive
      ] as const) {
        vi.useRealTimers();
        await clearIsolatedDatabase();
        const f = await setup();
        await withWindow(f.id, 15, 120);
        at(START.getTime() + offset);
        const auth = await bearer(f.owner._id, "BUSINESS_OWNER");
        const response = await request(f.server)
          .post(`${f.base}/no-show`)
          .set("Authorization", auth)
          .send({});
        expect({ offset, status: response.status, code: response.body.errors?.[0]?.code }).toEqual({
          offset,
          status,
          code,
        });
      }
    });

    it("concurrent no-show marks after start commit exactly once", async () => {
      const f = await setup();
      await asLegacy(f.id);
      at(START.getTime() + MINUTE);
      const auth = await bearer(f.owner._id, "BUSINESS_OWNER");
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          request(f.server).post(`${f.base}/no-show`).set("Authorization", auth).send({}),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const booking = await BookingModel.findById(f.id).orFail().lean();
      expect(booking.eventHistory.filter((e) => e.nextStatus === "PENDING")).toHaveLength(1);
    });
  });

  describe("authorization is decided before any time answer", () => {
    it("unrelated Owner, inactive Supervisor, Staff and Customer are refused even early, without disclosing timing", async () => {
      const f = await setup();
      await asLegacy(f.id);
      const outsider = await setup();
      const inactive = await member(f.business._id, "SUPERVISOR");
      await StaffMembershipModel.updateOne(
        { _id: inactive.membership._id },
        { $set: { employmentActive: false } },
      ).exec();
      const active = await member(f.business._id, "SUPERVISOR");
      const customer = await users.create({
        normalizedEmail: `c-${new Types.ObjectId()}@example.com`,
        passwordHash: "hash",
        role: "CUSTOMER",
        status: "ACTIVE",
      });
      const before = await sideEffects(f.id);
      at(START.getTime() - MINUTE);
      for (const action of ["complete", "no-show"]) {
        for (const [auth, status] of [
          [await bearer(outsider.owner._id, "BUSINESS_OWNER"), 404],
          [await bearer(inactive.user._id, "SUPERVISOR"), 404],
          [await bearer(f.worker.user._id, "STAFF"), 403],
          [await bearer(customer._id, "CUSTOMER"), 403],
        ] as const) {
          const response = await request(f.server)
            .post(`${f.base}/${action}`)
            .set("Authorization", auth)
            .send({});
          expect({ action, status: response.status }).toEqual({ action, status });
          expect(JSON.stringify(response.body)).not.toMatch(
            /not started|NO_SHOW_BEFORE_START|TOO_EARLY/,
          );
        }
      }
      // An active Supervisor is authorized and receives the time answer.
      const supervisorAuth = await bearer(active.user._id, "SUPERVISOR");
      const early = await request(f.server)
        .post(`${f.base}/complete`)
        .set("Authorization", supervisorAuth)
        .send({})
        .expect(409);
      expect(early.body.errors[0].code).toBe("BOOKING_COMPLETION_TOO_EARLY");
      expect(await sideEffects(f.id)).toEqual(before);
      at(START);
      await request(f.server)
        .post(`${f.base}/complete`)
        .set("Authorization", await bearer(active.user._id, "SUPERVISOR"))
        .send({})
        .expect(200);
    });
  });
});
