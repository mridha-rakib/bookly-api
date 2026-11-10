import express, { type Request } from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createErrorHandler } from "../../src/common/middleware/error-handler.js";
import { TokenService } from "../../src/modules/auth/token.service.js";
import { BookingRepository } from "../../src/modules/booking/booking.repository.js";
import { createSuperAdminRoute } from "../../src/modules/super-admin/super-admin.route.js";
import { SuperAdminCustomerRepository } from "../../src/modules/super-admin/super-admin-customer.repository.js";
import {
  type UserDocument,
  UserModel,
  type UserProfileDocument,
  UserProfileModel,
} from "../../src/modules/user/user.model.js";
import { UserRepository } from "../../src/modules/user/user.repository.js";
import type { UserRole, UserStatus } from "../../src/modules/user/user.types.js";

/** P2.2.8.2.1 — Owner policy: Super Admin never edits any user's personal profile. */
let users: Map<string, UserDocument>;
let profiles: Map<string, UserProfileDocument>;

const ids = {
  customer: "650000000000000000000010",
  suspended: "650000000000000000000011",
  owner: "650000000000000000000001",
  admin: "650000000000000000000002",
  adminB: "650000000000000000000003",
  staff: "650000000000000000000004",
  supervisor: "650000000000000000000006",
};
const v0 = new Date("2026-11-01T10:00:00.000Z");
const historicalEdit = {
  action: "PROFILE_UPDATE" as const,
  fields: ["firstName" as const],
  actorUserId: new Types.ObjectId(ids.admin),
  actorRole: "SUPER_ADMIN" as const,
  requestId: "req-old",
  changedAt: new Date("2026-11-08T09:00:00.000Z"),
};

function seed(id: string, role: UserRole, status: UserStatus = "ACTIVE") {
  users.set(id, {
    _id: new Types.ObjectId(id),
    role,
    status,
    normalizedEmail: `${id}@example.test`,
    authProviders: ["PASSWORD"],
    security: { passwordUpdatedAt: v0 },
    createdAt: v0,
    updatedAt: v0,
  } as UserDocument);
  profiles.set(id, {
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(id),
    firstName: "Dana",
    lastName: "Klein",
    gender: "female",
    phone: { countryCode: "+357", nationalNumber: "99123456", e164: "+35799123456" },
    createdAt: v0,
    updatedAt: v0,
  } as UserProfileDocument);
}

let writeSpies: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  users = new Map();
  profiles = new Map();
  seed(ids.customer, "CUSTOMER");
  seed(ids.suspended, "CUSTOMER", "SUSPENDED");
  seed(ids.owner, "BUSINESS_OWNER");
  seed(ids.admin, "SUPER_ADMIN");
  seed(ids.adminB, "SUPER_ADMIN");
  seed(ids.staff, "STAFF");
  seed(ids.supervisor, "SUPERVISOR");
  const customerProfile = profiles.get(ids.customer);
  if (customerProfile) customerProfile.adminEditHistory = [historicalEdit];

  vi.spyOn(UserRepository.prototype, "findById").mockImplementation(
    async (id) => users.get(String(id)) ?? null,
  );
  vi.spyOn(UserRepository.prototype, "findProfileByUserId").mockImplementation(
    async (id) => profiles.get(String(id)) ?? null,
  );
  vi.spyOn(TokenService.prototype, "verifyAccessToken").mockImplementation(
    async (token) => ({ sub: token, sid: `family-${token}` }) as never,
  );
  vi.spyOn(TokenService.prototype, "isAccessTokenSessionLive").mockResolvedValue(true);
  writeSpies = [
    vi.spyOn(UserProfileModel, "updateOne"),
    vi.spyOn(UserProfileModel, "updateMany"),
    vi.spyOn(UserProfileModel, "findOneAndUpdate"),
    vi.spyOn(UserProfileModel, "findByIdAndUpdate"),
    vi.spyOn(UserProfileModel, "replaceOne"),
    vi.spyOn(UserModel, "updateOne"),
    vi.spyOn(UserModel, "updateMany"),
    vi.spyOn(UserModel, "findOneAndUpdate"),
    vi.spyOn(UserModel, "findByIdAndUpdate"),
  ];
});
afterEach(() => vi.restoreAllMocks());

function app() {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as Request & { id: string }).id = "req-p22821";
    next();
  });
  server.use("/super-admin", createSuperAdminRoute());
  server.use(createErrorHandler());
  return server;
}

const body = { firstName: "Eve", lastName: "Mallory", expectedVersion: v0.toISOString() };

describe("P2.2.8.2.1 Super Admin user profiles are read-only", () => {
  it("no profile mutation is routable for any target or method, and nothing is written", async () => {
    const targets = [ids.customer, ids.suspended, ids.owner, ids.staff, ids.supervisor, ids.adminB];
    const paths = (id: string) => [
      `/super-admin/customers/${id}/profile`,
      `/super-admin/customers/${id}`,
      `/super-admin/users/${id}/profile`,
      `/super-admin/users/${id}`,
    ];
    for (const id of targets) {
      for (const path of paths(id)) {
        for (const method of ["patch", "put", "post"] as const) {
          const response = await request(app())
            [method](path)
            .set("Authorization", `Bearer ${ids.admin}`)
            .send(body);
          expect(response.status, `${method.toUpperCase()} ${path}`).toBe(404);
        }
      }
    }
    for (const spy of writeSpies) expect(spy).not.toHaveBeenCalled();
    expect(profiles.get(ids.customer)).toMatchObject({ firstName: "Dana", lastName: "Klein" });
  });

  it("the removed write path no longer exists on the repository", () => {
    expect("adminUpdateProfileNames" in UserRepository.prototype).toBe(false);
  });

  it("the Customer detail stays read-only: names, email and phone, no edit version", async () => {
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

    const response = await request(app())
      .get(`/super-admin/customers/${ids.customer}`)
      .set("Authorization", `Bearer ${ids.admin}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: ids.customer,
      email: `${ids.customer}@example.test`,
      firstName: "Dana",
      lastName: "Klein",
      phone: { e164: "+35799123456" },
      status: "ACTIVE",
    });
    expect(response.body.data).not.toHaveProperty("profileVersion");
    // Historical audit entries are retained and shown read-only (field names only).
    expect(response.body.data.profileEditHistory).toEqual([
      {
        action: "PROFILE_UPDATE",
        fields: ["firstName"],
        actorUserId: ids.admin,
        changedAt: "2026-11-08T09:00:00.000Z",
      },
    ]);
    expect(profiles.get(ids.customer)?.adminEditHistory).toEqual([historicalEdit]);
    for (const spy of writeSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("Customer suspend/reactivate remains available to the Super Admin", async () => {
    const transition = vi
      .spyOn(UserRepository.prototype, "transitionCustomerStatus")
      .mockResolvedValue(null);
    const response = await request(app())
      .post(`/super-admin/customers/${ids.customer}/suspend`)
      .set("Authorization", `Bearer ${ids.admin}`)
      .send({});
    expect(response.status).not.toBe(404);
    expect(transition).toHaveBeenCalled();
  });
});
