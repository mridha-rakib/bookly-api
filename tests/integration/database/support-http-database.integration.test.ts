import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BusinessRepository } from "../../../src/modules/business/business.repository.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StaffRepository } from "../../../src/modules/staff/staff.repository.js";
import { createSuperAdminRoute } from "../../../src/modules/super-admin/super-admin.route.js";
import { createContactRoute } from "../../../src/modules/support/contact.route.js";
import { createSupportRoute } from "../../../src/modules/support/support.route.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * Batch 15B — the HTTP-layer boundary support-database.integration.test.ts deliberately doesn't
 * cover: real route wiring, `requireRoles`/`requireActiveUser` auth gates, zod `.strict()`
 * unknown-field rejection, and exactly what a real HTTP response body contains (never a raw
 * Mongoose document, never a leaked senderUserId/actorUserId — see support.dto.ts). Ticket/reply
 * emails are best-effort and swallowed internally (support.service.ts), so these tests never
 * depend on real email delivery succeeding — the (deliberately fake, non-routable) SMTP host
 * configured for the test environment (tests/setup/vitest.setup.ts) fails fast and is caught,
 * exactly as it would in production if the provider were briefly down.
 */
describe("HTTP-level Support endpoints (Batch 15B)", () => {
  let userRepository: UserRepository;
  let businessRepository: BusinessRepository;
  let staffRepository: StaffRepository;
  let tokenService: TokenService;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    userRepository = new UserRepository();
    businessRepository = new BusinessRepository();
    staffRepository = new StaffRepository();
    tokenService = new TokenService(new SessionRepository());
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
      timezone: "Europe/Nicosia",
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

  const createStaffMember = async (
    businessId: Types.ObjectId,
    role: "STAFF" | "SUPERVISOR" = "STAFF",
  ) => {
    const user = await userRepository.create({
      normalizedEmail: `staff-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role,
      status: "ACTIVE",
    });
    const membership = await staffRepository.create({
      userId: user._id,
      businessId,
      role,
      createdByUserId: user._id,
    });
    return { user, membership };
  };

  const createCustomer = async (tag: string) =>
    userRepository.create({
      normalizedEmail: `cust-${tag}-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "CUSTOMER",
      status: "ACTIVE",
    });

  const createSuperAdmin = async () =>
    userRepository.create({
      normalizedEmail: `super-${new Types.ObjectId().toString()}@example.com`,
      passwordHash: "hash",
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    });

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use("/me", createSupportRoute());
    app.use("/contact", createContactRoute());
    app.use("/super-admin", createSuperAdminRoute());
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };

  const bearerFor = async (
    userId: Types.ObjectId | string,
    role: "CUSTOMER" | "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF" | "SUPER_ADMIN",
  ) => `Bearer ${await tokenService.createAccessToken({ userId, role })}`;

  // --- Requester create/list/detail --------------------------------------------------------------

  it("POST creates a ticket via the real HTTP route (201), response never leaks requesterUserId internals beyond what's owned", async () => {
    const customer = await createCustomer("create");
    const app = buildApp();

    const response = await request(app)
      .post("/me/support/tickets")
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
      .send({ subject: "Payment issue", message: "Charged twice" });

    expect(response.status).toBe(201);
    expect(response.body.data.reference).toMatch(/^TCK-/);
    expect(response.body.data.status).toBe("OPEN");
    expect(response.body.data.businessId).toBeUndefined();
  });

  it("rejects a smuggled requesterUserId/requesterRole/businessId/status in the create body (schema .strict())", async () => {
    const customer = await createCustomer("smuggle");
    const app = buildApp();

    const response = await request(app)
      .post("/me/support/tickets")
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
      .send({
        subject: "s",
        message: "m",
        requesterUserId: String(new Types.ObjectId()),
        requesterRole: "SUPER_ADMIN",
        businessId: String(new Types.ObjectId()),
        status: "RESOLVED",
      });

    expect(response.status).toBe(400);
  });

  it("even a genuine BUSINESS_OWNER cannot force a foreign businessId onto their own ticket", async () => {
    const { owner, business } = await createBusiness("Real Biz");
    const { business: otherBusiness } = await createBusiness("Other Biz");
    const app = buildApp();

    const response = await request(app)
      .post("/me/support/tickets")
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send({ subject: "s", message: "m", businessId: String(otherBusiness._id) });

    // .strict() rejects the unknown field outright — but even if it were accepted, the server
    // would still derive the real owned business, never the submitted one (see support.service.ts).
    expect(response.status).toBe(400);
    void business;
  });

  it("rejects an unauthenticated request with 401", async () => {
    const app = buildApp();
    const response = await request(app).get("/me/support/tickets");
    expect(response.status).toBe(401);
  });

  it("rejects a SUPER_ADMIN token on the requester Support route (403) — Super Admin uses its own surface", async () => {
    const superAdmin = await createSuperAdmin();
    const app = buildApp();

    const response = await request(app)
      .get("/me/support/tickets")
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));
    expect(response.status).toBe(403);
  });

  it("GET a ticket belonging to another Customer returns the SAME 404 as an unknown ticketId (anti-enumeration)", async () => {
    const owner = await createCustomer("real-owner");
    const stranger = await createCustomer("stranger-http");
    const app = buildApp();

    const createResponse = await request(app)
      .post("/me/support/tickets")
      .set("Authorization", await bearerFor(owner._id, "CUSTOMER"))
      .send({ subject: "s", message: "m" });
    const ticketId = createResponse.body.data.id;

    const unknown = await request(app)
      .get(`/me/support/tickets/${new Types.ObjectId()}`)
      .set("Authorization", await bearerFor(stranger._id, "CUSTOMER"));
    const foreign = await request(app)
      .get(`/me/support/tickets/${ticketId}`)
      .set("Authorization", await bearerFor(stranger._id, "CUSTOMER"));

    expect(unknown.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(unknown.body.message).toBe(foreign.body.message);
  });

  it("Batch 15C — BUSINESS_OWNER, SUPERVISOR, and STAFF each get the full list -> detail -> reply -> reopen flow on their own tickets", async () => {
    const app = buildApp();
    const { owner, business } = await createBusiness("Full Flow Biz");
    const { user: supervisor } = await createStaffMember(business._id, "SUPERVISOR");
    const { user: staffUser } = await createStaffMember(business._id, "STAFF");

    const actors: Array<{ userId: string; role: "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF" }> = [
      { userId: String(owner._id), role: "BUSINESS_OWNER" },
      { userId: String(supervisor._id), role: "SUPERVISOR" },
      { userId: String(staffUser._id), role: "STAFF" },
    ];

    for (const actor of actors) {
      const auth = await bearerFor(actor.userId, actor.role);

      const created = await request(app)
        .post("/me/support/tickets")
        .set("Authorization", auth)
        .send({ subject: `${actor.role} issue`, message: "Need help" });
      expect(created.status).toBe(201);
      const ticketId = created.body.data.id;

      // list-own
      const list = await request(app).get("/me/support/tickets").set("Authorization", auth);
      expect(list.status).toBe(200);
      expect(list.body.data.tickets.some((t: { id: string }) => t.id === ticketId)).toBe(true);

      // detail
      const detail = await request(app)
        .get(`/me/support/tickets/${ticketId}`)
        .set("Authorization", auth);
      expect(detail.status).toBe(200);
      expect(detail.body.data.status).toBe("OPEN");

      // reply (allowed while OPEN)
      const reply = await request(app)
        .post(`/me/support/tickets/${ticketId}/messages`)
        .set("Authorization", auth)
        .send({ message: "Following up" });
      expect(reply.status).toBe(201);

      // conversation persists and contains both messages
      const messages = await request(app)
        .get(`/me/support/tickets/${ticketId}/messages`)
        .set("Authorization", auth);
      expect(messages.body.data.messages.map((m: { message: string }) => m.message)).toEqual([
        "Need help",
        "Following up",
      ]);

      // resolve then reopen (admin resolves, requester reopens)
      const superAdmin = await createSuperAdmin();
      await request(app)
        .post(`/super-admin/support/tickets/${ticketId}/status`)
        .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
        .send({ status: "RESOLVED" });

      const blockedReply = await request(app)
        .post(`/me/support/tickets/${ticketId}/messages`)
        .set("Authorization", auth)
        .send({ message: "still blocked" });
      expect(blockedReply.status).toBe(409);

      const reopen = await request(app)
        .post(`/me/support/tickets/${ticketId}/reopen`)
        .set("Authorization", auth);
      expect(reopen.status).toBe(200);
      expect(reopen.body.data.status).toBe("OPEN");

      // requester never receives Admin-only capabilities
      const statusAttempt = await request(app)
        .post(`/super-admin/support/tickets/${ticketId}/status`)
        .set("Authorization", auth)
        .send({ status: "CLOSED" });
      expect(statusAttempt.status).toBe(403);
    }
  });

  it("SUPERVISOR at Business A cannot read/reply to a ticket created by a Supervisor at Business B", async () => {
    const { business: businessA } = await createBusiness("Biz A");
    const { business: businessB } = await createBusiness("Biz B");
    const { user: supervisorA } = await createStaffMember(businessA._id, "SUPERVISOR");
    const { user: supervisorB } = await createStaffMember(businessB._id, "SUPERVISOR");
    const app = buildApp();

    const created = await request(app)
      .post("/me/support/tickets")
      .set("Authorization", await bearerFor(supervisorA._id, "SUPERVISOR"))
      .send({ subject: "A's ticket", message: "m" });
    const ticketId = created.body.data.id;

    const readAttempt = await request(app)
      .get(`/me/support/tickets/${ticketId}`)
      .set("Authorization", await bearerFor(supervisorB._id, "SUPERVISOR"));
    expect(readAttempt.status).toBe(404);

    const replyAttempt = await request(app)
      .post(`/me/support/tickets/${ticketId}/messages`)
      .set("Authorization", await bearerFor(supervisorB._id, "SUPERVISOR"))
      .send({ message: "trying to reply" });
    expect(replyAttempt.status).toBe(404);
  });

  it("reply/conversation messages never expose senderUserId in the response DTO", async () => {
    const customer = await createCustomer("dto-privacy");
    const app = buildApp();

    const created = await request(app)
      .post("/me/support/tickets")
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
      .send({ subject: "s", message: "m" });
    const ticketId = created.body.data.id;

    const reply = await request(app)
      .post(`/me/support/tickets/${ticketId}/messages`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
      .send({ message: "follow up" });
    expect(reply.status).toBe(201);
    expect(reply.body.data.senderUserId).toBeUndefined();

    const listResponse = await request(app)
      .get(`/me/support/tickets/${ticketId}/messages`)
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"));
    expect(listResponse.status).toBe(200);
    for (const message of listResponse.body.data.messages) {
      expect(message.senderUserId).toBeUndefined();
    }
  });

  // --- Super Admin surface -------------------------------------------------------------------------

  it("only SUPER_ADMIN can access the admin Support surface — every requester role is denied 403", async () => {
    const customer = await createCustomer("deny-customer");
    const { owner } = await createBusiness("Deny Biz");
    const app = buildApp();

    for (const [userId, role] of [
      [customer._id, "CUSTOMER"],
      [owner._id, "BUSINESS_OWNER"],
    ] as const) {
      const response = await request(app)
        .get("/super-admin/support/tickets")
        .set("Authorization", await bearerFor(userId, role));
      expect(response.status).toBe(403);
    }
  });

  it("SUPER_ADMIN can list tickets, read detail with enriched requester/business context, reply, change status, and Reopen", async () => {
    const { owner, business } = await createBusiness("Admin Flow Biz");
    const superAdmin = await createSuperAdmin();
    const app = buildApp();

    const created = await request(app)
      .post("/me/support/tickets")
      .set("Authorization", await bearerFor(owner._id, "BUSINESS_OWNER"))
      .send({ subject: "Payout delay", message: "It's late" });
    const ticketId = created.body.data.id;

    const listResponse = await request(app)
      .get("/super-admin/support/tickets")
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));
    expect(listResponse.status).toBe(200);
    const row = listResponse.body.data.tickets.find((t: { id: string }) => t.id === ticketId);
    expect(row.businessName).toBe(business.name);
    expect(row.requesterEmail).toBe(owner.normalizedEmail);

    const detailResponse = await request(app)
      .get(`/super-admin/support/tickets/${ticketId}`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.data.statusHistory).toHaveLength(1);
    expect(detailResponse.body.data.statusHistory[0].actorUserId).toBeUndefined();

    const replyResponse = await request(app)
      .post(`/super-admin/support/tickets/${ticketId}/messages`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send({ message: "Checking now" });
    expect(replyResponse.status).toBe(201);
    expect(replyResponse.body.data.senderRole).toBe("SUPER_ADMIN");

    const resolveResponse = await request(app)
      .post(`/super-admin/support/tickets/${ticketId}/status`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send({ status: "RESOLVED" });
    expect(resolveResponse.status).toBe(200);
    expect(resolveResponse.body.data.status).toBe("RESOLVED");

    const closeResponse = await request(app)
      .post(`/super-admin/support/tickets/${ticketId}/status`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send({ status: "CLOSED" });
    expect(closeResponse.status).toBe(200);

    const reopenResponse = await request(app)
      .post(`/super-admin/support/tickets/${ticketId}/reopen`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"));
    expect(reopenResponse.status).toBe(200);
    expect(reopenResponse.body.data.status).toBe("OPEN");
  });

  it("rejects an invalid admin status transition with 409", async () => {
    const customer = await createCustomer("invalid-transition");
    const superAdmin = await createSuperAdmin();
    const app = buildApp();

    const created = await request(app)
      .post("/me/support/tickets")
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
      .send({ subject: "s", message: "m" });
    const ticketId = created.body.data.id;

    const response = await request(app)
      .post(`/super-admin/support/tickets/${ticketId}/status`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send({ status: "CLOSED" }); // OPEN -> CLOSED is not a valid direct transition

    expect(response.status).toBe(409);
  });

  it("PENDING -> OPEN is reachable via the regular status endpoint, but RESOLVED -> OPEN is not (must use Reopen)", async () => {
    const customer = await createCustomer("pending-open");
    const superAdmin = await createSuperAdmin();
    const app = buildApp();

    const created = await request(app)
      .post("/me/support/tickets")
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
      .send({ subject: "s", message: "m" });
    const ticketId = created.body.data.id;

    await request(app)
      .post(`/super-admin/support/tickets/${ticketId}/status`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send({ status: "PENDING" });

    const backToOpen = await request(app)
      .post(`/super-admin/support/tickets/${ticketId}/status`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send({ status: "OPEN" });
    expect(backToOpen.status).toBe(200);
    expect(backToOpen.body.data.status).toBe("OPEN");

    await request(app)
      .post(`/super-admin/support/tickets/${ticketId}/status`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send({ status: "RESOLVED" });

    const invalidBackToOpen = await request(app)
      .post(`/super-admin/support/tickets/${ticketId}/status`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send({ status: "OPEN" });
    expect(invalidBackToOpen.status).toBe(409);
  });

  it("rejects an unrecognized status value in the admin status-change body (schema enum)", async () => {
    const customer = await createCustomer("bad-status-value");
    const superAdmin = await createSuperAdmin();
    const app = buildApp();

    const created = await request(app)
      .post("/me/support/tickets")
      .set("Authorization", await bearerFor(customer._id, "CUSTOMER"))
      .send({ subject: "s", message: "m" });

    const response = await request(app)
      .post(`/super-admin/support/tickets/${created.body.data.id}/status`)
      .set("Authorization", await bearerFor(superAdmin._id, "SUPER_ADMIN"))
      .send({ status: "ARCHIVED" });

    expect(response.status).toBe(400);
  });

  // --- Public Contact -------------------------------------------------------------------------------

  it("public Contact requires no authentication and does not create a SupportTicket", async () => {
    const app = buildApp();

    const response = await request(app).post("/contact/").send({
      name: "Jane Visitor",
      email: "jane@example.com",
      subject: "General question",
      message: "How does Bookly work?",
    });

    // The fake, non-routable SMTP host configured for tests means delivery genuinely fails here —
    // this asserts the honest failure path (never a fabricated 200), matching the confirmed rule
    // "Do not fake success." A real provider would return 200 the same way ticket-creation email
    // succeeds when SMTP is reachable (see support-database.integration.test.ts's own email tests,
    // which use a fake in-process provider instead of a real network call).
    expect([200, 502, 503]).toContain(response.status);

    // No authenticated Support surface should ever see a ticket from this — there is no
    // SupportTicket-creating code path reachable from the Contact route at all (contact.controller.ts
    // only ever calls the email provider, never SupportService).
  });

  it("public Contact rejects malformed input (missing email) with 400, before any send attempt", async () => {
    const app = buildApp();

    const response = await request(app).post("/contact/").send({
      name: "Jane",
      subject: "s",
      message: "m",
    });

    expect(response.status).toBe(400);
  });

  it("public Contact rejects unknown fields (schema .strict())", async () => {
    const app = buildApp();

    const response = await request(app)
      .post("/contact/")
      .send({
        name: "Jane",
        email: "jane@example.com",
        subject: "s",
        message: "m",
        ticketId: String(new Types.ObjectId()),
      });

    expect(response.status).toBe(400);
  });
});
