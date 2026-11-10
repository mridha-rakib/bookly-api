import express, { type Request } from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createErrorHandler } from "../../src/common/middleware/error-handler.js";
import {
  createAuthenticateAccessTokenMiddleware,
  requireActiveUser,
  requireRoles,
} from "../../src/modules/auth/auth.middleware.js";
import { AuthService } from "../../src/modules/auth/auth.service.js";
import { TokenService } from "../../src/modules/auth/token.service.js";
import { BookingModel } from "../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../src/modules/booking/booking.repository.js";
import { PaymentAttemptModel } from "../../src/modules/payment/payment-attempt.model.js";
import { createSuperAdminRoute } from "../../src/modules/super-admin/super-admin.route.js";
import { SuperAdminCustomerRepository } from "../../src/modules/super-admin/super-admin-customer.repository.js";
import { SuperAdminCustomerStatusService } from "../../src/modules/super-admin/super-admin-customer-status.service.js";
import type { UserDocument, UserStatusHistoryEntry } from "../../src/modules/user/user.model.js";
import { UserRepository } from "../../src/modules/user/user.repository.js";
import type { UserRole, UserStatus } from "../../src/modules/user/user.types.js";

/** In-memory Users with the same compare-and-set semantics as transitionCustomerStatus. */
let users: Map<string, UserDocument>;
let transitions: Array<{ id: string; expected: UserStatus; entry: UserStatusHistoryEntry }>;

const ids = {
  customer: "650000000000000000000010",
  dormant: "650000000000000000000011",
  deleted: "650000000000000000000012",
  owner: "650000000000000000000001",
  admin: "650000000000000000000002",
  adminB: "650000000000000000000003",
  staff: "650000000000000000000004",
  otherCustomer: "650000000000000000000005",
};

function seed(id: string, role: UserRole, status: UserStatus = "ACTIVE"): void {
  users.set(id, {
    _id: new Types.ObjectId(id),
    role,
    status,
    normalizedEmail: `${id}@example.test`,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  } as UserDocument);
}

function cas(id: string, expected: UserStatus, entry: UserStatusHistoryEntry): UserDocument | null {
  transitions.push({ id, expected, entry });
  const user = users.get(id);
  if (user?.role !== "CUSTOMER" || user.status !== expected) return null;
  const next = {
    ...user,
    status: entry.toStatus,
    statusHistory: [...(user.statusHistory ?? []), entry],
  } as UserDocument;
  users.set(id, next);
  return next;
}

beforeEach(() => {
  users = new Map();
  transitions = [];
  seed(ids.customer, "CUSTOMER");
  seed(ids.dormant, "CUSTOMER", "DORMANT");
  seed(ids.deleted, "CUSTOMER", "DELETED");
  seed(ids.otherCustomer, "CUSTOMER");
  seed(ids.owner, "BUSINESS_OWNER");
  seed(ids.admin, "SUPER_ADMIN");
  seed(ids.adminB, "SUPER_ADMIN");
  seed(ids.staff, "STAFF");
  vi.spyOn(UserRepository.prototype, "findById").mockImplementation(
    async (id) => users.get(String(id)) ?? null,
  );
  vi.spyOn(UserRepository.prototype, "transitionCustomerStatus").mockImplementation(
    async (id, expected, entry) => cas(String(id), expected, entry),
  );
  vi.spyOn(UserRepository.prototype, "ensureCustomerSessionsRevoked").mockResolvedValue(true);
  vi.spyOn(TokenService.prototype, "verifyAccessToken").mockImplementation(
    async (token) => ({ sub: token, sid: token }) as never,
  );
  vi.spyOn(TokenService.prototype, "isAccessTokenSessionLive").mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

function superAdminApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Request & { id: string }).id = "req-p226";
    next();
  });
  app.use("/super-admin", createSuperAdminRoute());
  app.use(createErrorHandler());
  return app;
}

const post = (path: string, actor: string, body: object = {}) =>
  request(superAdminApp())
    .post(`/super-admin/customers/${path}`)
    .set("Authorization", `Bearer ${actor}`)
    .send(body);

describe("P2.2.6 Super Admin suspends and reactivates Customers", () => {
  it("suspends an ACTIVE Customer with one atomic, audited transition", async () => {
    const response = await post(`${ids.customer}/suspend`, ids.admin, { reason: " Fraud review " });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      customerId: ids.customer,
      status: "SUSPENDED",
      changed: true,
      change: {
        action: "SUSPEND",
        fromStatus: "ACTIVE",
        toStatus: "SUSPENDED",
        actorUserId: ids.admin,
        reason: "Fraud review",
      },
    });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ id: ids.customer, expected: "ACTIVE" });
    const stored = users.get(ids.customer);
    expect(stored?.status).toBe("SUSPENDED");
    expect(stored?.statusHistory).toEqual([
      expect.objectContaining({
        action: "SUSPEND",
        fromStatus: "ACTIVE",
        toStatus: "SUSPENDED",
        actorRole: "SUPER_ADMIN",
        reason: "Fraud review",
        requestId: "req-p226",
        changedAt: expect.any(Date),
      }),
    ]);
    expect(String(stored?.statusHistory?.[0]?.actorUserId)).toBe(ids.admin);
  });

  it("repeating an action that already holds is idempotent: changed=false, no new audit row", async () => {
    await post(`${ids.customer}/suspend`, ids.admin);
    const again = await post(`${ids.customer}/suspend`, ids.adminB);
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({
      customerId: ids.customer,
      status: "SUSPENDED",
      changed: false,
    });
    expect(users.get(ids.customer)?.statusHistory).toHaveLength(1);

    const reactivateActive = await post(`${ids.otherCustomer}/reactivate`, ids.admin);
    expect(reactivateActive.body.data).toEqual({
      customerId: ids.otherCustomer,
      status: "ACTIVE",
      changed: false,
    });
    expect(users.get(ids.otherCustomer)?.statusHistory).toBeUndefined();
  });

  it("reactivation restores the status in force before the suspension (ACTIVE or DORMANT)", async () => {
    await post(`${ids.customer}/suspend`, ids.admin);
    await post(`${ids.dormant}/suspend`, ids.admin);

    const active = await post(`${ids.customer}/reactivate`, ids.adminB, { reason: "Cleared" });
    const dormant = await post(`${ids.dormant}/reactivate`, ids.adminB);

    expect(active.body.data).toMatchObject({
      status: "ACTIVE",
      changed: true,
      change: {
        action: "REACTIVATE",
        fromStatus: "SUSPENDED",
        toStatus: "ACTIVE",
        reason: "Cleared",
      },
    });
    expect(dormant.body.data).toMatchObject({ status: "DORMANT", changed: true });
    expect(users.get(ids.customer)?.statusHistory?.map((entry) => entry.action)).toEqual([
      "SUSPEND",
      "REACTIVATE",
    ]);
  });

  it("a legacy SUSPENDED Customer with no history reactivates to ACTIVE", async () => {
    seed(ids.customer, "CUSTOMER", "SUSPENDED");
    const response = await post(`${ids.customer}/reactivate`, ids.admin);
    expect(response.body.data).toMatchObject({ status: "ACTIVE", changed: true });
  });

  it("only a Super Admin can act: every other role gets 403 and nothing changes", async () => {
    for (const actor of [ids.owner, ids.staff, ids.otherCustomer]) {
      const response = await post(`${ids.customer}/suspend`, actor);
      expect(response.status).toBe(403);
    }
    const anonymous = await request(superAdminApp())
      .post(`/super-admin/customers/${ids.customer}/suspend`)
      .send({});
    expect(anonymous.status).toBe(401);
    expect(transitions).toHaveLength(0);
    expect(users.get(ids.customer)?.status).toBe("ACTIVE");
  });

  it("a suspended Super Admin session cannot act either", async () => {
    seed(ids.admin, "SUPER_ADMIN", "SUSPENDED");
    const response = await post(`${ids.customer}/suspend`, ids.admin);
    expect(response.status).toBe(403);
    expect(response.body.errors[0].code).toBe("USER_SUSPENDED");
    expect(transitions).toHaveLength(0);
  });

  it("only CUSTOMER targets: other roles and unknown ids are the same 404; DELETED is a 409", async () => {
    for (const target of [
      ids.owner,
      ids.admin,
      ids.adminB,
      ids.staff,
      "650000000000000000000099",
    ]) {
      const response = await post(`${target}/suspend`, ids.admin);
      expect(response.status).toBe(404);
      expect(response.body.errors[0].code).toBe("SUPER_ADMIN_CUSTOMER_NOT_FOUND");
    }
    const deleted = await post(`${ids.deleted}/reactivate`, ids.admin);
    expect(deleted.status).toBe(409);
    expect(deleted.body.errors[0].code).toBe("SUPER_ADMIN_CUSTOMER_DELETED");
    expect(transitions).toHaveLength(0);
    expect(users.get(ids.owner)?.status).toBe("ACTIVE");
  });

  it("validates the path id and a strict, bounded body", async () => {
    expect((await post("not-an-id/suspend", ids.admin)).status).toBe(400);
    expect((await post(`${ids.customer}/suspend`, ids.admin, { status: "ACTIVE" })).status).toBe(
      400,
    );
    expect(
      (await post(`${ids.customer}/suspend`, ids.admin, { reason: "x".repeat(501) })).status,
    ).toBe(400);
    expect(transitions).toHaveLength(0);
  });

  it("two Super Admins suspending at once: exactly one transition and one audit row", async () => {
    const [first, second] = await Promise.all([
      post(`${ids.customer}/suspend`, ids.admin),
      post(`${ids.customer}/suspend`, ids.adminB),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect([first.body.data.changed, second.body.data.changed].sort()).toEqual([false, true]);
    expect(users.get(ids.customer)?.statusHistory).toHaveLength(1);
  });

  it("a lost compare-and-set to a conflicting change is a 409 with the current status", async () => {
    const service = new SuperAdminCustomerStatusService({
      ensureCustomerSessionsRevoked: async () => true,
      findById: async (id) => users.get(String(id)) ?? null,
      transitionCustomerStatus: async () => {
        // Another admin changed the account (to DORMANT) between our read and write.
        seed(ids.customer, "CUSTOMER", "DORMANT");
        return null;
      },
    });
    await expect(
      service.suspend({ userId: ids.admin, role: "SUPER_ADMIN" }, ids.customer),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: [expect.objectContaining({ code: "CURRENT_STATUS_DORMANT" })],
    });

    // Lost to an identical change: converges as changed=false, never a second audit row.
    seed(ids.otherCustomer, "CUSTOMER");
    const converging = new SuperAdminCustomerStatusService({
      ensureCustomerSessionsRevoked: async () => true,
      findById: async (id) => users.get(String(id)) ?? null,
      transitionCustomerStatus: async () => {
        seed(ids.otherCustomer, "CUSTOMER", "SUSPENDED");
        return null;
      },
    });
    await expect(
      converging.suspend({ userId: ids.admin, role: "SUPER_ADMIN" }, ids.otherCustomer),
    ).resolves.toEqual({ customerId: ids.otherCustomer, status: "SUSPENDED", changed: false });
  });

  it("the service itself refuses a non-Super-Admin actor", async () => {
    const service = new SuperAdminCustomerStatusService(new UserRepository());
    await expect(
      service.suspend({ userId: ids.owner, role: "BUSINESS_OWNER" }, ids.customer),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(transitions).toHaveLength(0);
  });

  it("never touches bookings or payments", async () => {
    const writes = [
      vi.spyOn(BookingModel, "updateOne"),
      vi.spyOn(BookingModel, "updateMany"),
      vi.spyOn(BookingModel, "findOneAndUpdate"),
      vi.spyOn(PaymentAttemptModel, "updateOne"),
      vi.spyOn(PaymentAttemptModel, "updateMany"),
      vi.spyOn(PaymentAttemptModel, "findOneAndUpdate"),
    ];
    await post(`${ids.customer}/suspend`, ids.admin);
    await post(`${ids.customer}/reactivate`, ids.admin);
    for (const spy of writes) expect(spy).not.toHaveBeenCalled();
  });

  it("the Customer detail exposes the latest status actions, newest first", async () => {
    await post(`${ids.customer}/suspend`, ids.admin, { reason: "Chargeback pattern" });
    await post(`${ids.customer}/reactivate`, ids.adminB);
    vi.spyOn(UserRepository.prototype, "findProfileByUserId").mockResolvedValue(null);
    vi.spyOn(BookingRepository.prototype, "listForCustomer").mockResolvedValue({
      bookings: [],
      total: 0,
    });
    vi.spyOn(SuperAdminCustomerRepository.prototype, "summaries").mockResolvedValue(new Map());
    vi.spyOn(SuperAdminCustomerRepository.prototype, "businessNames").mockResolvedValue(new Map());
    vi.spyOn(SuperAdminCustomerRepository.prototype, "statistics").mockResolvedValue({
      total: 0,
      completed: 0,
      noShows: 0,
      upcoming: 0,
    });
    vi.spyOn(SuperAdminCustomerRepository.prototype, "listRelationships").mockResolvedValue({
      relationships: [],
      pagination: { page: 1, limit: 20, total: 0 },
    });

    const response = await request(superAdminApp())
      .get(`/super-admin/customers/${ids.customer}`)
      .set("Authorization", `Bearer ${ids.admin}`);

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("ACTIVE");
    expect(response.body.data.statusHistory).toEqual([
      expect.objectContaining({ action: "REACTIVATE", actorUserId: ids.adminB }),
      expect.objectContaining({
        action: "SUSPEND",
        actorUserId: ids.admin,
        reason: "Chargeback pattern",
      }),
    ]);
    expect(JSON.stringify(response.body.data.statusHistory)).not.toContain("req-p226");
  });
});

describe("P2.2.6 existing sessions are denied after suspension", () => {
  function customerApp() {
    const app = express();
    const authenticate = createAuthenticateAccessTokenMiddleware(
      new TokenService({} as never),
      new UserRepository(),
    );
    app.get(
      "/me/bookings",
      authenticate,
      requireActiveUser(),
      requireRoles(["CUSTOMER"]),
      (_req, res) => {
        res.json({ ok: true });
      },
    );
    app.use(createErrorHandler());
    return app;
  }

  it("the same still-valid access token works before, is 403 USER_SUSPENDED after, and remains denied after reactivation", async () => {
    const call = () =>
      request(customerApp()).get("/me/bookings").set("Authorization", `Bearer ${ids.customer}`);
    expect((await call()).status).toBe(200);

    await post(`${ids.customer}/suspend`, ids.admin);
    vi.mocked(TokenService.prototype.isAccessTokenSessionLive).mockImplementation(
      async (claims) => claims.sub !== ids.customer,
    );
    const denied = await call();
    expect(denied.status).toBe(403);
    expect(denied.body.errors[0].code).toBe("USER_SUSPENDED");

    await post(`${ids.customer}/reactivate`, ids.admin);
    expect((await call()).status).toBe(401);
  });

  it("refresh rejects a suspended Customer with USER_SUSPENDED and revokes the rotated token", async () => {
    await post(`${ids.customer}/suspend`, ids.admin);
    const tokenService = {
      rotateRefreshToken: vi.fn().mockResolvedValue({
        userId: new Types.ObjectId(ids.customer),
        refreshToken: "rotated",
        expiresAt: new Date(),
        tokenFamilyId: "family",
      }),
      revokeRefreshToken: vi.fn().mockResolvedValue(undefined),
      createAccessToken: vi.fn(),
    };
    const auth = new AuthService(
      new UserRepository(),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      tokenService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(auth.refresh("presented")).rejects.toMatchObject({
      statusCode: 403,
      details: [expect.objectContaining({ code: "USER_SUSPENDED" })],
    });
    expect(tokenService.revokeRefreshToken).toHaveBeenCalledWith("rotated");
    expect(tokenService.createAccessToken).not.toHaveBeenCalled();
  });
});
