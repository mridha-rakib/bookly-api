import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingCreationClaimModel } from "../../../src/modules/booking/booking-creation-claim.model.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import type { FinancialContract } from "../../../src/modules/booking/financial-contract.js";
import { packageCheckoutRetentionSchema } from "../../../src/modules/booking/package-checkout-retention.js";
import { PackageCheckoutRetentionService } from "../../../src/modules/booking/package-checkout-retention.service.js";
import { BusinessTravelSettingsModel } from "../../../src/modules/business-travel-settings/business-travel-settings.model.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "../../helpers/consent-isolated-database.js";
import { CHECK_TIME, checkoutFixture } from "../../helpers/package-checkout-fixture.js";

const claims = new BookingCreationClaimRepository();
const setup = (mode: "FOREVER" | "FINITE" = "FOREVER", count = 6) => {
  const f = checkoutFixture(mode, count);
  let now = CHECK_TIME;
  f.setTime(now);
  const service = new PackageCheckoutRetentionService(
    claims,
    f.dependencies.packages,
    f.preparer,
    600_000,
    () => now,
  );
  return {
    ...f,
    service,
    retain: () => service.prepareAndRetain(f.context, "p3b-operation", f.intent),
    advance: (value: Date) => {
      now = value;
      f.setTime(value);
    },
  };
};

describe("inactive canonical package checkout retention (real local Mongo persistence)", () => {
  beforeAll(async () => {
    const name = await connectIsolatedDatabase();
    expect(name).toMatch(/^bookly_consent_v1_\d+_[a-f0-9]+$/);
    expect(["127.0.0.1", "localhost", "::1"]).toContain(mongoose.connection.host);
    const hello = await mongoose.connection.db?.admin().command({ hello: 1 });
    expect(hello?.["setName"]).toBeTruthy();
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await mongoose.connection.db
          ?.collection("p3b_preflight")
          .insertOne({ disposable: true }, { session });
      });
    } finally {
      await session.endSession();
    }
    process.stdout.write(
      `${JSON.stringify({
        host: mongoose.connection.host,
        database: name,
        replicaSet: hello?.["setName"],
        transactionalPreflight: "PASS",
      })}\n`,
    );
  }, 60_000);
  beforeEach(clearIsolatedDatabase);
  afterAll(stopIsolatedReplicaSet);

  it.each([1, 3, 6])(
    "retains %i real planned identities without activating Bookings",
    async (count) => {
      const f = setup("FOREVER", count);
      const retained = await f.retain();
      const row = await BookingCreationClaimModel.findOne().orFail();
      expect(row.packageCheckoutRetention?.quote.termsHash).toBe(retained.quote.termsHash);
      expect(retained.state).toBe("INTERNAL_RETAINED_NOT_ACCEPTED");
      expect(retained.seed.appointments).toHaveLength(count);
      expect(row.bookingId.equals(retained.quote.payload.originBookingId)).toBe(true);
      expect(row.financialContract).toBeUndefined();
      expect(retained).not.toHaveProperty("acceptance");
      expect(retained.quote.payload).not.toHaveProperty("purchasedAt");
      expect(await mongoose.connection.db?.collection("bookings").countDocuments()).toBe(0);
      expect(await mongoose.connection.db?.collection("paymentattempts").countDocuments()).toBe(0);
    },
  );
  it("concurrent duplicate operations return one stored seed/hash/origin", async () => {
    const f = setup();
    const results = await Promise.all(Array.from({ length: 8 }, () => f.retain()));
    expect(new Set(results.map((row) => row.quote.termsHash)).size).toBe(1);
    expect(new Set(results.map((row) => row.seed.batchId.toHexString())).size).toBe(1);
    expect(await BookingCreationClaimModel.countDocuments()).toBe(1);
  });
  it("reordered selections retain the same operation", async () => {
    const f = setup();
    const first = await f.retain();
    f.intent.selections.reverse();
    expect((await f.retain()).quote.termsHash).toBe(first.quote.termsHash);
  });
  it("changed membership conflicts and preserves the original", async () => {
    const f = setup();
    const first = await f.retain();
    f.intent.selections.pop();
    await expect(f.retain()).rejects.toMatchObject({
      details: [{ code: "BOOKING_IDEMPOTENCY_CONFLICT" }],
    });
    expect(
      (await BookingCreationClaimModel.findOne().orFail()).packageCheckoutRetention?.quote
        .termsHash,
    ).toBe(first.quote.termsHash);
  });
  it("foreign authenticated actor or Business cannot resolve the same key", async () => {
    const f = setup();
    await f.retain();
    const foreignCustomer = new Types.ObjectId();
    for (const context of [
      { ...f.context, customerUserId: foreignCustomer, actorUserId: foreignCustomer },
      { ...f.context, businessId: new Types.ObjectId() },
    ])
      await expect(
        f.service.prepareAndRetain(context, "p3b-operation", f.intent),
      ).rejects.toThrow();
  });
  it("ordinary claims cannot join or release a retained checkout", async () => {
    const f = setup();
    const retained = await f.retain();
    expect(await claims.findByIdempotencyKey("p3b-operation")).toBeNull();
    await claims.release("p3b-operation");
    expect(await BookingCreationClaimModel.countDocuments()).toBe(1);
    await expect(
      claims.claim({
        idempotencyKey: "p3b-operation",
        businessId: f.context.businessId,
        actorUserId: f.context.actorUserId,
        bookingId: retained.quote.payload.originBookingId,
      }),
    ).rejects.toMatchObject({ details: [{ code: "BOOKING_IDEMPOTENCY_CONFLICT" }] });
  });
  it("retention cannot replace an ordinary operation", async () => {
    const f = setup();
    await claims.claim({
      idempotencyKey: "p3b-operation",
      businessId: f.context.businessId,
      actorUserId: f.context.actorUserId,
      bookingId: new Types.ObjectId(),
    });
    await expect(f.retain()).rejects.toMatchObject({
      details: [{ code: "BOOKING_IDEMPOTENCY_CONFLICT" }],
    });
  });
  it.each([6, 12] as const)(
    "retains FINITE%i guarantee without claiming activation",
    async (months) => {
      const f = setup("FINITE");
      f.definition.set("contractTerms.validity.months", months);
      const retained = await f.retain();
      expect(retained.quote.payload.validity).toMatchObject({ mode: "FINITE", months });
      expect(retained.quote.payload).not.toHaveProperty("purchasedAt");
    },
  );
  it.each(["expiry", "revision", "price", "staff", "addon", "relationship"])(
    "revalidates %s on retry",
    async (change) => {
      const f = setup();
      const retained = await f.retain();
      if (change === "expiry") f.advance(retained.seed.expiresAt);
      if (change === "revision") f.definition.revision++;
      if (change === "price") f.definition.bundlePriceCents = 20001;
      if (change === "staff") f.providers[0]?.set("employmentActive", false);
      if (change === "addon")
        vi.mocked(f.dependencies.booking.resolveAddonSnapshots).mockResolvedValue([]);
      if (change === "relationship") f.client.set("financialRelationship", { state: "CONSUMED" });
      await expect(f.retain()).rejects.toThrow();
      expect(await BookingCreationClaimModel.countDocuments()).toBe(1);
    },
  );
  it.each(["$set", "$unset", "$rename"])(
    "blocks %s changes of retained identity",
    async (operator) => {
      const f = setup();
      await f.retain();
      await expect(
        BookingCreationClaimModel.updateOne(
          { idempotencyKey: "p3b-operation" },
          { [operator]: { "packageCheckoutRetention.state": "forged" } },
        ),
      ).rejects.toThrow("immutable");
    },
  );
  it("blocks document mutation, pipeline and replacement including removal", async () => {
    const f = setup();
    await f.retain();
    const row = await BookingCreationClaimModel.findOne().orFail();
    row.set("packageCheckoutRetention.state", "forged");
    row.markModified("packageCheckoutRetention");
    await expect(row.save()).rejects.toThrow();
    await expect(
      BookingCreationClaimModel.replaceOne({ _id: row._id }, { idempotencyKey: "other" }),
    ).rejects.toThrow("immutable");
    await expect(
      BookingCreationClaimModel.findOneAndReplace({ _id: row._id }, { idempotencyKey: "other" }),
    ).rejects.toThrow("immutable");
    await expect(
      BookingCreationClaimModel.updateOne(
        { _id: row._id },
        [{ $unset: "packageCheckoutRetention" }],
        { updatePipeline: true },
      ),
    ).rejects.toThrow("immutable");
  });
  it("rejects forged consent fields/state and inconsistent seed/intent", async () => {
    const f = setup();
    const retained = await f.retain();
    for (const candidate of [
      { ...retained, state: "ACCEPTED" },
      { ...retained, acceptedAt: CHECK_TIME },
      { ...retained, acceptance: { provenance: "CUSTOMER_ACCEPTANCE_RECORD" } },
      { ...retained, seed: { ...retained.seed, batchId: new Types.ObjectId() } },
      {
        ...retained,
        intent: { ...retained.intent, selections: retained.intent.selections.slice(1) },
      },
      {
        ...retained,
        seed: {
          ...retained.seed,
          appointments: retained.seed.appointments.map(() => retained.seed.appointments[0]),
        },
      },
    ])
      expect(packageCheckoutRetentionSchema.safeParse(candidate).success).toBe(false);
  });
  it("retains a winning insert even if its response is lost", async () => {
    const f = setup();
    const lostResponseService = new PackageCheckoutRetentionService(
      {
        findRetainedPackageCheckout: (input) => claims.findRetainedPackageCheckout(input),
        retainPackageCheckout: async (input) => {
          await claims.retainPackageCheckout(input);
          throw new Error("lost write response");
        },
      },
      f.dependencies.packages,
      f.preparer,
      600_000,
      () => CHECK_TIME,
    );
    await expect(
      lostResponseService.prepareAndRetain(f.context, "p3b-operation", f.intent),
    ).rejects.toThrow("lost write response");
    const first = (await BookingCreationClaimModel.findOne().orFail()).packageCheckoutRetention;
    const retry = await f.retain();
    expect(retry.quote.termsHash).toBe(first?.quote.termsHash);
    expect(retry.seed.appointments).toEqual(first?.seed.appointments);
  });
  it("blocks generic financial authority and preserves ordinary financial-contract CAS", async () => {
    const f = setup();
    const retained = await f.retain();
    const quote = retained.quote.payload;
    const contract: FinancialContract = {
      version: 2,
      productKind: "PACKAGE_PURCHASE",
      classification: "FIRST",
      idempotencyKey: "p3b-operation",
      bookingId: quote.originBookingId,
      customerUserId: f.context.customerUserId,
      businessId: f.context.businessId,
      businessClientId: f.client._id,
      currency: "EUR",
      eligibleBasisCents: 20000,
      requiredUpfrontCents: 3500,
      onlineChargeCents: 3500,
      promoDiscountCents: 0,
      travelFeeCents: 0,
      packageBundlePriceCents: 20000,
      bookingTotalCents: 20500,
      upfrontLedgerType: "PLATFORM_FEE",
    };
    await expect(claims.recordFinancialContract("p3b-operation", contract)).rejects.toMatchObject({
      details: [{ code: "BOOKING_FINANCIAL_CONTRACT_CONFLICT" }],
    });
    const update = await BookingCreationClaimModel.updateOne(
      { idempotencyKey: "p3b-operation" },
      { $set: { financialContract: contract } },
    );
    expect(update.matchedCount).toBe(0);
    const direct = await BookingCreationClaimModel.updateOne(
      { idempotencyKey: "p3b-operation" },
      { financialContract: contract },
    );
    expect(direct.matchedCount).toBe(0);
    const rename = await BookingCreationClaimModel.updateOne(
      { idempotencyKey: "p3b-operation" },
      { $rename: { createdAt: "financialContract" } },
      { timestamps: false },
    );
    expect(rename.matchedCount).toBe(0);
    await expect(
      BookingCreationClaimModel.updateOne(
        { idempotencyKey: "p3b-operation" },
        { $rename: { createdAt: "packageRequestBinding" } },
      ),
    ).rejects.toThrow("immutable");
    expect((await BookingCreationClaimModel.findOne().orFail()).financialContract).toBeUndefined();
    const normalContract = {
      ...contract,
      idempotencyKey: "ordinary",
      bookingId: new Types.ObjectId(),
    };
    await claims.claim({
      idempotencyKey: "ordinary",
      businessId: f.context.businessId,
      actorUserId: f.context.actorUserId,
      bookingId: normalContract.bookingId,
    });
    expect(await claims.recordFinancialContract("ordinary", normalContract)).toMatchObject(
      normalContract,
    );
    expect(await claims.recordFinancialContract("ordinary", normalContract)).toMatchObject(
      normalContract,
    );
    await expect(
      claims.recordFinancialContract("ordinary", { ...normalContract, eligibleBasisCents: 20001 }),
    ).rejects.toMatchObject({ details: [{ code: "BOOKING_FINANCIAL_CONTRACT_CONFLICT" }] });
  });
  it.each(["RETURNING", "ZERO"])(
    "retains %s quote without provider success or financial authority",
    async (kind) => {
      const f = setup();
      if (kind === "RETURNING") f.client.set("financialRelationship", { state: "CONSUMED" });
      else f.definition.bundlePriceCents = 0;
      const row = await f.retain();
      expect(row.quote.payload.financials.requiredUpfrontCents).toBe(0);
      expect(row.quote.payload.providerState).toBe("NOT_DISPATCHED");
    },
  );
  it("retains independent add-on/travel manual dues and rejects changed travel fees", async () => {
    const f = setup();
    f.business.visitType = "TRAVEL_TO_CUSTOMER";
    for (const row of f.intent.selections)
      row.travelAddress = {
        city: "Larnaca",
        area: "Area",
        streetName: "Road",
        streetNumber: "1",
        propertyType: "Hotel",
      };
    const settings = new BusinessTravelSettingsModel({
      businessId: f.business._id,
      cities: [{ city: "Larnaca", active: true, feeCents: 200 }],
    });
    vi.mocked(f.dependencies.travel.findByBusinessId).mockResolvedValue(settings);
    const retained = await f.retain();
    expect(retained.quote.payload.financials).toMatchObject({
      travelCents: 1200,
      addonsCents: 500,
      requiredUpfrontCents: 3500,
      manualVenueDuesCents: 18200,
    });
    settings.set("cities.0.feeCents", 300);
    await expect(f.retain()).rejects.toThrow("facts changed");
  });
  it("requires an explicit valid internal lifetime", () => {
    const f = setup();
    for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(
        () =>
          new PackageCheckoutRetentionService(
            claims,
            f.dependencies.packages,
            f.preparer,
            duration,
          ),
      ).toThrow();
  });
});
