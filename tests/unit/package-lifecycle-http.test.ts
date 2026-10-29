import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asyncHandler } from "../../src/common/middleware/async-handler.js";
import { createErrorHandler } from "../../src/common/middleware/error-handler.js";
import { PackageBatchUnresolvedError } from "../../src/modules/booking/package-batch-contract.js";
import { PackageCheckoutConflictError } from "../../src/modules/booking/package-checkout.errors.js";
import { PackageCheckoutCustomerAuthority } from "../../src/modules/booking/package-checkout-customer-authority.js";
import { PackageLifecyclePaymentPendingError } from "../../src/modules/booking/package-lifecycle.service.js";
import { PackageLifecycleHttpController } from "../../src/modules/booking/package-lifecycle-http.controller.js";
import type { PackageLifecycleHttpServices } from "../../src/modules/booking/package-lifecycle-http.factory.js";
import { lifecycleHttpSchemas } from "../../src/modules/booking/package-lifecycle-http.schema.js";
import { BusinessClientModel } from "../../src/modules/client/client.model.js";
import { PackageProgressV2Model } from "../../src/modules/package-progress/package-progress-v2.model.js";
import * as views from "../../src/modules/package-progress/package-view.service.js";

// This is the established test-only authority seam, never an application option.
vi.mock("../../src/modules/booking/package-batch-authority.js", async (original) => ({
  ...(await original<object>()),
  verifyPackageBatchActivation: vi.fn(async () => undefined),
}));
const actor = new Types.ObjectId(),
  business = new Types.ObjectId(),
  progressId = new Types.ObjectId(),
  client = new Types.ObjectId(),
  booking = new Types.ObjectId();
const base = {
  businessId: String(business),
  packageProgressId: String(progressId),
  key: "stable-http-request",
};
const committed = {
  result: {
    status: "UPCOMING",
    bookingId: booking,
    committedAt: new Date(),
    tasks: ["secret"],
    money: { paymentIntentId: "secret" },
  },
};
let role: "CUSTOMER" | "BUSINESS_OWNER" | "SUPERVISOR" | "STAFF";
let customer: ReturnType<typeof vi.fn>,
  management: ReturnType<typeof vi.fn>,
  businessCall: ReturnType<typeof vi.fn>;
let services: PackageLifecycleHttpServices;
beforeEach(() => {
  role = "CUSTOMER";
});
afterEach(() => vi.restoreAllMocks());
async function app() {
  const authority = new PackageCheckoutCustomerAuthority(
    {
      verifyAccessToken: vi.fn(async () => ({
        sub: String(actor),
        role: "CUSTOMER",
        sid: "live-http-session",
      })),
      isAccessTokenSessionLive: vi.fn(async () => true),
    } as never,
    { findById: vi.fn(async () => ({ _id: actor, role: "CUSTOMER", status: "ACTIVE" })) } as never,
  );
  customer = vi.fn(async () => committed);
  businessCall = vi.fn(async () => committed);
  management = vi.fn(async () => undefined);
  services = {
    authority,
    lifecycle: { customer, business: businessCall },
    management: { requireBookingManagementAccess: management },
    operations: { presentSession: vi.fn(), acceptSession: vi.fn() },
  } as unknown as PackageLifecycleHttpServices;
  vi.spyOn(PackageProgressV2Model, "findOne").mockReturnValue({
    maxTimeMS: () => ({
      exec: async () => ({
        _id: progressId,
        businessId: business,
        customerUserId: actor,
        businessClientId: client,
        creditAccountingVersion: 2,
      }),
    }),
  } as never);
  vi.spyOn(BusinessClientModel, "exists").mockReturnValue({
    maxTimeMS: async () => ({ _id: client }),
  } as never);
  vi.spyOn(views, "readPackagePurchaseCompletion").mockResolvedValue("VERIFIED");
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.auth = { userId: String(actor), role, status: "ACTIVE" };
    next();
  });
  server.post(
    "/actions/:action",
    asyncHandler(new PackageLifecycleHttpController(services).execute),
  );
  server.use(createErrorHandler({ isProduction: true }));
  return server;
}
describe("P2D strict HTTP adapter behind synthetic authority", () => {
  it.each(["redeem", "reschedule", "cancel", "expire"])(
    "Customer %s maps to existing service without caller identity",
    async (action) => {
      const server = await app();
      const extra =
        action === "redeem"
          ? {
              packageItemId: String(new Types.ObjectId()),
              staffMembershipId: String(new Types.ObjectId()),
              startAt: "2030-08-21T10:00:00+00:00",
            }
          : action === "reschedule"
            ? { bookingId: String(booking), startAt: "2030-08-21T10:00:00+00:00" }
            : action === "cancel"
              ? { bookingId: String(booking) }
              : {};
      const res = await request(server)
        .post(`/actions/${action}`)
        .set("Authorization", "Bearer synthetic")
        .send({ ...base, ...extra })
        .expect(200);
      expect(res.body.data.state).toBe("COMMITTED");
      expect(res.body.data).not.toHaveProperty("tasks");
      expect(res.body.data).not.toHaveProperty("money");
      expect(customer).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ action: action.toUpperCase(), businessClientId: client }),
      );
      expect(customer.mock.calls[0]?.[1]).not.toHaveProperty("actorUserId");
    },
  );
  it.each(["BUSINESS_OWNER", "SUPERVISOR"] as const)(
    "%s maps all supported management actions and denies redemption",
    async (r) => {
      const server = await app();
      role = r;
      for (const action of [
        "cancel",
        "reschedule",
        "complete",
        "mark-no-show",
        "no-show",
        "reverse-no-show",
        "expire",
        "settlement",
      ]) {
        const res = await request(server)
          .post(`/actions/${action}`)
          .send({
            ...base,
            ...(action !== "expire" ? { bookingId: String(booking) } : {}),
            ...(action === "reschedule" ? { startAt: "2030-08-21T10:00:00Z" } : {}),
            ...(action === "settlement" ? { venuePayment: { settlement: "NOT_PAID" } } : {}),
          })
          .expect(200);
        expect(res.body.data.state).toBe("COMMITTED");
      }
      expect(management).toHaveBeenCalledWith(String(actor), r, String(business));
      await request(server)
        .post("/actions/redeem")
        .send({
          ...base,
          packageItemId: String(booking),
          staffMembershipId: String(booking),
          startAt: "2030-08-21T10:00:00Z",
        })
        .expect(403);
    },
  );
  it.each([
    "actorUserId",
    "actorRole",
    "customerUserId",
    "businessClientId",
    "paymentIntentId",
    "amountCents",
  ])("rejects posted %s", async (field) => {
    await request(await app())
      .post("/actions/cancel")
      .send({ ...base, bookingId: String(booking), [field]: "forged" })
      .expect(400);
    expect(customer).not.toHaveBeenCalled();
  });
  it("Staff and Customer management actions never reach domain ports", async () => {
    const server = await app();
    role = "STAFF";
    await request(server)
      .post("/actions/cancel")
      .send({ ...base, bookingId: String(booking) })
      .expect(403);
    role = "CUSTOMER";
    await request(server)
      .post("/actions/complete")
      .send({ ...base, bookingId: String(booking) })
      .expect(403);
    expect(customer).not.toHaveBeenCalled();
    expect(businessCall).not.toHaveBeenCalled();
  });
  it("queries Customer ownership and tenant together; foreign records stay 404", async () => {
    const server = await app();
    vi.mocked(PackageProgressV2Model.findOne).mockReturnValue({
      maxTimeMS: () => ({ exec: async () => null }),
    } as never);
    await request(server)
      .post("/actions/expire")
      .set("Authorization", "Bearer synthetic")
      .send(base)
      .expect(404);
    expect(PackageProgressV2Model.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: progressId, businessId: business, customerUserId: actor }),
    );
    expect(customer).not.toHaveBeenCalled();
  });
  it("unverified purchases deny before any action", async () => {
    const server = await app();
    vi.mocked(views.readPackagePurchaseCompletion).mockResolvedValue("NOT_ESTABLISHED");
    await request(server)
      .post("/actions/expire")
      .set("Authorization", "Bearer synthetic")
      .send(base)
      .expect(409);
    expect(customer).not.toHaveBeenCalled();
  });
  it("revoked management access cannot query the target package", async () => {
    const server = await app();
    role = "SUPERVISOR";
    management.mockRejectedValue(new PackageCheckoutConflictError("revoked"));
    await request(server).post("/actions/expire").send(base).expect(409);
    expect(PackageProgressV2Model.findOne).not.toHaveBeenCalled();
  });
  it.each(["processing", "requires_action", "requires_payment_method"])(
    "%s payment remains pending, never a Booking confirmation",
    async (status) => {
      const server = await app();
      customer.mockRejectedValue(
        new PackageLifecyclePaymentPendingError(status, "attempt", "secret"),
      );
      const res = await request(server)
        .post("/actions/cancel")
        .set("Authorization", "Bearer synthetic")
        .send({ ...base, bookingId: String(booking) })
        .expect(202);
      expect(res.body.data).toMatchObject({ state: "PAYMENT_PENDING", providerStatus: status });
      expect(res.body.data).not.toHaveProperty("bookingId");
    },
  );
  it("uncertain commit reports 202 and duplicate requests retain the same key", async () => {
    const server = await app();
    customer.mockRejectedValue(new PackageBatchUnresolvedError());
    for (let i = 0; i < 2; i++)
      await request(server)
        .post("/actions/cancel")
        .set("Authorization", "Bearer synthetic")
        .send({ ...base, bookingId: String(booking) })
        .expect(202);
    expect(customer.mock.calls.map((c) => c[1].key)).toEqual([base.key, base.key]);
  });
  it("strict wire schemas require absolute instants and exact acceptance evidence", () => {
    expect(
      lifecycleHttpSchemas.reschedule.safeParse({
        ...base,
        bookingId: String(booking),
        startAt: "2030-08-21T10:00:00",
      }).success,
    ).toBe(false);
    expect(lifecycleHttpSchemas["session-acceptance"].safeParse({ ...base }).success).toBe(false);
  });
});
describe("P4K-3 read-only redemption recovery (session-status)", () => {
  const redemption = {
    ...base,
    packageItemId: String(new Types.ObjectId()),
    staffMembershipId: String(new Types.ObjectId()),
    startAt: "2030-08-21T10:00:00+00:00",
    dues: { addonIds: [], paymentMethod: "VENUE" },
  };
  async function withStatus(outcome: unknown) {
    const server = await app(),
      status = vi.fn(async () => outcome);
    (services.lifecycle as unknown as Record<string, unknown>)["customerRedemptionStatus"] = status;
    return { server, status };
  }
  it("COMMITTED returns only the public result and never reaches a mutating port", async () => {
    const { server, status } = await withStatus({ state: "COMMITTED", result: committed.result });
    const res = await request(server)
      .post("/actions/session-status")
      .set("Authorization", "Bearer synthetic")
      .send(redemption)
      .expect(200);
    expect(res.body.data).toMatchObject({
      state: "COMMITTED",
      status: "UPCOMING",
      bookingId: String(booking),
    });
    expect(res.body.data).not.toHaveProperty("tasks");
    expect(res.body.data).not.toHaveProperty("money");
    expect(status).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ action: "REDEEM", key: base.key, businessClientId: client }),
    );
    expect(status.mock.calls[0]?.[1]).not.toHaveProperty("actorUserId");
    expect(customer).not.toHaveBeenCalled();
    expect(businessCall).not.toHaveBeenCalled();
  });
  it("an operation that is not proven complete stays UNRESOLVED (202) without a Booking", async () => {
    const { server } = await withStatus({ state: "UNRESOLVED" });
    const res = await request(server)
      .post("/actions/session-status")
      .set("Authorization", "Bearer synthetic")
      .send(redemption)
      .expect(202);
    expect(res.body.data).toEqual({ state: "UNRESOLVED" });
    expect(customer).not.toHaveBeenCalled();
  });
  it("absent or differently bound operations are indistinguishable 404s", async () => {
    const { server } = await withStatus(null);
    const res = await request(server)
      .post("/actions/session-status")
      .set("Authorization", "Bearer synthetic")
      .send(redemption)
      .expect(404);
    expect(JSON.stringify(res.body)).toContain("PACKAGE_LIFECYCLE_OPERATION_NOT_FOUND");
    expect(customer).not.toHaveBeenCalled();
  });
  it.each(["BUSINESS_OWNER", "SUPERVISOR", "STAFF"] as const)(
    "%s cannot read Customer redemption status",
    async (r) => {
      const { server, status } = await withStatus({ state: "COMMITTED", result: committed.result });
      role = r;
      await request(server).post("/actions/session-status").send(redemption).expect(403);
      expect(status).not.toHaveBeenCalled();
    },
  );
  it.each(["actorUserId", "customerUserId", "businessClientId"])(
    "rejects posted %s",
    async (field) => {
      const { server, status } = await withStatus({ state: "COMMITTED", result: committed.result });
      await request(server)
        .post("/actions/session-status")
        .set("Authorization", "Bearer synthetic")
        .send({ ...redemption, [field]: "forged" })
        .expect(400);
      expect(status).not.toHaveBeenCalled();
    },
  );
});
describe("P4K-4 read-only cancel/reschedule/expiry recovery", () => {
  const bodies = {
    "cancel-status": { ...base, bookingId: String(booking) },
    "reschedule-status": {
      ...base,
      bookingId: String(booking),
      startAt: "2030-08-22T10:00:00+00:00",
    },
    "expire-status": { ...base },
  } as const;
  const mapped = {
    "cancel-status": "CANCEL",
    "reschedule-status": "RESCHEDULE",
    "expire-status": "EXPIRE",
  } as const;
  async function withStatus(outcome: unknown) {
    const server = await app(),
      status = vi.fn(async () => outcome),
      redemption = vi.fn(async () => outcome);
    Object.assign(services.lifecycle as object, {
      customerOperationStatus: status,
      customerRedemptionStatus: redemption,
    });
    return { server, status, redemption };
  }
  it.each(Object.keys(bodies) as Array<keyof typeof bodies>)(
    "%s COMMITTED maps to the exact action and never mutates",
    async (action) => {
      const { server, status, redemption } = await withStatus({
        state: "COMMITTED",
        result: committed.result,
      });
      const res = await request(server)
        .post(`/actions/${action}`)
        .set("Authorization", "Bearer synthetic")
        .send(bodies[action])
        .expect(200);
      expect(res.body.data).toMatchObject({
        state: "COMMITTED",
        status: "UPCOMING",
        bookingId: String(booking),
      });
      expect(res.body.data).not.toHaveProperty("tasks");
      expect(res.body.data).not.toHaveProperty("money");
      expect(status).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          action: mapped[action],
          key: base.key,
          businessClientId: client,
        }),
      );
      expect(status.mock.calls[0]?.[1]).not.toHaveProperty("actorUserId");
      expect(redemption).not.toHaveBeenCalled();
      expect(customer).not.toHaveBeenCalled();
      expect(businessCall).not.toHaveBeenCalled();
    },
  );
  it.each(Object.keys(bodies) as Array<keyof typeof bodies>)(
    "%s UNRESOLVED is 202 and null is a non-disclosing 404",
    async (action) => {
      let { server } = await withStatus({ state: "UNRESOLVED" });
      expect(
        (
          await request(server)
            .post(`/actions/${action}`)
            .set("Authorization", "Bearer synthetic")
            .send(bodies[action])
            .expect(202)
        ).body.data,
      ).toEqual({ state: "UNRESOLVED" });
      ({ server } = await withStatus(null));
      const missing = await request(server)
        .post(`/actions/${action}`)
        .set("Authorization", "Bearer synthetic")
        .send(bodies[action])
        .expect(404);
      expect(JSON.stringify(missing.body)).toContain("PACKAGE_LIFECYCLE_OPERATION_NOT_FOUND");
      expect(customer).not.toHaveBeenCalled();
    },
  );
  it("strict schemas: each status accepts only its own action's fields", async () => {
    const { server, status } = await withStatus({ state: "COMMITTED", result: committed.result });
    // Cross-action bodies: a redemption body on cancel-status, a reschedule body on cancel-status, a cancel body on expire-status.
    await request(server)
      .post("/actions/cancel-status")
      .set("Authorization", "Bearer synthetic")
      .send({
        ...base,
        packageItemId: String(booking),
        staffMembershipId: String(booking),
        startAt: "2030-08-22T10:00:00Z",
      })
      .expect(400);
    await request(server)
      .post("/actions/cancel-status")
      .set("Authorization", "Bearer synthetic")
      .send(bodies["reschedule-status"])
      .expect(400);
    await request(server)
      .post("/actions/expire-status")
      .set("Authorization", "Bearer synthetic")
      .send(bodies["cancel-status"])
      .expect(400);
    await request(server)
      .post("/actions/reschedule-status")
      .set("Authorization", "Bearer synthetic")
      .send({ ...bodies["reschedule-status"], startAt: "2030-08-22T10:00:00" })
      .expect(400);
    for (const field of ["actorUserId", "customerUserId", "businessClientId", "paymentIntentId"])
      await request(server)
        .post("/actions/cancel-status")
        .set("Authorization", "Bearer synthetic")
        .send({ ...bodies["cancel-status"], [field]: "forged" })
        .expect(400);
    expect(status).not.toHaveBeenCalled();
  });
  it("STAFF cannot use any status recovery", async () => {
    const { server, status } = await withStatus({ state: "COMMITTED", result: committed.result });
    role = "STAFF";
    for (const action of Object.keys(bodies) as Array<keyof typeof bodies>)
      await request(server).post(`/actions/${action}`).send(bodies[action]).expect(403);
    expect(status).not.toHaveBeenCalled();
    expect(management).not.toHaveBeenCalled();
  });
  it.each(["BUSINESS_OWNER", "SUPERVISOR"] as const)(
    "P4K-5 %s shared statuses use the management (actor-bound) status, never the Customer one",
    async (r) => {
      const { server, status } = await withStatus({ state: "COMMITTED", result: committed.result });
      role = r;
      const managed = vi.fn(async () => ({ state: "COMMITTED", result: committed.result }));
      Object.assign(services.lifecycle as object, { businessOperationStatus: managed });
      for (const action of Object.keys(bodies) as Array<keyof typeof bodies>)
        await request(server).post(`/actions/${action}`).send(bodies[action]).expect(200);
      expect(status).not.toHaveBeenCalled();
      expect(managed).toHaveBeenCalledTimes(3);
      expect(managed).toHaveBeenCalledWith(
        actor,
        r,
        actor,
        expect.objectContaining({ action: "CANCEL" }),
      );
      expect(management).toHaveBeenCalledWith(String(actor), r, String(business));
    },
  );
  it("a foreign Customer's Progress is 404 before any status read", async () => {
    const { server, status } = await withStatus({ state: "COMMITTED", result: committed.result });
    vi.mocked(PackageProgressV2Model.findOne).mockReturnValue({
      maxTimeMS: () => ({ exec: async () => null }),
    } as never);
    await request(server)
      .post("/actions/cancel-status")
      .set("Authorization", "Bearer synthetic")
      .send(bodies["cancel-status"])
      .expect(404);
    expect(status).not.toHaveBeenCalled();
  });
});
describe("P4K-5 read-only management action recovery", () => {
  const bodies = {
    "complete-status": { ...base, bookingId: String(booking) },
    "mark-no-show-status": { ...base, bookingId: String(booking) },
    "no-show-status": { ...base, bookingId: String(booking) },
    "reverse-no-show-status": { ...base, bookingId: String(booking) },
    "settlement-status": {
      ...base,
      bookingId: String(booking),
      venuePayment: { settlement: "FULL" },
    },
  } as const;
  const mapped = {
    "complete-status": "COMPLETE",
    "mark-no-show-status": "MARK_NO_SHOW",
    "no-show-status": "NO_SHOW",
    "reverse-no-show-status": "REVERSE_NO_SHOW",
    "settlement-status": "VENUE_SETTLEMENT",
  } as const;
  async function withManaged(outcome: unknown) {
    const server = await app(),
      managed = vi.fn(async () => outcome),
      customerStatus = vi.fn(async () => outcome);
    Object.assign(services.lifecycle as object, {
      businessOperationStatus: managed,
      customerOperationStatus: customerStatus,
    });
    return { server, managed, customerStatus };
  }
  it.each(["BUSINESS_OWNER", "SUPERVISOR"] as const)(
    "%s recovers each committed management action without any mutation",
    async (r) => {
      const { server, managed, customerStatus } = await withManaged({
        state: "COMMITTED",
        result: committed.result,
      });
      role = r;
      for (const action of Object.keys(bodies) as Array<keyof typeof bodies>) {
        const res = await request(server)
          .post(`/actions/${action}`)
          .send(bodies[action])
          .expect(200);
        expect(res.body.data).toMatchObject({ state: "COMMITTED", status: "UPCOMING" });
        expect(res.body.data).not.toHaveProperty("money");
        expect(res.body.data).not.toHaveProperty("tasks");
        expect(managed).toHaveBeenLastCalledWith(
          actor,
          r,
          actor,
          expect.objectContaining({
            action: mapped[action],
            key: base.key,
            businessClientId: client,
          }),
        );
      }
      expect(management).toHaveBeenCalledWith(String(actor), r, String(business));
      expect(customerStatus).not.toHaveBeenCalled();
      expect(customer).not.toHaveBeenCalled();
      expect(businessCall).not.toHaveBeenCalled();
    },
  );
  it("UNRESOLVED (including unproven settlement) is 202 and null is a non-disclosing 404", async () => {
    let { server } = await withManaged({ state: "UNRESOLVED" });
    role = "BUSINESS_OWNER";
    expect(
      (
        await request(server)
          .post("/actions/settlement-status")
          .send(bodies["settlement-status"])
          .expect(202)
      ).body.data,
    ).toEqual({ state: "UNRESOLVED" });
    ({ server } = await withManaged(null));
    const missing = await request(server)
      .post("/actions/complete-status")
      .send(bodies["complete-status"])
      .expect(404);
    expect(JSON.stringify(missing.body)).toContain("PACKAGE_LIFECYCLE_OPERATION_NOT_FOUND");
    expect(businessCall).not.toHaveBeenCalled();
  });
  it("Customers and Staff cannot read management-only statuses", async () => {
    const { server, managed, customerStatus } = await withManaged({
      state: "COMMITTED",
      result: committed.result,
    });
    for (const r of ["CUSTOMER", "STAFF"] as const) {
      role = r;
      for (const action of Object.keys(bodies) as Array<keyof typeof bodies>)
        await request(server)
          .post(`/actions/${action}`)
          .set("Authorization", "Bearer synthetic")
          .send(bodies[action])
          .expect(403);
    }
    expect(managed).not.toHaveBeenCalled();
    expect(customerStatus).not.toHaveBeenCalled();
  });
  it("revoked management access is denied before any operation read", async () => {
    const { server, managed } = await withManaged({ state: "COMMITTED", result: committed.result });
    role = "SUPERVISOR";
    management.mockRejectedValue(new PackageCheckoutConflictError("revoked"));
    await request(server)
      .post("/actions/complete-status")
      .send(bodies["complete-status"])
      .expect(409);
    expect(managed).not.toHaveBeenCalled();
    expect(PackageProgressV2Model.findOne).not.toHaveBeenCalled();
  });
  it("strict schemas reject posted identities and other actions' fields", async () => {
    const { server, managed } = await withManaged({ state: "COMMITTED", result: committed.result });
    role = "BUSINESS_OWNER";
    for (const field of [
      "actorUserId",
      "actorRole",
      "customerUserId",
      "businessClientId",
      "amountCents",
      "paymentIntentId",
    ])
      await request(server)
        .post("/actions/complete-status")
        .send({ ...bodies["complete-status"], [field]: "forged" })
        .expect(400);
    await request(server)
      .post("/actions/settlement-status")
      .send(bodies["complete-status"])
      .expect(400);
    await request(server)
      .post("/actions/no-show-status")
      .send({ ...bodies["no-show-status"], startAt: "2030-08-22T10:00:00Z" })
      .expect(400);
    expect(managed).not.toHaveBeenCalled();
  });
});
