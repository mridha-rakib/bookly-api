import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { Argon2PasswordHasher } from "../../../src/modules/auth/password-hasher.js";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingRepository } from "../../../src/modules/booking/booking.repository.js";
import { BookingCreationClaimModel } from "../../../src/modules/booking/booking-creation-claim.model.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import { readOwnedPackageBatchCompletion } from "../../../src/modules/booking/package-batch-completion.js";
import { PackageBatchFinancialPersistence } from "../../../src/modules/booking/package-batch-financial-persistence.js";
import { PackageLifecycleService } from "../../../src/modules/booking/package-lifecycle.service.js";
import type { LifecycleIntent } from "../../../src/modules/booking/package-lifecycle-operation.js";
import { PackageLifecycleOperations } from "../../../src/modules/booking/package-lifecycle-operation.js";
import { BusinessClientModel } from "../../../src/modules/client/client.model.js";
import { ClientRepository } from "../../../src/modules/client/client.repository.js";
import { FinancialRelationshipRepository } from "../../../src/modules/client/financial-relationship.repository.js";
import { FinancialRelationshipService } from "../../../src/modules/client/financial-relationship.service.js";
import { PackageProgressV2Model } from "../../../src/modules/package-progress/package-progress-v2.model.js";
import { PackageViewService } from "../../../src/modules/package-progress/package-view.service.js";
import { CustomerPaymentProfileRepository } from "../../../src/modules/payment/customer-payment-profile.repository.js";
import { PaymentService } from "../../../src/modules/payment/payment.service.js";
import { PaymentAttemptModel } from "../../../src/modules/payment/payment-attempt.model.js";
import { PaymentAttemptRepository } from "../../../src/modules/payment/payment-attempt.repository.js";
import { RefundOperationRepository } from "../../../src/modules/payment/refund-operation.repository.js";
import { ServiceCategoryRepository } from "../../../src/modules/services/service-category.repository.js";
import { StaffMembershipModel } from "../../../src/modules/staff/staff.model.js";
import { UserModel, UserProfileModel } from "../../../src/modules/user/user.model.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import { createApiRouter } from "../../../src/routes/api-router.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import { FakePaymentGateway } from "../../helpers/fake-payment-gateway.js";
import { INTERNAL_TIME, packageBatchFixture } from "../../helpers/package-batch-fixture.js";
import { openPackageConsentBrowser } from "../../helpers/package-consent-browser.js";
import { connectIsolatedDatabase, stopIsolatedReplicaSet } from "./mongo-replset-helper.js";

// A process-local setup grant, closed permanently before the HTTP listener starts.
// The actual verifier is used for every subsequent runtime call, including flags=true.
const setup = vi.hoisted(() => ({ allow: true }));
vi.mock("../../../src/modules/booking/package-purchase-authority.js", async (original) => ({
  ...(await original<object>()),
  verifyPackagePurchaseConsentCertification: vi.fn(async (...args: unknown[]) => {
    if (setup.allow) return undefined; // Existing synthetic setup only, before the listener.
    const shipped =
      await original<typeof import("../../../src/modules/booking/package-purchase-authority.js")>();
    return Reflect.apply(shipped.verifyPackagePurchaseConsentCertification, undefined, args);
  }),
}));
vi.mock("../../../src/modules/booking/package-batch-authority.js", async (original) => {
  const shipped =
    await original<typeof import("../../../src/modules/booking/package-batch-authority.js")>();
  return {
    ...shipped,
    verifyPackageBatchActivation: () =>
      setup.allow ? Promise.resolve() : shipped.verifyPackageBatchActivation(),
  };
});
vi.mock("../../../src/modules/payment/stripe-payment-gateway.js", async () => ({
  StripePaymentGateway: (await import("../../helpers/fake-payment-gateway.js")).FakePaymentGateway,
}));
vi.mock("../../../src/modules/payment/stripe-tax-gateway.js", async () => ({
  StripeTaxGateway: (await import("../../helpers/fake-tax-gateway.js")).FakeTaxGateway,
}));

const artifacts = process.env["BOOKLY_S6_FINAL_ARTIFACTS"];
beforeAll(async () => {
  if (artifacts) await connectIsolatedDatabase();
}, 120000);
afterAll(async () => {
  if (artifacts) await stopIsolatedReplicaSet();
});
it.skipIf(!artifacts)(
  "S6-FINAL populated Customer, Owner and Supervisor actual Next with shipped HTTP denial",
  async () => {
    if (!artifacts) throw Error("Explicit isolated artifacts directory required");
    await mkdir(artifacts, { recursive: true });
    const t = await packageBatchFixture({
      count: 3,
      group: true,
      addon: true,
      bundlePriceCents: 20000,
      mode: "FINITE",
    });
    const password = "Only-Test-Password-123!";
    const hash = await new Argon2PasswordHasher().hash(password);
    await UserModel.updateOne(
      { _id: t.f.context.customerUserId },
      {
        $set: {
          normalizedEmail: "customer-a@final.test",
          passwordHash: hash,
          authProviders: ["PASSWORD"],
        },
      },
    );
    await UserProfileModel.create({
      userId: t.f.context.customerUserId,
      firstName: "Package",
      lastName: "Customer",
      gender: "other",
    });
    const accounts = {
      customer: "customer-a@final.test",
      other: "customer-b@final.test",
      owner: "owner@final.test",
      supervisor: "supervisor@final.test",
      staff: "staff@final.test",
    };
    const supervisor = t.f.providers.find((p) => p.role === "SUPERVISOR");
    const staff = t.f.providers.find((p) => p.role === "STAFF");
    if (!supervisor || !staff) throw Error("Membership fixtures required");
    const otherId = new Types.ObjectId();
    for (const [id, email, role] of [
      [t.f.business.ownerUserId, accounts.owner, "BUSINESS_OWNER"],
      [supervisor.userId, accounts.supervisor, "SUPERVISOR"],
      [staff.userId, accounts.staff, "STAFF"],
      [otherId, accounts.other, "CUSTOMER"],
    ] as const) {
      await UserModel.create({
        _id: id,
        normalizedEmail: email,
        passwordHash: hash,
        authProviders: ["PASSWORD"],
        role,
        status: "ACTIVE",
        security: { passwordUpdatedAt: new Date() },
      });
      if (role === "BUSINESS_OWNER" || role === "CUSTOMER")
        await UserProfileModel.create({
          userId: id,
          firstName: role === "CUSTOMER" ? "Other" : "Owner",
          lastName: "Final",
          gender: "other",
        });
    }
    await BusinessClientModel.updateOne(
      { _id: t.scope.businessClientId },
      { $set: { activatedAt: INTERNAL_TIME } },
    );
    const category = await new ServiceCategoryRepository().create({
      businessId: t.f.business._id,
      name: "F1",
      nameKey: "f1",
    });
    t.f.business.set("subcategories", ["F1"]);
    await t.f.business.save();
    t.f.definition.set("serviceCategoryId", category._id);
    await t.f.definition.save();
    const gateway = new FakePaymentGateway(),
      attempts = new PaymentAttemptRepository(),
      refunds = new RefundOperationRepository();
    const relationships = new FinancialRelationshipService(
      new FinancialRelationshipRepository(),
      attempts,
      refunds,
      new BookingRepository(),
      new BookingCreationClaimRepository(),
      new ClientRepository(),
    );
    const payments = new PaymentService(
      gateway,
      new CustomerPaymentProfileRepository(),
      new UserRepository(),
      attempts,
      refunds,
    );
    let now = INTERNAL_TIME;
    const writer = new PackageBatchFinancialPersistence(
      t.writer,
      relationships,
      payments,
      () => now,
    );
    const full = await writer.complete(t.scope);
    const lifecycle = new PackageLifecycleService(
      t.availability,
      t.reservations,
      t.booking,
      () => now,
      payments,
    );
    const first = full.bookings[0];
    const item = full.progress.items[0];
    if (!first || !item) throw Error("Initial batch required");
    const intent = (action: LifecycleIntent["action"], extra: Partial<LifecycleIntent> = {}) => ({
      key: `s6-final:${new Types.ObjectId()}`,
      action,
      businessId: t.scope.businessId,
      businessClientId: t.scope.businessClientId,
      packageProgressId: full.progress._id,
      ...extra,
    });
    await lifecycle.business(
      t.f.business.ownerUserId,
      "BUSINESS_OWNER",
      t.f.context.customerUserId,
      intent("VENUE_SETTLEMENT", {
        bookingId: full.progress.originBookingId,
        venuePayment: { settlement: "FULL" },
      }),
    );
    const addonId = first.serviceLines[0]?.addons[0]?.addonId;
    if (!addonId) throw Error("Exact assigned Add-on required");
    const redeem = intent("REDEEM", {
      packageItemId: item.packageItemId,
      staffMembershipId: first.serviceLines[0]?.responsibleStaffMembershipId,
      startAt: new Date(first.schedule.startAt.getTime() + 86400000),
      dues: { addonIds: [addonId], paymentMethod: "VENUE" },
    });
    const ops = new PackageLifecycleOperations();
    const fullIntent = {
      ...redeem,
      version: 1 as const,
      actorUserId: t.f.context.customerUserId,
      customerUserId: t.f.context.customerUserId,
      actorRole: "CUSTOMER" as const,
    };
    const quote = await ops.presentSession(t.scope.customer, fullIntent, now);
    await ops.acceptSession(
      t.scope.customer,
      fullIntent,
      {
        quoteId: quote.quoteId,
        termsHash: quote.termsHash,
        disclosureHash: quote.disclosureHash,
        challenge: quote.challenge,
        action: "ACCEPT_SESSION_DUES",
      },
      now,
    );
    const redeemed = await lifecycle.customer(t.scope.customer, redeem);
    if (!redeemed?.booking) throw Error("Source-valid redemption required");
    await lifecycle.business(
      t.f.business.ownerUserId,
      "BUSINESS_OWNER",
      t.f.context.customerUserId,
      intent("COMPLETE", { bookingId: first._id }),
    );
    const initialMembers = full.bookings.map((b) => String(b._id));
    const replay = await writer.complete(t.scope);
    expect(replay.bookings.map((b) => String(b._id))).toEqual(initialMembers);
    expect(String(replay.progress.originBookingId)).toBe(String(full.progress.originBookingId));
    // Exercise expiry without inventing counters; only remaining unscheduled credits move to X.
    const validity =
      full.progress.creditAccountingVersion === 2
        ? full.progress.purchasedContract.validity
        : undefined;
    if (validity?.mode !== "FINITE") throw Error("Finite fixture required");
    now = validity.expiresAt;
    await lifecycle.customer(t.scope.customer, intent("EXPIRE"));
    expect(await readOwnedPackageBatchCompletion(t.scope)).toBeTruthy();
    setup.allow = false;
    const { verifyPackageBatchActivation } = await import(
      "../../../src/modules/booking/package-batch-authority.js"
    );
    await expect(verifyPackageBatchActivation()).rejects.toMatchObject({
      code: "PACKAGE_BATCH_ACTIVATION_UNAVAILABLE",
    });
    const expected = (
      await new PackageViewService().owned(
        String(t.f.context.customerUserId),
        String(full.progress._id),
      )
    ).packages[0];
    if (!expected) throw Error("Owned DTO required");
    expect(expected.sessions.some((s) => s.booking?.role === "REDEMPTION")).toBe(true);
    const initialHash = JSON.stringify(
      await BookingCreationClaimModel.findOne()
        .select("packageBatchCompletion packageBatchMaterialization financialContract")
        .lean(),
    );
    const counts = async () => [
      await BookingModel.countDocuments(),
      await PackageProgressV2Model.countDocuments(),
      await PaymentAttemptModel.countDocuments(),
    ];
    const beforeCounts = await counts();
    const origins: string[] = [],
      http: { method: string; path: string; status: number }[] = [];
    const app = express();
    app.use((req, res, next) => {
      const path = req.originalUrl;
      res.on("finish", () => http.push({ method: req.method, path, status: res.statusCode }));
      const origin = req.headers.origin;
      if (origin && !origins.includes(origin)) return res.sendStatus(403);
      if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      if (req.method === "OPTIONS") return res.sendStatus(204);
      next();
    });
    app.use(express.json());
    app.use("/api/v1", createApiRouter({ getConnectionState: () => "connected" }));
    app.use(createErrorHandler({ isProduction: true }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((done) => server.once("listening", done));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw Error("Local API required");
      const bearer = async (
        userId: Types.ObjectId,
        role: "CUSTOMER" | "SUPERVISOR" | "STAFF" | "BUSINESS_OWNER",
      ) => `Bearer ${await issueTestAccessToken(t.tokens, { userId, role })}`;
      await request(app)
        .get(`/api/v1/package-views/owned/${full.progress._id}`)
        .set("Authorization", await bearer(otherId, "CUSTOMER"))
        .expect(404);
      await request(app).get(`/api/v1/package-views/owned/${full.progress._id}`).expect(401);
      const settlementUrl = `/api/v1/package-views/settlement/${t.scope.businessId}/${redeemed.booking._id}`;
      await request(app)
        .get(settlementUrl)
        .set("Authorization", await bearer(staff.userId, "STAFF"))
        .expect(403);
      await request(app)
        .get(`/api/v1/package-views/settlement/${new Types.ObjectId()}/${first._id}`)
        .set("Authorization", await bearer(t.f.business.ownerUserId, "BUSINESS_OWNER"))
        .expect(403);
      const { runPackageFinalNext } = await import(
        pathToFileURL(resolve("../client/tests/e2e/package-final-next.mjs")).href
      );
      await runPackageFinalNext({
        clientRoot: resolve("../client"),
        apiOrigin: `http://127.0.0.1:${address.port}`,
        businessId: String(t.scope.businessId),
        packageId: String(t.f.definition._id),
        progressId: String(full.progress._id),
        initialBookingId: String(first._id),
        bookingId: String(redeemed.booking._id),
        expected,
        accounts,
        password,
        artifacts,
        openBrowser: openPackageConsentBrowser,
        setUiOrigin: (origin: string) => origins.push(origin),
        revokeSupervisor: async () => {
          await StaffMembershipModel.updateOne(
            { _id: supervisor._id },
            { $set: { employmentActive: false } },
          );
        },
      });
      expect(await counts()).toEqual(beforeCounts);
      expect(
        JSON.stringify(
          await BookingCreationClaimModel.findOne()
            .select("packageBatchCompletion packageBatchMaterialization financialContract")
            .lean(),
        ),
      ).toBe(initialHash);
      expect(setup.allow).toBe(false);
      expect(gateway.paymentIntentInputs).toHaveLength(0);
      await writeFile(
        resolve(artifacts, "actual-api-requests.json"),
        JSON.stringify(http, null, 2),
      );
      await writeFile(
        resolve(artifacts, "setup-and-read-invariants.json"),
        JSON.stringify(
          {
            syntheticAuthority: "VITEST_SETUP_ONLY_CLOSED_BEFORE_LISTEN",
            beforeCounts,
            afterCounts: await counts(),
            initialMembers,
            origin: String(full.progress.originBookingId),
            expected,
            originalF2Unchanged: true,
          },
          null,
          2,
        ),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
  600000,
);
