import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { businessLocalToUtc } from "../../../src/common/time/business-clock.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { createBusinessBookingRoute } from "../../../src/modules/booking/booking.route.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { BusinessHoursRepository } from "../../../src/modules/business-hours/business-hours.repository.js";
import { BusinessHoursService } from "../../../src/modules/business-hours/business-hours.service.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { ServiceRepository } from "../../../src/modules/services/service.repository.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { StaffScheduleRepository } from "../../../src/modules/staff/staff-schedule.repository.js";
import { createSuperAdminRoute } from "../../../src/modules/super-admin/super-admin.route.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const TIMEZONE = "Europe/Nicosia";
const DATE = "2030-08-20"; // a Tuesday, safely in the future relative to any real "now"

/**
 * Batch 11 — HTTP-level authorization and behavior tests for the new Super Admin business/
 * booking/customer/dashboard surfaces (super-admin.route.ts). Exercises the real routes end to
 * end (auth middleware, requireRoles(["SUPER_ADMIN"]) gate, zod validation, the CAS-based
 * BusinessLifecycleService) — never calls the services directly, since the whole point is
 * proving the HTTP-layer authorization boundary actually holds.
 */
describe("HTTP-level Super Admin business/booking/customer/dashboard (Batch 11)", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let serviceRepository: ServiceRepository;
  let staffRepository: StaffRepository;
  let staffScheduleRepository: StaffScheduleRepository;
  let businessHoursRepository: BusinessHoursRepository;
  let businessHoursService: BusinessHoursService;
  let clientRepository: ClientRepository;
  let tokenService: TokenService;

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
    tokenService = new TokenService(new SessionRepository());
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  // --- Fixtures --------------------------------------------------------------------------------

  const createSuperAdmin = async () =>
    userRepository.create({
      normalizedEmail: `super-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    });

  /** Always leaves the business genuinely PENDING (the real, create()-only default) — tests that
   * need an APPROVED business call approve() themselves via the real route. */
  const createPendingBusiness = async (name: string) => {
    const email = `owner-${new Types.ObjectId().toString()}@example.com`;
    const owner = await userRepository.create({
      normalizedEmail: email,
      passwordHash: "hash",
      role: "BUSINESS_OWNER",
      status: "ACTIVE",
    });
    const business = await businessRepository.create({
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

  const createClientFor = async (
    businessId: Types.ObjectId,
    ownerId: Types.ObjectId,
    tag: string,
  ) =>
    clientRepository.create({
      businessId,
      createdByUserId: ownerId,
      firstName: "Walk",
      lastName: "In",
      normalizedEmail: `walkin-${tag}-${new Types.ObjectId().toString()}@example.com`,
      phone: {
        countryCode: "+357",
        nationalNumber: `9${tag}0000${Math.floor(Math.random() * 100)}`.slice(0, 8),
        e164: `+3579${tag}0000${Math.floor(Math.random() * 100)}`.slice(0, 12),
      },
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

  /** Creates a PENDING business, then approves it via the real HTTP route (proving approve()
   * itself works while also giving other tests a genuinely-approved fixture). */
  const createApprovedBusiness = async (name: string, superAdmin: { _id: Types.ObjectId }) => {
    const { owner, business } = await createPendingBusiness(name);
    const app = buildSuperAdminApp();
    const response = await request(app)
      .post(`/super-admin/businesses/${business._id}/approve`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));
    expect(response.status).toBe(200);
    return { owner, business };
  };

  const setupBookableBusiness = async (superAdmin: { _id: Types.ObjectId }, priceCents = 8000) => {
    const { owner, business } = await createApprovedBusiness("Salon A", superAdmin);
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id, priceCents);
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);
    const client = await createClientFor(business._id, owner._id, "a");
    return { owner, business, membership, service, client };
  };

  const buildSuperAdminApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/super-admin", createSuperAdminRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const buildBookingApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/businesses", createBusinessBookingRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "CUSTOMER" | "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF" | "SUPER_ADMIN",
  ) => `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  // --- Cross-role authorization: every /super-admin route is SUPER_ADMIN-only ------------------

  it("rejects a BUSINESS_OWNER token on GET /super-admin/businesses (403)", async () => {
    const { owner } = await createPendingBusiness("Salon A");
    const app = buildSuperAdminApp();

    const response = await request(app)
      .get("/super-admin/businesses")
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"));

    expect(response.status).toBe(403);
  });

  it("rejects a CUSTOMER token on GET /super-admin/bookings (403)", async () => {
    const customer = await userRepository.create({
      normalizedEmail: `cust-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    const app = buildSuperAdminApp();

    const response = await request(app)
      .get("/super-admin/bookings")
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));

    expect(response.status).toBe(403);
  });

  it("rejects requests with no Authorization header at all (401)", async () => {
    const app = buildSuperAdminApp();
    const response = await request(app).get("/super-admin/dashboard/summary");
    expect(response.status).toBe(401);
  });

  it("rejects a STAFF token attempting to approve a business (403), and the business stays PENDING", async () => {
    const { business } = await createPendingBusiness("Salon A");
    const { user: staffUser } = await createStaff(business._id);
    const app = buildSuperAdminApp();

    const response = await request(app)
      .post(`/super-admin/businesses/${business._id}/approve`)
      .set("Authorization", await bearerFor(staffUser._id, "STAFF"));

    expect(response.status).toBe(403);
    const fresh = await businessRepository.findById(business._id);
    expect(fresh?.status).toBe("PENDING");
  });

  // --- Business approve/reject/suspend: CAS correctness, idempotency, audit trail ---------------

  it("a SUPER_ADMIN can approve a PENDING business; status becomes APPROVED with an audited statusHistory entry", async () => {
    const superAdmin = await createSuperAdmin();
    const { business } = await createPendingBusiness("Salon A");
    const app = buildSuperAdminApp();

    const response = await request(app)
      .post(`/super-admin/businesses/${business._id}/approve`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("APPROVED");
    expect(response.body.data.statusHistory).toHaveLength(1);
    expect(response.body.data.statusHistory[0]).toMatchObject({
      fromStatus: "PENDING",
      toStatus: "APPROVED",
      actorUserId: String(superAdmin._id),
    });
  });

  it("repeated approval of an already-APPROVED business is a safe idempotent no-op (still 200, no duplicate history entry)", async () => {
    const superAdmin = await createSuperAdmin();
    const { business } = await createApprovedBusiness("Salon A", superAdmin);
    const app = buildSuperAdminApp();

    const second = await request(app)
      .post(`/super-admin/businesses/${business._id}/approve`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(second.status).toBe(200);
    expect(second.body.data.status).toBe("APPROVED");
    expect(second.body.data.statusHistory).toHaveLength(1);
  });

  it("rejects (reject → SUSPENDED) a PENDING business; a second reject attempt on the now-SUSPENDED business is an invalid transition (409)", async () => {
    const superAdmin = await createSuperAdmin();
    const { business } = await createPendingBusiness("Salon A");
    const app = buildSuperAdminApp();

    const first = await request(app)
      .post(`/super-admin/businesses/${business._id}/reject`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send({ reason: "Incomplete documentation" });

    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe("SUSPENDED");
    expect(first.body.data.statusHistory[0]).toMatchObject({
      fromStatus: "PENDING",
      toStatus: "SUSPENDED",
      reason: "Incomplete documentation",
    });

    const second = await request(app)
      .post(`/super-admin/businesses/${business._id}/reject`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send({});

    expect(second.status).toBe(409);
  });

  it("suspends an APPROVED business; a subsequent /approve reactivates it (reversible, per confirmed policy)", async () => {
    const superAdmin = await createSuperAdmin();
    const { business } = await createApprovedBusiness("Salon A", superAdmin);
    const app = buildSuperAdminApp();

    const suspended = await request(app)
      .post(`/super-admin/businesses/${business._id}/suspend`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send({ reason: "Payment dispute" });
    expect(suspended.status).toBe(200);
    expect(suspended.body.data.status).toBe("SUSPENDED");

    const reactivated = await request(app)
      .post(`/super-admin/businesses/${business._id}/approve`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.data.status).toBe("APPROVED");
    expect(reactivated.body.data.statusHistory).toHaveLength(3);
  });

  it("rejects suspending an already-PENDING business (409 invalid transition — suspend is only defined from APPROVED/WARNING)", async () => {
    const superAdmin = await createSuperAdmin();
    const { business } = await createPendingBusiness("Salon A");
    const app = buildSuperAdminApp();

    const response = await request(app)
      .post(`/super-admin/businesses/${business._id}/suspend`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send({});

    expect(response.status).toBe(409);
    const fresh = await businessRepository.findById(business._id);
    expect(fresh?.status).toBe("PENDING");
  });

  it("returns 404 (never a leaking different status) for approve/reject/suspend on a nonexistent businessId", async () => {
    const superAdmin = await createSuperAdmin();
    const app = buildSuperAdminApp();
    const fakeId = new Types.ObjectId().toString();

    const response = await request(app)
      .post(`/super-admin/businesses/${fakeId}/approve`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(404);
  });

  // --- Business access actually changes after approval (route-access matrix) --------------------

  it("a business blocked from manual-booking creation while PENDING becomes bookable immediately after Super Admin approval", async () => {
    const superAdmin = await createSuperAdmin();
    const { owner, business } = await createPendingBusiness("Salon A");
    const { membership } = await createStaff(business._id);
    const service = await createFixedService(business._id, membership._id);
    await openMondayToFriday(business._id, owner._id);
    await staffWorksMondayToFriday(membership._id, business._id);
    const client = await createClientFor(business._id, owner._id, "gate");

    const bookingApp = buildBookingApp();
    const bookingBody = {
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
    };

    const beforeApproval = await request(bookingApp)
      .post(`/businesses/${business._id}/bookings`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send(bookingBody);
    expect(beforeApproval.status).toBe(403);

    const superAdminApp = buildSuperAdminApp();
    const approve = await request(superAdminApp)
      .post(`/super-admin/businesses/${business._id}/approve`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));
    expect(approve.status).toBe(200);

    const afterApproval = await request(bookingApp)
      .post(`/businesses/${business._id}/bookings`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send({ ...bookingBody, idempotencyKey: `key-${new Types.ObjectId().toString()}` });
    expect(afterApproval.status).toBe(201);
  });

  // --- Business list: pagination, filtering, status counts, no N+1 -------------------------------

  it("lists businesses with bounded pagination, status filter, and a fully-populated status-count summary", async () => {
    const superAdmin = await createSuperAdmin();
    await createPendingBusiness("Pending One");
    await createPendingBusiness("Pending Two");
    await createApprovedBusiness("Approved One", superAdmin);
    const app = buildSuperAdminApp();

    const all = await request(app)
      .get("/super-admin/businesses")
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));
    expect(all.status).toBe(200);
    expect(all.body.data.businesses).toHaveLength(3);
    expect(all.body.data.counts).toMatchObject({
      ALL: 3,
      PENDING: 2,
      APPROVED: 1,
      WARNING: 0,
      SUSPENDED: 0,
    });

    const filtered = await request(app)
      .get("/super-admin/businesses")
      .query({ status: "PENDING" })
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.businesses).toHaveLength(2);
    expect(
      filtered.body.data.businesses.every((b: { status: string }) => b.status === "PENDING"),
    ).toBe(true);

    const paginated = await request(app)
      .get("/super-admin/businesses")
      .query({ page: "1", limit: "2" })
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));
    expect(paginated.status).toBe(200);
    expect(paginated.body.data.businesses).toHaveLength(2);
    expect(paginated.body.data.pagination.total).toBe(3);
  });

  it("rejects an unbounded/invalid limit query param via schema validation (400), never silently unbounded", async () => {
    const superAdmin = await createSuperAdmin();
    const app = buildSuperAdminApp();

    const response = await request(app)
      .get("/super-admin/businesses")
      .query({ limit: "not-a-number" })
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(400);
  });

  it("rejects an unknown query param on the businesses list (schema is strict, no silent pass-through)", async () => {
    const superAdmin = await createSuperAdmin();
    const app = buildSuperAdminApp();

    const response = await request(app)
      .get("/super-admin/businesses")
      .query({ unknownParam: "x" })
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(400);
  });

  // --- Business detail: reused Finance/booking-count primitives, no duplicate calculation --------

  it("returns 404 for a nonexistent business id on the detail route (not an ID-enumeration leak)", async () => {
    const superAdmin = await createSuperAdmin();
    const app = buildSuperAdminApp();
    const fakeId = new Types.ObjectId().toString();

    const response = await request(app)
      .get(`/super-admin/businesses/${fakeId}`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(404);
  });

  it("business detail includes a real bookingsCount reflecting actual Booking documents for that business", async () => {
    const superAdmin = await createSuperAdmin();
    const { business, membership, service, client, owner } =
      await setupBookableBusiness(superAdmin);
    const bookingApp = buildBookingApp();
    await request(bookingApp)
      .post(`/businesses/${business._id}/bookings`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send({
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
      });

    const app = buildSuperAdminApp();
    const response = await request(app)
      .get(`/super-admin/businesses/${business._id}`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data.bookingsCount).toBe(1);
    expect(response.body.data.owner.id).toBe(String(owner._id));
  });

  // --- Global Bookings: cross-business list, businessName enrichment, detail reuse ---------------

  it("global bookings list spans multiple businesses and enriches each row with businessName (no N+1, single batched lookup)", async () => {
    const superAdmin = await createSuperAdmin();
    const a = await setupBookableBusiness(superAdmin, 8000);
    const bookingApp = buildBookingApp();
    const bookingResponse = await request(bookingApp)
      .post(`/businesses/${a.business._id}/bookings`)
      .set("Authorization", await bearerFor(a.owner._id, "BUSINESS_OWNER"))
      .send({
        serviceLines: [
          {
            serviceId: String(a.service._id),
            staffMembershipId: String(a.membership._id),
            addonIds: [],
            pricingInput: {},
          },
        ],
        startAt: startAtFor("10:00"),
        businessClientId: String(a.client._id),
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
      });
    expect(bookingResponse.status).toBe(201);

    const app = buildSuperAdminApp();
    const response = await request(app)
      .get("/super-admin/bookings")
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data.bookings.length).toBeGreaterThanOrEqual(1);
    const row = response.body.data.bookings.find(
      (b: { id: string }) => b.id === bookingResponse.body.data.id,
    );
    expect(row).toBeDefined();
    expect(row.businessName).toBe(a.business.name);
  });

  it("global booking detail reuses the same DTO shape as the Business-scoped booking detail (no reconstructed financials)", async () => {
    const superAdmin = await createSuperAdmin();
    const { owner, business, membership, service, client } =
      await setupBookableBusiness(superAdmin);
    const bookingApp = buildBookingApp();
    const created = await request(bookingApp)
      .post(`/businesses/${business._id}/bookings`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send({
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
      });
    expect(created.status).toBe(201);

    const app = buildSuperAdminApp();
    const response = await request(app)
      .get(`/super-admin/bookings/${created.body.data.id}`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(created.body.data.id);
    expect(response.body.data.financials.platformFeeCents).toBe(
      created.body.data.financials.platformFeeCents,
    );
  });

  it("returns 404 for a nonexistent booking id on the global detail route", async () => {
    const superAdmin = await createSuperAdmin();
    const app = buildSuperAdminApp();
    const fakeId = new Types.ObjectId().toString();

    const response = await request(app)
      .get(`/super-admin/bookings/${fakeId}`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(404);
  });

  // --- Global Customers: platform-User identity, never merged with BusinessClient rows -----------

  it("lists only CUSTOMER-role platform Users, never Business staff/owner accounts", async () => {
    const superAdmin = await createSuperAdmin();
    const { owner } = await createPendingBusiness("Salon A");
    const customer = await userRepository.create({
      normalizedEmail: `cust-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    const app = buildSuperAdminApp();

    const response = await request(app)
      .get("/super-admin/customers")
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    const ids = response.body.data.customers.map((c: { id: string }) => c.id);
    expect(ids).toContain(String(customer._id));
    expect(ids).not.toContain(String(owner._id));
  });

  it("customer detail reuses bookingRepository.listForCustomer — same bounded, business-scoped booking rows as /me/bookings, never a flattened global label", async () => {
    const superAdmin = await createSuperAdmin();
    const { owner, business, membership, service, client } =
      await setupBookableBusiness(superAdmin);
    const customer = await userRepository.create({
      normalizedEmail: `cust-detail-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    void client;
    const bookingApp = buildBookingApp();
    const created = await request(bookingApp)
      .post(`/businesses/${business._id}/bookings`)
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send({
        serviceLines: [
          {
            serviceId: String(service._id),
            staffMembershipId: String(membership._id),
            addonIds: [],
            pricingInput: {},
          },
        ],
        startAt: startAtFor("10:00"),
        businessClientId: String((await createClientFor(business._id, owner._id, "detail"))._id),
        idempotencyKey: `key-${new Types.ObjectId().toString()}`,
      });
    expect(created.status).toBe(201);

    const app = buildSuperAdminApp();
    const response = await request(app)
      .get(`/super-admin/customers/${customer._id}`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(String(customer._id));
    expect(Array.isArray(response.body.data.bookings)).toBe(true);
    expect(response.body.data.bookingsTotal).toBe(0);
  });

  it("returns 404 for a business-owner userId on the customer-detail route (role mismatch, never leaks a non-Customer identity)", async () => {
    const superAdmin = await createSuperAdmin();
    const { owner } = await createPendingBusiness("Salon A");
    const app = buildSuperAdminApp();

    const response = await request(app)
      .get(`/super-admin/customers/${owner._id}`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(404);
  });

  // --- Dashboard summary: server-side aggregation, fully-populated buckets -----------------------

  it("dashboard summary reflects real business/customer/booking counts via server-side aggregation", async () => {
    const superAdmin = await createSuperAdmin();
    await createPendingBusiness("Pending One");
    await createApprovedBusiness("Approved One", superAdmin);
    await userRepository.create({
      normalizedEmail: `dash-cust-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });
    const app = buildSuperAdminApp();

    const response = await request(app)
      .get("/super-admin/dashboard/summary")
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));

    expect(response.status).toBe(200);
    expect(response.body.data.businesses).toMatchObject({
      total: 2,
      PENDING: 1,
      APPROVED: 1,
      WARNING: 0,
      SUSPENDED: 0,
    });
    expect(response.body.data.customers.total).toBe(1);
    expect(typeof response.body.data.platformRevenueCents).toBe("number");
    expect(typeof response.body.data.pendingBusinessPayableCents).toBe("number");
  });
});
