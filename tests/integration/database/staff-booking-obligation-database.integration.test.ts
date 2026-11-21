import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { businessLocalToUtc } from "../../../src/common/time/business-clock.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { createBusinessBookingRoute } from "../../../src/modules/booking/booking.route.js";
import type { BookingStatus } from "../../../src/modules/booking/booking.types.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { createBusinessRoute } from "../../../src/modules/business/business.route.js";
import { BusinessHoursRepository } from "../../../src/modules/business-hours/business-hours.repository.js";
import { BusinessHoursService } from "../../../src/modules/business-hours/business-hours.service.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
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
 * Fix #6 — a professional with an unresolved appointment can be neither removed nor
 * deactivated. Exercised through the real Business (Owner-only Staff) and Booking routes on an
 * isolated replica set. Bookings are created at explicit 2030 instants; "started" and other
 * persisted shapes are set directly on the authoritative Booking document.
 */
const TIMEZONE = "Europe/Nicosia";
const DATE = "2030-08-20"; // Tuesday

describe("Fix #6 — Staff removal/deactivation with unresolved appointments", () => {
  const users = new UserRepository();
  const businesses = new BusinessRepository();
  const services = new ServiceRepository();
  const staffRepository = new StaffRepository();
  const schedules = new StaffScheduleRepository();
  const clients = new ClientRepository();
  let tokens: TokenService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);
  beforeEach(async () => {
    await clearIsolatedDatabase();
    tokens = new TokenService(new SessionRepository());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const app = () => {
    const server = express();
    server.use(express.json());
    // Same order as api-router: Booking routes before the Owner-only Business router.
    server.use("/businesses", createBusinessBookingRoute());
    server.use("/businesses", createBusinessRoute());
    server.use(createErrorHandler({ isProduction: true }));
    return server;
  };
  const bearer = async (
    userId: Types.ObjectId,
    role: "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF" | "CUSTOMER",
  ) => `Bearer ${await issueTestAccessToken(tokens, { userId, role })}`;

  const days = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] as const;
  const member = async (businessId: Types.ObjectId, role: "STAFF" | "SUPERVISOR" = "STAFF") => {
    const user = await users.create({
      normalizedEmail: `${role.toLowerCase()}-${new Types.ObjectId()}@example.com`,
      passwordHash: "hash",
      role,
      status: "ACTIVE",
    });
    await users.createProfile({
      userId: user._id,
      firstName: "Pro",
      lastName: role,
      gender: "other",
    });
    const membership = await staffRepository.create({
      userId: user._id,
      businessId,
      role,
      createdByUserId: user._id,
    });
    await schedules.replace(
      membership._id,
      businessId,
      days.map((dayOfWeek) => ({
        dayOfWeek,
        intervals: [{ startTime: "09:00", endTime: "18:00" }],
      })),
    );
    return { user, membership };
  };

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
      name: "Staff Salon",
      ownerName: "Owner",
      email,
      phone: { countryCode: "+357", nationalNumber: "99112233", e164: "+35799112233" },
      visitType: "AT_BUSINESS_LOCATION",
      timezone: TIMEZONE,
      address: { city: "Larnaca", area: "Center", streetName: "Main", streetNumber: "1" },
      briefDescription: "Fixture",
      category: "Barber",
      subcategories: ["Haircut"],
    });
    const business =
      (await businesses.casUpdateStatus(pending._id, ["PENDING"], "APPROVED", {
        fromStatus: "PENDING",
        actorUserId: owner._id,
        changedAt: new Date(),
      })) ?? pending;
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
    const pro = await member(business._id);
    const other = await member(business._id);
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
      assignedStaffMembershipIds: [pro.membership._id, other.membership._id],
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
    const book = (staffId: Types.ObjectId, time = "10:00") =>
      request(server)
        .post(`/businesses/${business._id}/bookings`)
        .set("Authorization", ownerAuth)
        .send({
          serviceLines: [
            {
              serviceId: String(service._id),
              staffMembershipId: String(staffId),
              addonIds: [],
              pricingInput: {},
            },
          ],
          startAt: businessLocalToUtc(TIMEZONE, DATE, time).toISOString(),
          businessClientId: String(client._id),
          idempotencyKey: `k-${new Types.ObjectId()}`,
        });
    const staffPath = (staffId: Types.ObjectId) => `/businesses/${business._id}/staff/${staffId}`;
    const remove = (staffId: Types.ObjectId, auth = ownerAuth) =>
      request(server).delete(staffPath(staffId)).set("Authorization", auth);
    const patch = (staffId: Types.ObjectId, body: object, auth = ownerAuth) =>
      request(server).patch(staffPath(staffId)).set("Authorization", auth).send(body);
    return { owner, business, pro, other, service, client, server, ownerAuth, book, remove, patch };
  };

  const membership = (id: Types.ObjectId) => StaffMembershipModel.findById(id).orFail().lean();
  const expectBlocked = (response: request.Response) => {
    expect(response.status).toBe(409);
    expect(response.body.errors[0].code).toBe("STAFF_REMOVAL_BLOCKED_BY_BOOKINGS");
    expect(response.body.message).toBe(
      "This staff member has active or upcoming bookings. Resolve or reassign these appointments before removing the staff member.",
    );
  };
  const setStatus = (id: string, status: BookingStatus) =>
    BookingModel.updateOne({ _id: id }, { $set: { status } }).exec();

  it("a professional with no unresolved appointment can be removed", async () => {
    const f = await setup();
    await f.book(f.other.membership._id).expect(201); // someone else's appointment never blocks
    await f.remove(f.pro.membership._id).expect(200);
    expect((await membership(f.pro.membership._id)).removedAt).toBeInstanceOf(Date);
  });

  it("an upcoming (manual) appointment blocks removal and deactivation; the professional stays active and the Booking is untouched", async () => {
    const f = await setup();
    const created = await f.book(f.pro.membership._id).expect(201);
    const before = await BookingModel.findById(created.body.data.id).orFail().lean();
    expectBlocked(await f.remove(f.pro.membership._id));
    expectBlocked(await f.patch(f.pro.membership._id, { employmentActive: false }));
    expect(await membership(f.pro.membership._id)).toMatchObject({ employmentActive: true });
    expect((await membership(f.pro.membership._id)).removedAt).toBeUndefined();
    expect(await BookingModel.findById(created.body.data.id).orFail().lean()).toEqual(before);
  });

  it("every persisted appointment shape and unresolved state blocks; terminal history does not", async () => {
    const f = await setup();
    const created = await f.book(f.pro.membership._id).expect(201);
    const id = created.body.data.id as string;
    const shapes: Array<[string, Record<string, unknown>]> = [
      ["normal Bookly-managed", { source: "BOOKLY_MANAGED" }],
      [
        "Legacy Package session",
        {
          "serviceLines.0.pricingInput.packageProgressId": new Types.ObjectId(),
          "serviceLines.0.pricingInput.sessionIndex": 2,
        },
      ],
      [
        "started but unresolved",
        {
          "schedule.startAt": new Date(Date.now() - 3_600_000),
          "schedule.endAt": new Date(Date.now() - 1_800_000),
        },
      ],
    ];
    for (const [label, patch] of shapes) {
      await BookingModel.updateOne({ _id: id }, { $set: patch }).exec();
      const response = await f.remove(f.pro.membership._id);
      expect({ label, status: response.status }).toEqual({ label, status: 409 });
    }
    await setStatus(id, "PENDING"); // no-show under review still needs its provider
    expectBlocked(await f.remove(f.pro.membership._id));
    for (const terminal of [
      "COMPLETED",
      "CANCELLED_BY_CUSTOMER",
      "CANCELLED_BY_BUSINESS",
      "LATE_CANCELLATION",
      "NO_SHOW_CHARGED",
      "NO_SHOW_WAIVED",
      "NO_SHOW_CANCELLED",
    ] as const) {
      await setStatus(id, terminal);
      await f.patch(f.pro.membership._id, { employmentActive: false }).expect(200);
      await f.patch(f.pro.membership._id, { employmentActive: true }).expect(200);
    }
    await f.remove(f.pro.membership._id).expect(200);
  }, 30_000);

  it("a group appointment blocks only its assigned provider", async () => {
    const f = await setup();
    const created = await f.book(f.pro.membership._id).expect(201);
    const booking = await BookingModel.findById(created.body.data.id).orFail();
    const line = booking.toObject().serviceLines[0];
    await BookingModel.updateOne(
      { _id: booking._id },
      {
        $push: { serviceLines: { ...line, responsibleStaffMembershipId: f.other.membership._id } },
      },
    ).exec();
    expectBlocked(await f.remove(f.other.membership._id));
    expectBlocked(await f.remove(f.pro.membership._id));
  });

  it("a rescheduled appointment keeps blocking; cancellation resolves it and removal then preserves the historical identity", async () => {
    const f = await setup();
    const created = await f.book(f.pro.membership._id).expect(201);
    const base = `/businesses/${f.business._id}/bookings/${created.body.data.id}`;
    await request(f.server)
      .post(`${base}/reschedule`)
      .set("Authorization", f.ownerAuth)
      .send({ startAt: businessLocalToUtc(TIMEZONE, DATE, "14:00").toISOString() })
      .expect(200);
    expectBlocked(await f.remove(f.pro.membership._id));
    await request(f.server)
      .post(`${base}/cancel`)
      .set("Authorization", f.ownerAuth)
      .send({})
      .expect(200);
    const history = await BookingModel.findById(created.body.data.id).orFail().lean();
    await f.remove(f.pro.membership._id).expect(200);
    const after = await BookingModel.findById(created.body.data.id).orFail().lean();
    expect(after.serviceLines[0]?.responsibleStaffMembershipId).toEqual(f.pro.membership._id);
    expect(after.serviceLines[0]?.staffSnapshot).toEqual(history.serviceLines[0]?.staffSnapshot);
    expect(after).toEqual(history);
  });

  it("a role change keeps the professional eligible, so it is not blocked and the appointment stays fulfillable", async () => {
    const f = await setup();
    const created = await f.book(f.pro.membership._id).expect(201);
    await f.patch(f.pro.membership._id, { role: "SUPERVISOR" }).expect(200);
    await request(f.server)
      .post(`/businesses/${f.business._id}/bookings/${created.body.data.id}/reschedule`)
      .set("Authorization", f.ownerAuth)
      .send({ startAt: businessLocalToUtc(TIMEZONE, DATE, "15:00").toISOString() })
      .expect(200);
    await f.patch(f.pro.membership._id, { role: "STAFF" }).expect(200);
    expectBlocked(await f.remove(f.pro.membership._id));
  });

  it("an inactive professional (deactivated before this guard) with an appointment still cannot be removed", async () => {
    const f = await setup();
    await f.book(f.pro.membership._id).expect(201);
    await StaffMembershipModel.updateOne(
      { _id: f.pro.membership._id },
      { $set: { employmentActive: false } },
    ).exec();
    expectBlocked(await f.remove(f.pro.membership._id));
    await f.patch(f.pro.membership._id, { employmentActive: false }).expect(200); // no-op, never newly blocked
  });

  it("authorization is decided before any scheduling information", async () => {
    const f = await setup();
    await f.book(f.pro.membership._id).expect(201);
    const outsider = await setup();
    const supervisor = await member(f.business._id, "SUPERVISOR");
    const customer = await users.create({
      normalizedEmail: `c-${new Types.ObjectId()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    for (const [auth, status] of [
      [await bearer(outsider.owner._id, "BUSINESS_OWNER"), 404],
      [await bearer(supervisor.user._id, "SUPERVISOR"), 403],
      [await bearer(f.other.user._id, "STAFF"), 403],
      [await bearer(customer._id, "CUSTOMER"), 403],
    ] as const) {
      for (const response of [
        await f.remove(f.pro.membership._id, auth),
        await f.patch(f.pro.membership._id, { employmentActive: false }, auth),
      ]) {
        expect(response.status).toBe(status);
        expect(JSON.stringify(response.body)).not.toMatch(/bookings|appointment/i);
      }
    }
    expect(await membership(f.pro.membership._id)).toMatchObject({ employmentActive: true });
  });

  describe("concurrency", () => {
    it("removal holding the fence first: a racing booking is refused, never orphaned", async () => {
      const f = await setup();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached!: () => void;
      const inside = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const original = StaffRepository.prototype.softRemoveById;
      vi.spyOn(StaffRepository.prototype, "softRemoveById").mockImplementationOnce(async function (
        this: StaffRepository,
        ...args
      ) {
        reached();
        await gate; // the removal transaction already holds the Business fence and passed its checks
        return original.apply(this, args);
      });
      const removal = f.remove(f.pro.membership._id);
      const removalDone = removal.then((r) => r);
      await inside;
      const booking = f.book(f.pro.membership._id).then((r) => r);
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      const [removed, booked] = await Promise.all([removalDone, booking]);
      expect(removed.status).toBe(200);
      expect(booked.status).toBe(409);
      expect(booked.body.errors[0].code).toBe("BOOKING_STAFF_NOT_ELIGIBLE");
      expect(
        await BookingModel.countDocuments({
          "serviceLines.responsibleStaffMembershipId": f.pro.membership._id,
        }),
      ).toBe(0);
    }, 60_000);

    it("booking committed first: the later removal and deactivation see it and are refused", async () => {
      const f = await setup();
      await f.book(f.pro.membership._id).expect(201);
      const [removed, deactivated] = await Promise.all([
        f.remove(f.pro.membership._id),
        f.patch(f.pro.membership._id, { employmentActive: false }),
      ]);
      expectBlocked(removed);
      expectBlocked(deactivated);
    });

    it("parallel bookings and removals never leave an unresolved appointment on a removed professional", async () => {
      for (let round = 0; round < 3; round += 1) {
        await clearIsolatedDatabase();
        const f = await setup();
        const results = await Promise.all([
          f.book(f.pro.membership._id, "10:00"),
          f.remove(f.pro.membership._id),
          f.book(f.pro.membership._id, "12:00"),
          f.patch(f.pro.membership._id, { employmentActive: false }),
        ]);
        for (const r of results) expect([200, 201, 404, 409]).toContain(r.status);
        const state = await membership(f.pro.membership._id);
        const unresolved = await BookingModel.countDocuments({
          "serviceLines.responsibleStaffMembershipId": f.pro.membership._id,
          status: { $in: ["UPCOMING", "PENDING"] },
        });
        if (state.removedAt || !state.employmentActive) expect(unresolved).toBe(0);
      }
    }, 120_000);

    it("concurrent removal and deactivation of an unbooked professional end in one consistent state", async () => {
      const f = await setup();
      const [removed, deactivated] = await Promise.all([
        f.remove(f.pro.membership._id),
        f.patch(f.pro.membership._id, { employmentActive: false }),
      ]);
      expect([200, 404]).toContain(removed.status);
      expect([200, 404]).toContain(deactivated.status);
      const state = await membership(f.pro.membership._id);
      expect(state.employmentActive).toBe(false);
    });
  });
});
