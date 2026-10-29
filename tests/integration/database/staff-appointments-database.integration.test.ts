import express from "express";
import mongoose, { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BusinessClientModel } from "../../../src/modules/client/client.model.js";
import { PackageProgressV2Model } from "../../../src/modules/package-progress/package-progress-v2.model.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffMembershipModel } from "../../../src/modules/staff/staff.model.js";
import { createStaffScheduleRoute } from "../../../src/modules/staff/staff.route.js";
import { UserModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import type { UserRole } from "../../../src/modules/user/user.types.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import { buildBooking } from "../../unit/stage-b-fixtures.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

// P4C-1 — Owner decision D-S1: Staff READ their own currently assigned appointments only.
// Real route, real access-token sessions, real authenticate/requireRoles middleware.

describe("P4C-1 Staff read-only appointments", () => {
  let tokenService: TokenService;
  let users: UserRepository;
  const app = express();

  beforeAll(async () => {
    await connectIsolatedDatabase();
    tokenService = new TokenService(new SessionRepository());
    users = new UserRepository();
    app.use(express.json());
    app.use("/businesses", createStaffScheduleRoute());
    app.use(createErrorHandler({ isProduction: true }));
  }, 120_000);
  beforeEach(async () => {
    await clearIsolatedDatabase();
  });
  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const businessA = new Types.ObjectId();
  const businessB = new Types.ObjectId();
  const ownerId = new Types.ObjectId();
  const soon = (hours: number) => new Date(Date.now() + hours * 3_600_000);

  const user = async (role: UserRole = "STAFF") =>
    users.create({
      normalizedEmail: `${role.toLowerCase()}-${new Types.ObjectId().toHexString()}@example.com`,
      passwordHash: "hash",
      role,
      status: "ACTIVE",
    });
  const member = async (
    userId: Types.ObjectId,
    businessId = businessA,
    overrides: Record<string, unknown> = {},
  ) =>
    StaffMembershipModel.create({
      userId,
      businessId,
      role: "STAFF",
      employmentActive: true,
      createdByUserId: ownerId,
      ...overrides,
    });
  const staff = async (businessId = businessA) => {
    const account = await user();
    const membership = await member(account._id, businessId);
    const bearer = `Bearer ${await issueTestAccessToken(tokenService, { userId: account._id, role: "STAFF" })}`;
    return { account, membership, bearer };
  };
  const uniqueReference = () => `BK-${new Types.ObjectId().toHexString().slice(-8).toUpperCase()}`;
  const booking = async (
    membershipId: Types.ObjectId,
    overrides: Record<string, unknown> = {},
    businessId = businessA,
  ) => {
    const doc = buildBooking({
      businessId,
      reference: uniqueReference(),
      schedule: { timezone: "Europe/Nicosia", startAt: soon(26), endAt: soon(27) },
      notes: "door code 1234 — private",
      ...overrides,
    } as never);
    doc.serviceLines[0]!.responsibleStaffMembershipId = membershipId;
    await BookingModel.collection.insertOne(doc as never);
    return doc;
  };
  const list = (businessId: Types.ObjectId, bearer?: string, query = "") => {
    const call = request(app).get(
      `/businesses/${businessId.toHexString()}/staff/me/appointments${query}`,
    );
    return bearer ? call.set("Authorization", bearer) : call;
  };
  const detail = (businessId: Types.ObjectId, bookingId: Types.ObjectId, bearer: string) =>
    request(app)
      .get(
        `/businesses/${businessId.toHexString()}/staff/me/appointments/${bookingId.toHexString()}`,
      )
      .set("Authorization", bearer);

  const destination = {
    city: "Larnaca",
    area: "Center",
    streetName: "Destination Street",
    streetNumber: "42",
    floorUnit: "3",
    aptRoom: "7",
  };
  const travel = {
    mode: "TRAVEL_TO_CUSTOMER",
    travelAddress: {
      ...destination,
      propertyType: "APARTMENT",
      additionalDirections: "private gate code 9876",
      location: { lat: 34.9, lng: 33.6 },
    },
  };

  it("D-S2 discloses only the assigned operational destination in detail, never in the list", async () => {
    const me = await staff();
    const mine = await booking(me.membership._id, { fulfilment: travel });
    const rows = await list(businessA, me.bearer);
    expect(JSON.stringify(rows.body)).not.toContain("Destination Street");
    expect(JSON.stringify(rows.body)).not.toContain("travelAddress");
    const response = await detail(businessA, mine._id, me.bearer);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body.data.travelAddress).toEqual(destination);
    expect(response.body.data.services).toHaveLength(1);
    for (const secret of [
      "additionalDirections",
      "9876",
      "propertyType",
      "location",
      "normalizedEmail",
      "phone",
      "notes",
      "financials",
      "financialContract",
      "packageProgressId",
      "paymentIntent",
      "amountCents",
    ])
      expect(JSON.stringify(response.body.data)).not.toContain(secret);
    const stranger = await staff();
    const foreign = await staff(businessB);
    for (const bearer of [stranger.bearer, foreign.bearer]) {
      const denied = await detail(businessA, mine._id, bearer);
      expect(denied.status).toBe(404);
      expect(denied.headers["cache-control"]).toBe("private, no-store");
      expect(JSON.stringify(denied.body)).not.toContain("Destination Street");
    }
  });

  it("D-S2 uses the shared canonical travel mode for each currently assigned line", async () => {
    const me = await staff();
    const colleague = await staff();
    const mine = await booking(me.membership._id, { fulfilment: travel });
    const otherLine = {
      ...mine.serviceLines[0]!,
      responsibleStaffMembershipId: colleague.membership._id,
      serviceSnapshot: { name: "Other travel service", pricingMode: "FIXED", durationMin: 45 },
    };
    await BookingModel.collection.updateOne({ _id: mine._id }, {
      $push: { serviceLines: otherLine },
    } as never);
    for (const bearer of [me.bearer, colleague.bearer]) {
      const response = await detail(businessA, mine._id, bearer);
      expect(response.body.data.travelAddress).toEqual(destination);
      expect(response.body.data.services).toHaveLength(1);
    }
    // Canonical schema has no per-line delivery modes. Contradictory Booking snapshots must
    // fail closed instead of guessing which line owns which location.
    await BookingModel.collection.updateOne(
      { _id: mine._id },
      {
        $set: {
          "fulfilment.businessLocation": {
            city: "Larnaca",
            area: "Venue",
            streetName: "Venue",
            streetNumber: "1",
          },
        },
      },
    );
    expect((await detail(businessA, mine._id, me.bearer)).body.data).not.toHaveProperty(
      "travelAddress",
    );
  });

  it.each([
    "COMPLETED",
    "PENDING",
    "NO_SHOW_CHARGED",
    "NO_SHOW_WAIVED",
    "NO_SHOW_CANCELLED",
    "CANCELLED_BY_CUSTOMER",
    "CANCELLED_BY_BUSINESS",
    "LATE_CANCELLATION",
  ])("D-S2 omits destinations in non-operational state %s", async (status) => {
    const me = await staff();
    const mine = await booking(me.membership._id, { fulfilment: travel, status });
    const response = await detail(businessA, mine._id, me.bearer);
    expect(response.status).toBe(200);
    expect(response.body.data).not.toHaveProperty("travelAddress");
  });

  it("D-S2 omits ended, missing, incomplete and venue destinations without profile fallback", async () => {
    const me = await staff();
    for (const overrides of [
      {
        fulfilment: travel,
        schedule: { timezone: "Europe/Nicosia", startAt: soon(-3), endAt: soon(-2) },
      },
      { fulfilment: { mode: "TRAVEL_TO_CUSTOMER" } },
      {
        fulfilment: {
          mode: "TRAVEL_TO_CUSTOMER",
          travelAddress: { ...destination, streetName: "" },
        },
      },
      {
        fulfilment: {
          ...travel,
          mode: "AT_BUSINESS_LOCATION",
          businessLocation: {
            city: "Larnaca",
            area: "Venue",
            streetName: "Venue",
            streetNumber: "1",
          },
        },
      },
    ]) {
      const mine = await booking(me.membership._id, overrides);
      // A real mutable Client address exists and must never become a fallback destination.
      await BusinessClientModel.collection.insertOne({
        _id: mine.customer.businessClientId,
        businessId: businessA,
        linkedUserId: mine.customer.customerUserId,
        normalizedEmail: `${mine._id}@example.com`,
        // BusinessClient has a non-sparse unique (businessId, phone.e164) index. Give each
        // profile a distinct synthetic phone so this multi-record privacy fixture is valid.
        phone: {
          countryCode: "+357",
          nationalNumber: String(parseInt(mine._id.toHexString().slice(-8), 16)),
          e164: `+357${parseInt(mine._id.toHexString().slice(-8), 16)}`,
        },
        address: { ...travel.travelAddress, streetName: "PROFILE ADDRESS MUST STAY PRIVATE" },
      } as never);
      const response = await detail(businessA, mine._id, me.bearer);
      expect(response.status).toBe(200);
      expect(response.body.data).not.toHaveProperty("travelAddress");
      expect(JSON.stringify(response.body)).not.toContain("Destination Street");
      expect(JSON.stringify(response.body)).not.toContain("PROFILE ADDRESS MUST STAY PRIVATE");
    }
  });

  it("D-S2 rechecks address authorization after assignment, employment, account or session changes", async () => {
    const me = await staff();
    const mine = await booking(me.membership._id, { fulfilment: travel });
    expect((await detail(businessA, mine._id, me.bearer)).body.data.travelAddress).toEqual(
      destination,
    );
    const colleague = await staff();
    await BookingModel.updateOne(
      { _id: mine._id },
      { $set: { "serviceLines.0.responsibleStaffMembershipId": colleague.membership._id } },
    );
    expect((await detail(businessA, mine._id, me.bearer)).status).toBe(404);
    await BookingModel.updateOne(
      { _id: mine._id },
      { $set: { "serviceLines.0.responsibleStaffMembershipId": me.membership._id } },
    );
    for (const change of [
      { employmentActive: false },
      { employmentActive: true, role: "SUPERVISOR" },
      { employmentActive: true, role: "STAFF", removedAt: new Date() },
    ]) {
      await StaffMembershipModel.updateOne({ _id: me.membership._id }, { $set: change });
      const denied = await detail(businessA, mine._id, me.bearer);
      expect(denied.status).toBe(404);
      expect(JSON.stringify(denied.body)).not.toContain("Destination Street");
    }
    await StaffMembershipModel.updateOne({ _id: me.membership._id }, { $set: { removedAt: null } });
    await UserModel.updateOne({ _id: me.account._id }, { $set: { status: "SUSPENDED" } });
    expect((await detail(businessA, mine._id, me.bearer)).status).toBe(403);
    await UserModel.updateOne({ _id: me.account._id }, { $set: { status: "ACTIVE" } });
    await tokenService.revokeAllSessionsForUser(me.account._id);
    expect((await detail(businessA, mine._id, me.bearer)).status).toBe(401);
  });

  it("an active Staff member sees their own assignment with only operational fields", async () => {
    const me = await staff();
    const mine = await booking(me.membership._id);
    const response = await list(businessA, me.bearer);
    expect(response.status).toBe(200);
    expect(response.body.data.appointments).toHaveLength(1);
    const item = response.body.data.appointments[0];
    expect(item).toMatchObject({
      id: String(mine._id),
      reference: mine.reference,
      businessId: String(businessA),
      status: "UPCOMING",
      schedule: { timezone: "Europe/Nicosia", startAt: mine.schedule.startAt.toISOString() },
      customer: { displayName: "Dana Klein" },
      services: [
        {
          serviceName: "Haircut",
          durationMin: 45,
          addonNames: ["Beard trim"],
          isPackageSession: false,
        },
      ],
      sharedWithOtherProfessionals: false,
    });
    expect(Object.keys(item.customer)).toEqual(["displayName"]);
    const text = JSON.stringify(response.body);
    for (const leaked of [
      "dana@example.com",
      "99000111",
      "door code",
      "amountCents",
      "priceCents",
      "financials",
      "depositCents",
      "paymentIntent",
      "businessClientId",
      "customerUserId",
      "staffSnapshot",
      "Sam",
      "Cutter",
      "eventHistory",
      "cancellationOutcome",
      "travelAddress",
    ])
      expect(text).not.toContain(leaked);
    expect((await detail(businessA, mine._id, me.bearer)).body.data).toEqual(item);
  });

  it("never shows another professional's line, Booking or a foreign Business", async () => {
    const me = await staff();
    const colleague = await staff();
    const theirs = await booking(colleague.membership._id);
    const foreignStaff = await staff(businessB);
    const foreign = await booking(foreignStaff.membership._id, {}, businessB);
    expect((await list(businessA, me.bearer)).body.data.appointments).toHaveLength(0);
    expect((await detail(businessA, theirs._id, me.bearer)).status).toBe(404);
    // Another Business id in the path never authorizes: the membership belongs to businessA.
    expect((await list(businessB, me.bearer)).status).toBe(404);
    expect((await detail(businessB, foreign._id, me.bearer)).status).toBe(404);
  });

  it("a shared Booking shows only the requesting Staff member's own service lines", async () => {
    const me = await staff();
    const colleague = await staff();
    const doc = buildBooking({
      businessId: businessA,
      reference: uniqueReference(),
      schedule: { timezone: "Europe/Nicosia", startAt: soon(30), endAt: soon(32) },
    } as never);
    const second = {
      ...doc.serviceLines[0]!,
      serviceSnapshot: { name: "Colour", pricingMode: "FIXED", durationMin: 60 },
      responsibleStaffMembershipId: colleague.membership._id,
      staffSnapshot: { firstName: "Other", lastName: "Pro" },
    };
    doc.serviceLines[0]!.responsibleStaffMembershipId = me.membership._id;
    doc.serviceLines.push(second as never);
    await BookingModel.collection.insertOne(doc as never);
    const item = (await list(businessA, me.bearer)).body.data.appointments[0];
    expect(item.services.map((line: { serviceName: string }) => line.serviceName)).toEqual([
      "Haircut",
    ]);
    expect(item.sharedWithOtherProfessionals).toBe(true);
    expect(JSON.stringify(item)).not.toContain("Colour");
    expect(JSON.stringify(item)).not.toContain("Other");
  });

  it("deactivation, removal and reassignment take effect on the next request", async () => {
    const me = await staff();
    const colleague = await staff();
    const mine = await booking(me.membership._id);
    expect((await list(businessA, me.bearer)).body.data.appointments).toHaveLength(1);

    // Reassignment moves visibility to the new professional and removes the old one's.
    await BookingModel.updateOne(
      { _id: mine._id },
      { $set: { "serviceLines.0.responsibleStaffMembershipId": colleague.membership._id } },
    );
    expect((await list(businessA, me.bearer)).body.data.appointments).toHaveLength(0);
    expect((await detail(businessA, mine._id, me.bearer)).status).toBe(404);
    expect((await detail(businessA, mine._id, colleague.bearer)).status).toBe(200);

    await StaffMembershipModel.updateOne(
      { _id: colleague.membership._id },
      { $set: { employmentActive: false } },
    );
    expect((await list(businessA, colleague.bearer)).status).toBe(404);
    expect((await detail(businessA, mine._id, colleague.bearer)).status).toBe(404);

    await StaffMembershipModel.updateOne(
      { _id: colleague.membership._id },
      { $set: { employmentActive: true, removedAt: new Date() } },
    );
    expect((await list(businessA, colleague.bearer)).status).toBe(404);
  });

  it("a user who moved to another Business sees only the current Business, never the old one", async () => {
    const me = await staff();
    const old = await booking(me.membership._id, { fulfilment: travel });
    await StaffMembershipModel.updateOne(
      { _id: me.membership._id },
      { $set: { removedAt: new Date(), employmentActive: false } },
    );
    const next = await member(me.account._id, businessB);
    const current = await booking(next._id, { fulfilment: travel }, businessB);
    expect((await list(businessA, me.bearer)).status).toBe(404);
    expect((await detail(businessA, old._id, me.bearer)).status).toBe(404);
    const response = await list(businessB, me.bearer);
    expect(response.body.data.appointments.map((entry: { id: string }) => entry.id)).toEqual([
      String(current._id),
    ]);
    expect(JSON.stringify(response.body)).not.toContain("Destination Street");
    expect((await detail(businessB, current._id, me.bearer)).body.data.travelAddress).toEqual(
      destination,
    );
  });

  it("requires a live session, an ACTIVE STAFF account and rejects forged identity or other roles", async () => {
    const me = await staff();
    await booking(me.membership._id);
    expect((await list(businessA)).status).toBe(401);
    expect((await list(businessA, "Bearer forged.token.value")).status).toBe(401);

    // Posted identity is never accepted.
    expect(
      (await list(businessA, me.bearer, `?staffMembershipId=${new Types.ObjectId().toHexString()}`))
        .status,
    ).toBe(400);
    expect(
      (await list(businessA, me.bearer, `?userId=${new Types.ObjectId().toHexString()}`)).status,
    ).toBe(400);

    // Owner and Supervisor sessions keep their own management APIs; this route is STAFF-only.
    for (const role of ["BUSINESS_OWNER", "SUPERVISOR", "CUSTOMER"] as UserRole[]) {
      const other = await user(role);
      const bearer = `Bearer ${await issueTestAccessToken(tokenService, { userId: other._id, role })}`;
      expect((await list(businessA, bearer)).status).toBe(403);
    }

    await UserModel.updateOne({ _id: me.account._id }, { $set: { status: "SUSPENDED" } });
    expect((await list(businessA, me.bearer)).status).toBe(403);
    await UserModel.updateOne({ _id: me.account._id }, { $set: { status: "ACTIVE" } });

    await tokenService.revokeAllSessionsForUser(me.account._id); // Logout everywhere.
    expect((await list(businessA, me.bearer)).status).toBe(401);
  });

  it("follows the existing status contract and filters by status and a bounded date range", async () => {
    const me = await staff();
    const upcoming = await booking(me.membership._id);
    const cancelled = await booking(me.membership._id, {
      status: "CANCELLED_BY_BUSINESS",
      schedule: { timezone: "Europe/Nicosia", startAt: soon(28), endAt: soon(29) },
    });
    const completed = await booking(me.membership._id, {
      status: "COMPLETED",
      schedule: { timezone: "Europe/Nicosia", startAt: soon(-3), endAt: soon(-2) },
    });
    const all = (await list(businessA, me.bearer)).body.data.appointments.map(
      (entry: { id: string }) => entry.id,
    );
    // Default window starts 24h ago; ordered soonest first; cancelled stays visible as cancelled.
    expect(all).toEqual([String(completed._id), String(upcoming._id), String(cancelled._id)]);
    const onlyCancelled = await list(businessA, me.bearer, "?status=CANCELLED_BY_BUSINESS");
    expect(
      onlyCancelled.body.data.appointments.map((entry: { status: string }) => entry.status),
    ).toEqual(["CANCELLED_BY_BUSINESS"]);
    expect((await list(businessA, me.bearer, "?status=NOT_A_STATUS")).status).toBe(400);
    const from = soon(-48).toISOString();
    expect(
      (await list(businessA, me.bearer, `?fromDate=${from}&toDate=${soon(24 * 100).toISOString()}`))
        .status,
    ).toBe(400);
    expect(
      (
        await list(
          businessA,
          me.bearer,
          `?fromDate=${soon(10).toISOString()}&toDate=${soon(5).toISOString()}`,
        )
      ).status,
    ).toBe(400);
    expect((await list(businessA, me.bearer, "?limit=500")).body.data.limit).toBe(50);
  });

  it("paginates with a stable order and reports hasMore without counting everything", async () => {
    const me = await staff();
    for (let index = 0; index < 5; index += 1)
      await booking(me.membership._id, {
        reference: `BK-${index}AAAAAA`,
        schedule: {
          timezone: "Europe/Nicosia",
          startAt: soon(30 + index),
          endAt: soon(31 + index),
        },
      });
    const first = (await list(businessA, me.bearer, "?limit=2&page=1")).body.data;
    const second = (await list(businessA, me.bearer, "?limit=2&page=2")).body.data;
    const third = (await list(businessA, me.bearer, "?limit=2&page=3")).body.data;
    expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([true, true, false]);
    const ids = [...first.appointments, ...second.appointments, ...third.appointments].map(
      (entry: { id: string }) => entry.id,
    );
    expect(new Set(ids).size).toBe(5);
  });

  it("hides a First-Class Package Booking without genuine purchase proof; ordinary Package sessions stay visible", async () => {
    const me = await staff();
    const legacy = await booking(me.membership._id, { fulfilment: travel });
    await BookingModel.collection.updateOne(
      { _id: legacy._id },
      {
        $set: {
          "serviceLines.0.pricingInput": {
            packageProgressId: new Types.ObjectId(),
            sessionIndex: 2,
          },
        },
      },
    );
    const firstClass = await booking(me.membership._id, {
      fulfilment: travel,
      schedule: { timezone: "Europe/Nicosia", startAt: soon(40), endAt: soon(41) },
    });
    await BookingModel.collection.updateOne(
      { _id: firstClass._id },
      {
        $set: {
          "serviceLines.0.pricingInput": {
            packageItemId: new Types.ObjectId(),
            packageProgressId: new Types.ObjectId(),
          },
        },
      },
    );
    expect(await PackageProgressV2Model.countDocuments({})).toBe(0); // No genuine purchase exists.
    const ids = (await list(businessA, me.bearer)).body.data.appointments.map(
      (entry: { id: string; services: Array<{ isPackageSession: boolean }> }) => [
        entry.id,
        entry.services[0]?.isPackageSession,
      ],
    );
    expect(ids).toEqual([[String(legacy._id), true]]);
    expect((await detail(businessA, firstClass._id, me.bearer)).status).toBe(404);
    expect((await detail(businessA, legacy._id, me.bearer)).body.data.travelAddress).toEqual(
      destination,
    );
  });

  it("offers no Staff mutation and leaves the Bookings untouched", async () => {
    const me = await staff();
    const mine = await booking(me.membership._id, { fulfilment: travel });
    const before = await BookingModel.collection.findOne({ _id: mine._id });
    const path = `/businesses/${businessA.toHexString()}/staff/me/appointments/${mine._id.toHexString()}`;
    for (const method of ["post", "put", "patch", "delete"] as const) {
      const response = await request(app)
        [method](path)
        .set("Authorization", me.bearer)
        .send({ status: "CANCELLED_BY_BUSINESS" });
      expect(response.status).toBe(404);
    }
    for (const suffix of ["cancel", "reschedule", "complete", "no-show"]) {
      const response = await request(app)
        .post(`${path}/${suffix}`)
        .set("Authorization", me.bearer)
        .send({});
      expect(response.status).toBe(404);
    }
    expect(await BookingModel.collection.findOne({ _id: mine._id })).toEqual(before);
    void mongoose;
  });
});
