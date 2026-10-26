/** biome-ignore-all lint/style/noNonNullAssertion: Fixture dimensions and successful reads are asserted by these tests; optional chaining would silently skip mutations. */
import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingModel } from "../../../src/modules/booking/booking.model.js";
import { BookingCreationClaimModel } from "../../../src/modules/booking/booking-creation-claim.model.js";
import { BookingCreationClaimRepository } from "../../../src/modules/booking/booking-creation-claim.repository.js";
import { BusinessModel } from "../../../src/modules/business/business.model.js";
import { BusinessClientModel } from "../../../src/modules/client/client.model.js";
import { PackageProgressModel } from "../../../src/modules/package-progress/package-progress.model.js";
import { PackageProgressRepository } from "../../../src/modules/package-progress/package-progress.repository.js";
import { PackageProgressV2Model } from "../../../src/modules/package-progress/package-progress-v2.model.js";
import { PackageProgressV2Repository } from "../../../src/modules/package-progress/package-progress-v2.repository.js";
import { derivePackageProgressV2Totals } from "../../../src/modules/package-progress/package-progress-v2.rules.js";
import { PackageModel } from "../../../src/modules/packages/package.model.js";
import { packageV2Fixture, transaction } from "../../helpers/package-v2-fixture.js";
import {
  AFTER,
  BEFORE,
  CUTOFF,
  prospectiveFixture,
} from "../../helpers/package-v2-prospective-fixture.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

describe("internal v2 purchased entitlements (not customer purchase orchestration)", () => {
  beforeAll(async () => {
    expect(await connectIsolatedDatabase()).toMatch(/^bookly_auth_/);
    expect(mongoose.connection.host).toMatch(/^(127\.0\.0\.1|localhost)$/);
  }, 120000);
  beforeEach(clearIsolatedDatabase);
  afterAll(stopIsolatedReplicaSet);

  it.each([[1], [5], [1, 1, 1], [3, 2, 1]])(
    "stores composition %j with one mandatory origin claim and no root counters",
    async (...quantities) => {
      const f = await packageV2Fixture(quantities);
      const progress = await f.read();
      expect(derivePackageProgressV2Totals(progress)).toEqual({
        totalSessions: quantities.reduce((a, b) => a + b, 0),
        remainingSessions: quantities.reduce((a, b) => a + b, 0) - 1,
        completedSessions: 0,
        availableSessions: quantities.reduce((a, b) => a + b, 0) - 1,
      });
      expect(progress).not.toHaveProperty("remainingSessions");
      expect(progress.items[0]!.packageItemId.equals(f.definition.items[0]!.itemId)).toBe(false);
    },
  );
  it("claims Facial only and restores it once, retaining attempt history", async () => {
    const f = await packageV2Fixture();
    const booking = new Types.ObjectId();
    await transaction((session) => f.repository.claim(f.scope(1), booking, session));
    expect((await f.read()).items.map((item) => item.remainingSessions)).toEqual([2, 1, 1]);
    expect(
      await transaction((session) => f.repository.claim(f.scope(1), booking, session)),
    ).toMatchObject({ isNew: false });
    expect(
      await transaction((session) =>
        f.repository.resolve(f.scope(1), booking, "CANCELLED", session),
      ),
    ).toBe(true);
    expect(
      await transaction((session) =>
        f.repository.resolve(f.scope(1), booking, "CANCELLED", session),
      ),
    ).toBe(false);
    const progress = await f.read();
    expect(progress.items.map((item) => item.remainingSessions)).toEqual([2, 2, 1]);
    expect(progress.sessions.find((attempt) => attempt.bookingId.equals(booking))?.status).toBe(
      "CANCELLED",
    );
  });
  it.each(["COMPLETED", "FORFEITED"] as const)(
    "resolves %s once without consuming another credit",
    async (outcome) => {
      const f = await packageV2Fixture();
      const booking = new Types.ObjectId();
      await transaction((session) => f.repository.claim(f.scope(1), booking, session));
      await transaction((session) => f.repository.resolve(f.scope(1), booking, outcome, session));
      expect(
        await transaction((session) => f.repository.resolve(f.scope(1), booking, outcome, session)),
      ).toBe(false);
      const item = (await f.read()).items[1]!;
      expect(item.remainingSessions).toBe(1);
      expect(item.completedSessions).toBe(outcome === "COMPLETED" ? 1 : 0);
    },
  );
  it("allows only one of two simultaneous last-credit claims", async () => {
    const f = await packageV2Fixture();
    const results = await Promise.allSettled(
      [new Types.ObjectId(), new Types.ObjectId()].map((id) =>
        transaction((session) => f.repository.claim(f.scope(2), id, session)),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const progress = await f.read();
    expect(progress.items[2]!.remainingSessions).toBe(0);
    expect(
      progress.sessions.filter((attempt) => attempt.packageItemId.equals(f.scope(2).packageItemId)),
    ).toHaveLength(1);
  });
  it("retries different-item transactions without losing either decrement", async () => {
    const f = await packageV2Fixture();
    await Promise.all(
      [1, 2].map((index) =>
        transaction((session) => f.repository.claim(f.scope(index), new Types.ObjectId(), session)),
      ),
    );
    expect((await f.read()).items.map((item) => item.remainingSessions)).toEqual([2, 1, 0]);
  });
  it("appends one attempt when identical Booking claims race", async () => {
    const f = await packageV2Fixture();
    const booking = new Types.ObjectId();
    const results = await Promise.all(
      [1, 2].map(() => transaction((session) => f.repository.claim(f.scope(1), booking, session))),
    );
    expect(results.filter((result) => result.isNew)).toHaveLength(1);
    const progress = await f.read();
    expect(progress.items[1]!.remainingSessions).toBe(1);
    expect(progress.sessions.filter((attempt) => attempt.bookingId.equals(booking))).toHaveLength(
      1,
    );
  });
  it("fails closed without an active transaction", async () => {
    const f = await packageV2Fixture();
    const session = await mongoose.startSession();
    try {
      await expect(
        f.repository.claim(f.scope(), new Types.ObjectId(), session),
      ).rejects.toMatchObject({ statusCode: 503 });
    } finally {
      await session.endSession();
    }
  });
  it("allows only one terminal result when cancellation races completion", async () => {
    const f = await packageV2Fixture();
    const booking = new Types.ObjectId();
    await transaction((session) => f.repository.claim(f.scope(1), booking, session));
    const results = await Promise.allSettled(
      (["COMPLETED", "CANCELLED"] as const).map((outcome) =>
        transaction((session) => f.repository.resolve(f.scope(1), booking, outcome, session)),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await f.read(); // Full invariant checked against the actual winning attempt.
  });
  it("rejects wrong-item/service/customer/version writes without touching credits", async () => {
    const f = await packageV2Fixture();
    const before = await f.read();
    for (const scope of [
      { ...f.scope(), serviceId: f.scope(1).serviceId },
      { ...f.scope(), customerUserId: new Types.ObjectId() },
      { ...f.scope(), packageItemId: f.definition.items[0]!.itemId },
    ]) {
      await expect(
        transaction((session) => f.repository.claim(scope, new Types.ObjectId(), session)),
      ).rejects.toMatchObject({ statusCode: 404 });
    }
    await expect(
      transaction((session) =>
        f.repository.resolve(f.scope(1), f.input.originBookingId, "CANCELLED", session),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await f.read()).items).toEqual(before.items);
  });
  it("aborts tentative credit, attempt and related fixture writes atomically", async () => {
    const f = await packageV2Fixture();
    const before = await f.read();
    const booking = new Types.ObjectId();
    await expect(
      transaction(async (session) => {
        await f.repository.claim(f.scope(1), booking, session);
        await mongoose.connection
          .db!.collection("p2_booking_fixtures")
          .insertOne({ _id: booking }, { session });
        await mongoose.connection
          .db!.collection("p2_reservation_fixtures")
          .insertOne({ bookingId: booking }, { session });
        throw new Error("Injected abort");
      }),
    ).rejects.toThrow("Injected abort");
    expect((await f.read()).items).toEqual(before.items);
    expect((await f.read()).sessions).toEqual(before.sessions);
    expect(await mongoose.connection.db!.collection("p2_booking_fixtures").countDocuments()).toBe(
      0,
    );
    expect(
      await mongoose.connection.db!.collection("p2_reservation_fixtures").countDocuments(),
    ).toBe(0);
  });
  it("serializes claim versus void and never commits a scheduled attempt on a void progress", async () => {
    const f = await packageV2Fixture();
    await transaction((session) =>
      f.repository.resolve(f.scope(), f.input.originBookingId, "CANCELLED", session),
    );
    const results = await Promise.allSettled([
      transaction((session) => f.repository.claim(f.scope(1), new Types.ObjectId(), session)),
      transaction((session) =>
        f.repository.void(f.input._id, f.business._id, f.customerId, session),
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const progress = await f.read();
    if (progress.voidedAt) {
      expect(progress.sessions.some((attempt) => attempt.status === "SCHEDULED")).toBe(false);
      expect(derivePackageProgressV2Totals(progress).availableSessions).toBe(0);
    } else expect(progress.sessions.some((attempt) => attempt.status === "SCHEDULED")).toBe(true);
  });
  it("keeps missing-version v1 exact and excludes v2 from every legacy operation", async () => {
    const f = await packageV2Fixture();
    const legacy = new PackageProgressRepository();
    expect(await legacy.findByIdInternal(f.input._id)).toBeNull();
    expect(await legacy.findByIdForCustomer(f.input._id, f.customerId)).toBeNull();
    expect(
      await legacy.findByIdForCustomerAndBusiness(f.input._id, f.business._id, f.customerId),
    ).toBeNull();
    expect(await legacy.listForCustomer(f.customerId)).toEqual([]);
    expect(await legacy.claimSession(f.input._id)).toBeNull();
    await legacy.recordScheduledSession(f.input._id, 2, new Types.ObjectId());
    await legacy.markSessionCompleted(f.input.originBookingId);
    await legacy.resolveSessionOnTerminalStatus(f.input.originBookingId, "RESTORE");
    expect(await legacy.voidPackage(f.input._id)).toBeNull();
    await legacy.deleteById(f.input._id);
    expect((await f.read()).items[0]!.remainingSessions).toBe(2);
    const oldId = new Types.ObjectId();
    await legacy.create({
      _id: oldId,
      businessId: f.business._id,
      customerUserId: f.customerId,
      businessClientId: f.client._id,
      serviceId: f.services[0]!._id,
      originBookingId: new Types.ObjectId(),
      totalSessions: 2,
      remainingSessions: 2,
      completedSessions: 0,
      sessions: [],
      purchaseSnapshot: {
        name: "Legacy",
        bundlePriceCents: 100,
        durationMin: 60,
        sessionsInPackage: 2,
      },
    });
    const raw = await PackageProgressModel.collection.findOne({ _id: oldId });
    expect(raw).not.toHaveProperty("schemaVersion");
    expect((await legacy.claimSession(oldId))?.remainingSessions).toBe(1);
    await expect(
      transaction((session) =>
        f.repository.claim(
          { ...f.scope(), packageProgressId: oldId },
          new Types.ObjectId(),
          session,
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await PackageProgressV2Model.findById(oldId)).toBeNull();
  });
  it("rejects immutable snapshot/identity replacement and saves of existing v2 records", async () => {
    const f = await packageV2Fixture();
    for (const path of [
      "packageId",
      "purchaseSnapshot.bundlePriceCents",
      "items.0.totalSessions",
      "items.0.serviceSnapshot.durationMin",
      "items",
      "schemaVersion",
    ]) {
      await expect(
        PackageProgressV2Model.updateOne({ _id: f.input._id }, { $set: { [path]: 99 } }),
      ).rejects.toThrow();
    }
    const document = await PackageProgressV2Model.findById(f.input._id);
    if (!document) throw new Error("Missing v2");
    document.items[0]!.serviceSnapshot.name = "Changed";
    await expect(document.save()).rejects.toThrow();
    expect((await f.read()).items[0]!.serviceSnapshot.name).toBe("Treatment 0");
  });
  it("rejects cross-Business Service/client linkage during internal creation", async () => {
    const f = await packageV2Fixture(undefined, false);
    const input = { ...f.input, businessClientId: new Types.ObjectId() };
    await expect(
      transaction((session) => f.repository.create(input, session)),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await PackageProgressV2Model.countDocuments()).toBe(0);
  });
  it("rejects missing composition, stale reference terms and wrong Service ownership at creation", async () => {
    const f = await packageV2Fixture(undefined, false);
    if (f.input.creditAccountingVersion === 2) throw new Error("Expected historical fixture");
    const missing = {
      ...f.input,
      items: f.input.items.slice(0, 1),
      purchaseSnapshot: {
        ...f.input.purchaseSnapshot,
        referenceTotalCents: 300,
        discountPercent: 66.67,
      },
    };
    await expect(
      transaction((session) => f.repository.create(missing, session)),
    ).rejects.toMatchObject({ statusCode: 409 });
    await mongoose.connection
      .db!.collection("services")
      .updateOne({ _id: f.services[0]!._id }, { $set: { businessId: new Types.ObjectId() } });
    await expect(
      transaction((session) => f.repository.create(f.input, session)),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
  it("stores strict optional claim metadata without touching financial contracts or provider state", async () => {
    const f = await packageV2Fixture();
    const repository = new BookingCreationClaimRepository();
    const input = {
      idempotencyKey: "p2-binding",
      businessId: f.business._id,
      actorUserId: f.customerId,
      bookingId: f.input.originBookingId,
      packageRequestBinding: {
        version: 1 as const,
        operation: "PURCHASE" as const,
        packageId: f.definition._id,
        selectedItemId: f.definition.items[0]!.itemId,
        requestHash: "a".repeat(64),
        acceptedPurchaseSnapshot: f.input,
      },
    };
    expect(await repository.claim(input)).toMatchObject({ isNew: true });
    expect(await repository.claim(input)).toMatchObject({ isNew: false });
    expect(await repository.findByIdempotencyKey(input.idempotencyKey)).toBeNull();
    expect(
      await repository.findPackageBoundClaim(input.idempotencyKey, f.business._id, f.customerId),
    ).not.toBeNull();
    await repository.release(input.idempotencyKey);
    expect(await BookingCreationClaimModel.countDocuments()).toBe(1);
    await expect(
      repository.claim({
        ...input,
        packageRequestBinding: { ...input.packageRequestBinding, requestHash: "b".repeat(64) },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const stored = await BookingCreationClaimModel.findOne({
      idempotencyKey: input.idempotencyKey,
    }).lean();
    expect(stored).not.toHaveProperty("financialContract");
    await expect(
      BookingCreationClaimModel.updateOne(
        { idempotencyKey: input.idempotencyKey },
        { $set: { "packageRequestBinding.requestHash": "b".repeat(64) } },
      ),
    ).rejects.toThrow("immutable");
    const contract = {
      version: 2 as const,
      productKind: "PACKAGE_PURCHASE" as const,
      classification: "FIRST" as const,
      idempotencyKey: input.idempotencyKey,
      bookingId: input.bookingId,
      customerUserId: f.customerId,
      businessId: f.business._id,
      businessClientId: f.client._id,
      currency: "EUR" as const,
      eligibleBasisCents: 100,
      requiredUpfrontCents: 100,
      promoDiscountCents: 0,
      onlineChargeCents: 100,
      travelFeeCents: 0,
      bookingTotalCents: 100,
      packageBundlePriceCents: 100,
      upfrontLedgerType: "PLATFORM_FEE" as const,
    };
    await repository.recordFinancialContract(input.idempotencyKey, contract);
    await expect(
      repository.claim({
        ...input,
        packageRequestBinding: { ...input.packageRequestBinding, requestHash: "c".repeat(64) },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (await repository.findPackageBoundClaim(input.idempotencyKey, f.business._id, f.customerId))!
        .financialContract,
    ).toMatchObject(contract);
    expect(await mongoose.connection.db!.collection("paymentattempts").countDocuments()).toBe(0);
  });
  it("retains legacy unbound claims and rejects malformed/scope-mismatched metadata", async () => {
    const f = await packageV2Fixture();
    const repository = new BookingCreationClaimRepository();
    const input = {
      idempotencyKey: "legacy-unbound",
      businessId: f.business._id,
      actorUserId: f.customerId,
      bookingId: new Types.ObjectId(),
    };
    expect(await repository.claim(input)).toMatchObject({ isNew: true });
    expect(await repository.claim(input)).toMatchObject({ isNew: false });
    expect(await repository.findByIdempotencyKey(input.idempotencyKey)).not.toBeNull();
    const binding = {
      version: 1,
      operation: "PURCHASE",
      requestHash: "a".repeat(64),
      packageId: f.definition._id,
      selectedItemId: f.definition.items[0]!.itemId,
      acceptedPurchaseSnapshot: f.input,
    };
    await expect(
      new BookingCreationClaimModel({
        ...input,
        idempotencyKey: "wrong-root-scope",
        packageRequestBinding: binding,
      }).validate(),
    ).rejects.toThrow();
    await expect(
      new BookingCreationClaimModel({
        ...input,
        idempotencyKey: "bad-operation",
        packageRequestBinding: { ...binding, operation: "OTHER" },
      }).validate(),
    ).rejects.toThrow();
    await repository.release(input.idempotencyKey);
    expect(await repository.findByIdempotencyKey(input.idempotencyKey)).toBeNull();
  });
});

describe("internal accounting2 atomic expiry and restoration (synthetic accepted snapshots)", () => {
  beforeAll(async () => {
    expect(await connectIsolatedDatabase()).toMatch(/^bookly_auth_/);
    expect(mongoose.connection.host).toMatch(/^(127\.0\.0\.1|localhost)$/);
  }, 120000);
  beforeEach(clearIsolatedDatabase);
  afterAll(stopIsolatedReplicaSet);
  const fixture = async (mode: "FINITE" | "FOREVER" = "FINITE", zeroPrice = false) => {
    const f = await packageV2Fixture(undefined, false);
    if (zeroPrice)
      f.input.purchaseSnapshot = {
        ...f.input.purchaseSnapshot,
        bundlePriceCents: 0,
        discountPercent: 100,
      };
    const input = prospectiveFixture(f.input, mode);
    await PackageModel.updateOne(
      { _id: f.definition._id },
      {
        $set: {
          contractTerms: input.purchasedContract.definition.contractTerms,
          bundlePriceCents: input.purchaseSnapshot.bundlePriceCents,
          items: f.definition.items.map((item) => ({
            itemId: item.itemId,
            serviceId: item.serviceId,
            includedSessions: item.includedSessions,
            referenceUnitPriceCents: item.referenceUnitPriceCents,
            penaltyBasisCents: 5000,
          })),
        },
      },
    );
    let now = BEFORE;
    const repository = new PackageProgressV2Repository(() => now);
    await transaction((session) => repository.create(input, session));
    // Model-valid synthetic origin in the disposable DB, not purchase orchestration,
    // genuine consent, a real reservation or provider payment evidence.
    const amountCents = input.purchaseSnapshot.bundlePriceCents;
    const origin = await BookingModel.create({
      _id: input.originBookingId,
      businessId: input.businessId,
      reference: `S1-${input.originBookingId.toHexString()}`,
      source: "BOOKLY_MANAGED",
      status: "COMPLETED",
      customer: {
        businessClientId: f.client._id,
        customerUserId: input.customerUserId,
        contact: {
          firstName: f.client.firstName,
          normalizedEmail: f.client.normalizedEmail,
          phone: f.client.phone,
        },
      },
      createdBy: { actorUserId: f.ownerId, actorRole: "BUSINESS_OWNER" },
      fulfilment: {
        mode: "AT_BUSINESS_LOCATION",
        businessLocation: {
          city: "Larnaca",
          area: f.business.address.area,
          streetName: f.business.address.streetName,
          streetNumber: f.business.address.streetNumber,
        },
      },
      serviceLines: [
        {
          serviceId: f.services[0]!._id,
          serviceSnapshot: {
            name: f.services[0]!.name,
            pricingMode: "PACKAGE",
            durationMin: 60,
          },
          pricingInput: {
            packageProgressId: input._id,
            packageItemId: input.items[0]!.packageItemId,
          },
          packageContext: {
            packageId: input.packageId,
            packageName: f.definition.name,
            definitionItemId: input.items[0]!.definitionItemId,
            role: "PURCHASE",
          },
          schedulingSnapshot: {
            version: 1,
            baseDurationMin: 60,
            bufferAfterMin: 0,
            processingTimeMin: 0,
            occupiedDurationMin: 60,
          },
          responsibleStaffMembershipId: f.provider._id,
          reservationId: new Types.ObjectId(),
          addons: [],
          amountCents,
        },
      ],
      financials: {
        currency: "EUR",
        servicesSubtotalCents: amountCents,
        addonsSubtotalCents: 0,
        serviceDiscountCents: 0,
        travelFeeCents: 0,
        eligiblePlatformFeeBasisCents: amountCents,
        platformFeeCents: 0,
        depositCents: 0,
        balanceDueCents: amountCents,
        totalCents: amountCents,
      },
      schedule: {
        timezone: f.business.timezone,
        startAt: new Date("2026-01-02T10:00:00Z"),
        endAt: new Date("2026-01-02T11:00:00Z"),
      },
      eventHistory: [],
      completionPayment: {
        paid: true,
        amountCents,
        recordedAt: new Date("2026-01-02T11:00:00Z"),
        recordedBy: f.ownerId,
      },
    });
    const read = async () => {
      const data = await f.read();
      if (data.creditAccountingVersion !== 2) throw new Error("Expected accounting2");
      return data;
    };
    const expire = () =>
      transaction((session) =>
        repository.reconcileExpiry(input._id, input.businessId, input.customerUserId, session),
      );
    return {
      ...f,
      input,
      read,
      repository,
      origin,
      setTime: (time: Date) => {
        now = time;
      },
      expire,
    };
  };
  it("recognizes a model-valid owned settled origin through the nested Customer", async () => {
    const f = await fixture();
    const persisted = await BookingModel.findById(f.input.originBookingId);
    expect(persisted).not.toBeNull();
    await persisted!.validate();
    expect(persisted!.toObject()).not.toHaveProperty("customerUserId");
    expect(persisted!.customer.customerUserId).toEqual(f.customerId);
    expect(persisted!.serviceLines[0]!.serviceId).toEqual(f.input.items[0]!.serviceId);
    expect(persisted!.financials.balanceDueCents).toBe(100);
    const bookingId = new Types.ObjectId();
    await expect(
      transaction((session) => f.repository.claim(f.scope(1), bookingId, session)),
    ).resolves.toMatchObject({ isNew: true });
    const after = await f.read();
    expect(after.items[1]!.remainingSessions).toBe(1);
    expect(after.sessions.filter((attempt) => attempt.bookingId.equals(bookingId))).toHaveLength(1);
    expect(after.originBookingId).toEqual(f.input.originBookingId);
  });
  it.each([
    "foreign Customer",
    "foreign Business",
    "different origin ID",
    "missing origin",
    "unpaid origin",
    "partially settled origin",
  ] as const)(
    "rejects %s without committing credits, attempts or the eligibility fence",
    async (kind) => {
      const f = await fixture();
      if (kind === "foreign Customer") {
        const foreignCustomer = new Types.ObjectId();
        const client = await BusinessClientModel.create({
          businessId: f.business._id,
          createdByUserId: f.ownerId,
          firstName: "Other buyer",
          normalizedEmail: "other-buyer@example.com",
          phone: { countryCode: "+357", nationalNumber: "99112234", e164: "+35799112234" },
          linkState: "LINKED",
          linkedUserId: foreignCustomer,
        });
        f.origin.customer.businessClientId = client._id;
        f.origin.customer.customerUserId = foreignCustomer;
        await f.origin.save();
      } else if (kind === "foreign Business") {
        const foreign = await fixture();
        foreign.client.linkedUserId = f.customerId;
        await foreign.client.save();
        foreign.origin.customer.customerUserId = f.customerId;
        await foreign.origin.save();
        await f.origin.deleteOne();
        // A complete validated foreign Booking, including its own package/client/staff,
        // is placed at the target ID only for the tenant-isolation adversarial case.
        const { _id: _foreignId, ...data } = foreign.origin.toObject();
        await BookingModel.create({
          ...data,
          _id: f.input.originBookingId,
          reference: "S1-FOREIGN",
        });
      } else if (kind === "different origin ID") {
        const { _id: _originId, ...data } = f.origin.toObject();
        await f.origin.deleteOne();
        await BookingModel.create({ ...data, _id: new Types.ObjectId(), reference: "S1-OTHER-ID" });
      } else if (kind === "missing origin") {
        await f.origin.deleteOne();
      } else {
        f.origin.completionPayment = {
          paid: kind !== "unpaid origin",
          amountCents: kind === "unpaid origin" ? 0 : 99,
          recordedAt: BEFORE,
          recordedBy: f.ownerId,
        };
        await f.origin.save();
      }
      const before = await f.read();
      const fence = (await BusinessModel.findById(f.business._id))!.packageEligibilityVersion;
      await expect(
        transaction((session) => f.repository.claim(f.scope(1), new Types.ObjectId(), session)),
      ).rejects.toMatchObject({
        statusCode: 409,
        details: [{ code: "PACKAGE_BALANCE_UNSETTLED" }],
      });
      expect(await f.read()).toEqual(before);
      expect((await BusinessModel.findById(f.business._id))!.packageEligibilityVersion).toBe(fence);
    },
  );
  it("stores the complete strict contract with one canonical P, and no public activation evidence", async () => {
    const f = await fixture();
    const data = await f.read();
    expect(data.purchasedContract).toMatchObject(f.input.purchasedContract);
    expect(data.purchasedContract).not.toHaveProperty("items");
    expect(data.items.map((item) => item.expiredSessions)).toEqual([0, 0, 0]);
    expect(await mongoose.connection.db!.collection("paymentattempts").countDocuments()).toBe(0);
  });
  it("persists zero-price capacity0 with independent P5000", async () => {
    const f = await fixture("FINITE", true);
    expect((await f.read()).purchasedContract.penalty).toMatchObject({
      soldBundlePriceCents: 0,
      lifetimeCapCents: 0,
    });
    expect((await f.read()).items[0]!.penaltyBasisCents).toBe(5000);
  });
  it.each(["COMPLETED", "FORFEITED"] as const)(
    "commutes concurrent expiry with scheduled %s",
    async (outcome) => {
      const f = await fixture();
      f.setTime(AFTER);
      await Promise.all([
        f.expire(),
        transaction((session) =>
          f.repository.resolve(f.scope(), f.input.originBookingId, outcome, session),
        ),
      ]);
      const data = await f.read();
      expect(data.items[0]!.expiredSessions).toBe(2);
      expect(data.sessions[0]!.status).toBe(outcome);
    },
  );
  it("cannot skip strict new-document contract validation through save options", async () => {
    const f = await packageV2Fixture(undefined, false);
    const document = new PackageProgressV2Model({ ...f.input, creditAccountingVersion: 2 });
    await expect(document.save({ validateBeforeSave: false })).rejects.toThrow();
    expect(await PackageProgressV2Model.countDocuments()).toBe(0);
  });
  it.each([BEFORE, CUTOFF, AFTER])(
    "authorizes using a fresh internal clock at %s",
    async (time) => {
      const f = await fixture();
      f.setTime(time);
      const work = transaction((session) =>
        f.repository.claim(f.scope(1), new Types.ObjectId(), session),
      );
      if (time < CUTOFF) await expect(work).resolves.toMatchObject({ isNew: true });
      else await expect(work).rejects.toMatchObject({ statusCode: 409 });
      expect((await f.read()).items[1]!.remainingSessions).toBe(time < CUTOFF ? 1 : 2);
    },
  );
  it("rechecks time after eligibility reads instead of authorizing with stale request time", async () => {
    const f = await fixture();
    let samples = 0;
    const repository = new PackageProgressV2Repository(() => (++samples === 1 ? BEFORE : CUTOFF));
    await expect(
      transaction((session) => repository.claim(f.scope(1), new Types.ObjectId(), session)),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await f.read()).items[1]!.remainingSessions).toBe(2);
  });
  it("expires all available items once without fabricating attempts or altering S", async () => {
    const f = await fixture();
    const before = await f.read();
    f.setTime(CUTOFF);
    expect(await f.expire()).toMatchObject({ isNew: true });
    const after = await f.read();
    expect(after.items.map((item) => [item.remainingSessions, item.expiredSessions])).toEqual([
      [0, 2],
      [0, 2],
      [0, 1],
    ]);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.items.map((item) => item.expiryEvent?.quantity)).toEqual([2, 2, 1]);
    expect(await f.expire()).toMatchObject({ isNew: false });
    expect((await f.read()).items).toEqual(after.items);
    expect(await mongoose.connection.db!.collection("paymentattempts").countDocuments()).toBe(0);
    expect(
      await mongoose.connection.db!.collection("bookingfinancialtransactions").countDocuments(),
    ).toBe(0);
  });
  it("rolls back all item transfers, event evidence and the Business fence on an injected abort", async () => {
    const f = await fixture();
    f.setTime(AFTER);
    const before = await f.read();
    const version = (await BusinessModel.findById(f.business._id))!.packageEligibilityVersion;
    await expect(
      transaction(async (session) => {
        await f.repository.reconcileExpiry(f.input._id, f.business._id, f.customerId, session);
        throw new Error("abort after complete all-item transition");
      }),
    ).rejects.toThrow("abort after complete");
    expect((await f.read()).items).toEqual(before.items);
    expect((await f.read()).expiryReconciledAt).toBeUndefined();
    expect((await BusinessModel.findById(f.business._id))!.packageEligibilityVersion).toBe(version);
  });
  it.each([BEFORE, CUTOFF, AFTER])("persists exact restoration disposition at %s", async (time) => {
    const f = await fixture();
    f.setTime(time);
    const outcome = await transaction((session) =>
      f.repository.resolveWithResult(f.scope(), f.input.originBookingId, "CANCELLED", session),
    );
    expect(outcome).toMatchObject({
      isNew: true,
      restorationDisposition: time < CUTOFF ? "AVAILABLE" : "EXPIRED",
    });
    const data = await f.read();
    expect(data.items[0]!.remainingSessions).toBe(time < CUTOFF ? 3 : 2);
    expect(data.items[0]!.expiredSessions).toBe(time < CUTOFF ? 0 : 1);
  });
  it("returns original cancellation result after expiry reconciliation and a lost response replay", async () => {
    const f = await fixture();
    const first = await transaction((session) =>
      f.repository.resolveWithResult(f.scope(), f.input.originBookingId, "CANCELLED", session),
    );
    f.setTime(AFTER);
    await f.expire();
    const before = await f.read();
    const replay = await transaction((session) =>
      f.repository.resolveWithResult(f.scope(), f.input.originBookingId, "CANCELLED", session),
    );
    expect(replay).toEqual({ ...first, isNew: false });
    expect((await f.read()).items).toEqual(before.items);
    expect(
      await transaction((session) =>
        f.repository.claim(f.scope(), f.input.originBookingId, session),
      ),
    ).toMatchObject({ isNew: false });
    await expect(
      transaction((session) =>
        f.repository.resolveWithResult(f.scope(), f.input.originBookingId, "FORFEITED", session),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it.each(["COMPLETED", "FORFEITED"] as const)(
    "allows valid S to become %s after expiry without touching X twice",
    async (outcome) => {
      const f = await fixture();
      f.setTime(AFTER);
      await f.expire();
      await transaction((session) =>
        f.repository.resolve(f.scope(), f.input.originBookingId, outcome, session),
      );
      const data = await f.read();
      expect(data.items[0]!.expiredSessions).toBe(2);
      expect(data.items[0]!.completedSessions).toBe(outcome === "COMPLETED" ? 1 : 0);
      expect(data.sessions[0]!.status).toBe(outcome);
      expect(
        await transaction((session) =>
          f.repository.resolve(f.scope(), f.input.originBookingId, outcome, session),
        ),
      ).toBe(false);
    },
  );
  it("keeps unresolved/pending S untouched while monetary UNKNOWN is neither read nor released", async () => {
    const f = await fixture();
    await mongoose.connection
      .db!.collection("p2_unknown_provider_fixture")
      .insertOne({ bookingId: f.input.originBookingId, status: "UNKNOWN", reservedCents: 25 });
    f.setTime(AFTER);
    await f.expire();
    expect((await f.read()).sessions[0]!.status).toBe("SCHEDULED");
    expect(
      await mongoose.connection
        .db!.collection("p2_unknown_provider_fixture")
        .findOne({ bookingId: f.input.originBookingId }),
    ).toMatchObject({ status: "UNKNOWN", reservedCents: 25 });
  });
  it("serializes two expiry transactions and a cancellation/expiry race", async () => {
    const f = await fixture();
    f.setTime(AFTER);
    const results = await Promise.all([f.expire(), f.expire()]);
    expect(results.filter((result) => result.isNew)).toHaveLength(1);
    await Promise.all([
      f.expire(),
      transaction((session) =>
        f.repository.resolveWithResult(f.scope(), f.input.originBookingId, "CANCELLED", session),
      ),
    ]);
    const data = await f.read();
    expect(data.items[0]!.expiredSessions).toBe(3);
    expect(data.items[0]!.remainingSessions).toBe(0);
  });
  it("preserves the invariant when first expiry and cancellation start concurrently", async () => {
    const f = await fixture();
    f.setTime(AFTER);
    await Promise.all([
      f.expire(),
      transaction((session) =>
        f.repository.resolve(f.scope(), f.input.originBookingId, "CANCELLED", session),
      ),
    ]);
    expect((await f.read()).items.map((item) => item.expiredSessions)).toEqual([3, 2, 1]);
  });
  it("serializes a claim versus expiry across retry with a fresh cutoff clock", async () => {
    const f = await fixture();
    const expiry = new PackageProgressV2Repository(() => AFTER);
    const result = await Promise.allSettled([
      transaction((session) => f.repository.claim(f.scope(2), new Types.ObjectId(), session)),
      transaction((session) =>
        expiry.reconcileExpiry(f.input._id, f.business._id, f.customerId, session),
      ),
    ]);
    expect(result[1]!.status).toBe("fulfilled");
    const data = await f.read();
    expect(data.items[2]!.remainingSessions).toBe(0);
    expect(
      data.items[2]!.expiredSessions +
        data.sessions.filter(
          (row) => row.packageItemId.equals(f.scope(2).packageItemId) && row.status === "SCHEDULED",
        ).length,
    ).toBe(1);
  });
  it("permits only one of two concurrent last-credit claims", async () => {
    const f = await fixture();
    const result = await Promise.allSettled(
      [1, 2].map(() =>
        transaction((session) => f.repository.claim(f.scope(2), new Types.ObjectId(), session)),
      ),
    );
    expect(result.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect((await f.read()).items[2]!.remainingSessions).toBe(0);
  });
  it("never time-expires FOREVER and restores R after the finite illustration date", async () => {
    const f = await fixture("FOREVER");
    f.setTime(AFTER);
    await expect(f.expire()).rejects.toMatchObject({ statusCode: 409 });
    expect(
      await transaction((session) =>
        f.repository.resolveWithResult(f.scope(), f.input.originBookingId, "CANCELLED", session),
      ),
    ).toMatchObject({ restorationDisposition: "AVAILABLE" });
    await transaction((session) => f.repository.claim(f.scope(2), new Types.ObjectId(), session));
    expect((await f.read()).items.map((item) => item.expiredSessions)).toEqual([0, 0, 0]);
  });
  it("does not reopen a reconciled boundary if the process clock moves backwards", async () => {
    const f = await fixture();
    f.setTime(AFTER);
    await f.expire();
    f.setTime(BEFORE);
    await expect(
      transaction((session) => f.repository.claim(f.scope(1), new Types.ObjectId(), session)),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      transaction((session) =>
        f.repository.resolve(f.scope(), f.input.originBookingId, "CANCELLED", session),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(derivePackageProgressV2Totals(await f.read(), BEFORE)).toMatchObject({
      availableSessions: 0,
    });
  });
  it("enforces normal origin settlement independently of any penalty receipt", async () => {
    const f = await fixture();
    f.origin.completionPayment!.amountCents = 99;
    await f.origin.save();
    await mongoose.connection
      .db!.collection("p2_penalty_receipt_fixture")
      .insertOne({ amountCents: 10000, status: "SUCCEEDED" });
    await expect(
      transaction((session) => f.repository.claim(f.scope(1), new Types.ObjectId(), session)),
    ).rejects.toMatchObject({ statusCode: 409 });
    f.origin.completionPayment!.amountCents = 100;
    await f.origin.save();
    await expect(
      transaction((session) => f.repository.claim(f.scope(1), new Types.ObjectId(), session)),
    ).resolves.toMatchObject({ isNew: true });
  });
  it("rejects foreign tuples and malformed opted-in contracts before any transition", async () => {
    const f = await fixture();
    for (const scope of [
      { ...f.scope(), customerUserId: new Types.ObjectId() },
      { ...f.scope(), businessId: new Types.ObjectId() },
      { ...f.scope(), serviceId: new Types.ObjectId() },
    ])
      await expect(
        transaction((session) => f.repository.claim(scope, new Types.ObjectId(), session)),
      ).rejects.toThrow();
    await PackageProgressV2Model.collection.updateOne(
      { _id: f.input._id },
      { $set: { "purchasedContract.penalty.lifetimeCapCents": 99 } },
    );
    await expect(f.expire()).rejects.toThrow();
  });
  it("blocks raw model writes, replacement, bulk/pipeline updates and save from changing opted-in terms or counters", async () => {
    const f = await fixture();
    const before = await f.read();
    for (const path of [
      "purchasedContract",
      "purchasedContract.validity.expiresAt",
      "purchasedContract.penalty.lifetimeCapCents",
      "items.0.penaltyBasisCents",
      "creditAccountingVersion",
      "items.$[item].expiredSessions",
    ])
      await expect(
        PackageProgressV2Model.updateOne({ _id: f.input._id }, { $set: { [path]: 1 } }),
      ).rejects.toThrow();
    expect(
      (
        await PackageProgressV2Model.updateOne(
          { _id: f.input._id },
          { $inc: { "items.$[item].remainingSessions": -1 } },
          { arrayFilters: [{ "item.packageItemId": f.scope().packageItemId }] },
        )
      ).matchedCount,
    ).toBe(0);
    await expect(
      PackageProgressV2Model.updateOne(
        { _id: f.input._id },
        [{ $set: { creditAccountingVersion: 1 } }],
        { updatePipeline: true },
      ),
    ).rejects.toThrow();
    await expect(
      PackageProgressV2Model.bulkWrite([
        {
          updateOne: {
            filter: { _id: f.input._id },
            update: { $set: { creditAccountingVersion: 1 } },
          },
        },
      ]),
    ).rejects.toThrow();
    await expect(
      PackageProgressV2Model.replaceOne({ _id: f.input._id }, f.input),
    ).rejects.toThrow();
    const document = await PackageProgressV2Model.findById(f.input._id);
    await expect(document!.save()).rejects.toThrow();
    expect((await f.read()).items).toEqual(before.items);
    expect((await f.read()).purchasedContract).toEqual(before.purchasedContract);
  });
  it("void and time expiry remain independent and preserve pending-start restrictions", async () => {
    const f = await fixture();
    await expect(
      transaction((session) =>
        f.repository.void(f.input._id, f.business._id, f.customerId, session),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await transaction((session) =>
      f.repository.resolve(f.scope(), f.input.originBookingId, "CANCELLED", session),
    );
    await transaction((session) =>
      f.repository.void(f.input._id, f.business._id, f.customerId, session),
    );
    f.setTime(AFTER);
    await f.expire();
    expect(await f.read()).toMatchObject({ voidedAt: BEFORE });
    expect((await f.read()).items.map((item) => item.expiredSessions)).toEqual([3, 2, 1]);
  });
});

// Vitest-only authority mock for existing model-valid synthetic first-class fixtures.
vi.mock("../../../src/modules/booking/package-batch-authority.js", () => ({
  verifyPackageBatchActivation: vi.fn(async () => undefined),
}));
