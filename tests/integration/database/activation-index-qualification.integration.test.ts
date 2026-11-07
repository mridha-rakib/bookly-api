import { writeFileSync } from "node:fs";
import mongoose, { type mongo, Types } from "mongoose";
import { afterAll, beforeAll, expect, it } from "vitest";
import { compareRequiredIndexes } from "../../../src/database/index-qualification.js";
import "../../../src/modules/appointment-reminder/appointment-reminder.model.js";
import "../../../src/modules/booking/booking.model.js";
import "../../../src/modules/booking/booking-creation-claim.model.js";
import "../../../src/modules/booking/ordinary-calendar-journal.model.js";
import "../../../src/modules/booking/package-consent-evidence.js";
import "../../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
import "../../../src/modules/booking-slot-reservation/booking-slot-reservation.model.js";
import "../../../src/modules/booking-slot-reservation/booking-slot-reservation-claim.model.js";
import "../../../src/modules/email-outbox/email-outbox.model.js";
import "../../../src/modules/sms-outbox/sms-outbox.model.js";
import "../../../src/modules/package-progress/package-progress-v2.model.js";
import "../../../src/modules/payment/payment-attempt.model.js";
import "../../../src/modules/payment/refund-operation.model.js";
import "../../../src/modules/staff/staff.model.js";
import "../../../src/modules/stripe-webhook/stripe-webhook-event.model.js";
import { connectIsolatedDatabase, stopIsolatedReplicaSet } from "./mongo-replset-helper.js";

const evidence: Record<string, unknown> = {
  evidenceClass: "ENGINEERING VERIFIED",
  target: "disposable loopback replica only",
};
beforeAll(async () => {
  const database = await connectIsolatedDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(database).toMatch(/^bookly_auth_/);
  const db = mongoose.connection.db;
  if (!db) throw Error("Owned test database unavailable");
  const hello = await db.admin().command({ hello: 1 });
  const build = await db.admin().command({ buildInfo: 1 });
  evidence["environment"] = {
    database,
    host: mongoose.connection.host,
    setName: hello["setName"],
    writablePrimary: hello["isWritablePrimary"],
    mongoVersion: build["version"],
    node: process.version,
    mongoose: mongoose.version,
  };
  expect(hello["setName"]).toBeTruthy();
}, 60_000);
afterAll(async () => {
  writeFileSync("../audit-bc-f05a-01/index-qualification.json", JSON.stringify(evidence, null, 2));
  await stopIsolatedReplicaSet();
});

it("compares every registered model declaration with actual additive disposable indexes", async () => {
  const inventory = [];
  for (const name of mongoose.modelNames().sort()) {
    const model = mongoose.model(name);
    const actual = await model.collection.indexes();
    const required = model.schema
      .indexes()
      .map(([key, options]) => ({ key: { ...key }, options: { ...options } }));
    const comparisons = compareRequiredIndexes(
      required,
      actual.map(({ key, ...options }) => ({ key, options })),
    );
    inventory.push({
      model: name,
      collection: model.collection.name,
      required,
      actual,
      comparisons,
    });
  }
  evidence["inventory"] = inventory;
  expect(inventory.length).toBeGreaterThanOrEqual(15);
  for (const entry of inventory)
    expect(
      entry.comparisons.every((v) => v.state === "MATCHED"),
      entry.model,
    ).toBe(true);
});

it("detects an unprovisioned contract without dropping any index", async () => {
  const db = mongoose.connection.db;
  if (!db) throw Error("Owned database unavailable");
  const empty = await db.createCollection("qualification_missing_index");
  const actual = await empty.indexes();
  expect(
    compareRequiredIndexes(
      [{ key: { operationKey: 1, phase: 1 }, options: { unique: true } }],
      actual.map(({ key, ...options }) => ({ key, options })),
    )[0]?.state,
  ).toBe("MISSING_OR_DIFFERENT");
  await expect(
    empty.find({ operationKey: "absent" }).hint({ operationKey: 1, phase: 1 }).toArray(),
  ).rejects.toMatchObject({ code: 2 });
});

it("captures populated unhinted plans for recovery inbox, refund sweep, calendar due and staff appointments", async () => {
  const owner = new Types.ObjectId(),
    other = new Types.ObjectId(),
    business = new Types.ObjectId(),
    staff = new Types.ObjectId();
  const now = new Date("2026-11-02T08:00:00Z");
  const rows = Array.from({ length: 240 }, (_, i) => ({
    i,
    user: i % 8 === 0 ? owner : other,
    date: new Date(now.getTime() - i * 1000),
  }));
  const attempts = mongoose.model("PaymentAttempt").collection;
  const refunds = mongoose.model("RefundOperation").collection;
  const journals = mongoose.model("OrdinaryCalendarJournal").collection;
  const bookings = mongoose.model("Booking").collection;
  const claims = mongoose.model("BookingCreationClaim").collection;
  // Deliberate minimal raw records test database indexes/plans, not domain validation.
  await attempts.insertMany(
    rows.map(({ i, user, date }) => ({
      logicalIdempotencyKey: `index-attempt-${i}`,
      customerUserId: user,
      businessId: business,
      productKind: "NORMAL_BOOKING",
      purpose: "BOOKING_DEPOSIT",
      createdAt: date,
    })),
  );
  await claims.insertMany(
    rows.map(({ i, user, date }) => ({
      idempotencyKey: `index-claim-${i}`,
      actorUserId: user,
      financialContract: { productKind: "NORMAL_BOOKING" },
      createdAt: date,
    })),
  );
  await refunds.insertMany(
    rows.map(({ i, date }) => ({
      logicalIdempotencyKey: `index-refund-${i}`,
      finalNotificationProtocolVersion: 1,
      reason: "BUSINESS_CANCELLATION",
      providerStatus: i % 8 === 0 ? "SUCCEEDED" : "PENDING",
      providerRefundId: `re_index_${i}`,
      updatedAt: date,
    })),
  );
  await journals.insertMany(
    rows.map(({ i, date }) => ({
      bookingId: new Types.ObjectId(),
      mode: "AUTHORITATIVE",
      state: i % 8 === 0 ? "PENDING" : "CONFIRMED",
      nextAttemptAt: date,
    })),
  );
  await bookings.insertMany(
    rows.map(({ i, date }) => ({
      reference: `INDEX-${i}`,
      businessId: business,
      serviceLines: [{ responsibleStaffMembershipId: i % 8 === 0 ? staff : other }],
      schedule: { startAt: date },
    })),
  );
  const plans = [];
  for (const [name, collection, filter, sort] of [
    [
      "payment-inbox",
      attempts,
      {
        customerUserId: owner,
        productKind: "NORMAL_BOOKING",
        purpose: "BOOKING_DEPOSIT",
        createdAt: { $type: "date" },
        businessId: { $type: "objectId" },
        packageBatchBinding: { $exists: false },
        packageLifecycleBinding: { $exists: false },
      },
      { createdAt: -1, _id: -1 },
    ],
    [
      "claim-inbox",
      claims,
      {
        actorUserId: owner,
        "financialContract.productKind": "NORMAL_BOOKING",
        createdAt: { $type: "date" },
        packageRequestBinding: { $exists: false },
        packageCheckoutRetention: { $exists: false },
        packageCheckoutPresentation: { $exists: false },
        packageCheckoutAcceptance: { $exists: false },
      },
      { createdAt: -1, _id: -1 },
    ],
    [
      "refund-final-notification",
      refunds,
      {
        finalNotificationProtocolVersion: 1,
        finalNotificationRecordedAt: { $exists: false },
        reason: "BUSINESS_CANCELLATION",
        packageProgressId: { $exists: false },
        providerRefundId: { $exists: true },
        providerStatus: { $in: ["SUCCEEDED", "FAILED"] },
        $or: [{ nextRecoveryAt: { $lte: now } }, { nextRecoveryAt: { $exists: false } }],
      },
      { updatedAt: 1, _id: 1 },
    ],
    [
      "calendar-due",
      journals,
      {
        mode: "AUTHORITATIVE",
        state: {
          $in: [
            "PENDING",
            "RETRYABLE_FAILURE",
            "DISPATCH_PREPARED",
            "REQUEST_ISSUED",
            "UNKNOWN_OUTCOME",
          ],
        },
        nextAttemptAt: { $lte: now },
      },
      { nextAttemptAt: 1 },
    ],
    [
      "staff-appointments",
      bookings,
      {
        businessId: business,
        "serviceLines.responsibleStaffMembershipId": staff,
        "schedule.startAt": { $gte: new Date(now.getTime() - 240_000), $lte: now },
      },
      { "schedule.startAt": 1, _id: 1 },
    ],
  ] satisfies Array<[string, typeof attempts, mongo.Filter<mongo.Document>, mongo.Sort]>) {
    const explain = await collection.find(filter).sort(sort).limit(21).explain("executionStats");
    plans.push({ name, rowsSeeded: rows.length, filter, sort, limit: 21, explain });
    expect(explain["executionStats"]["nReturned"]).toBeGreaterThan(0);
    if (name === "payment-inbox" || name === "claim-inbox") {
      const hint =
        name === "payment-inbox"
          ? { customerUserId: 1, productKind: 1, purpose: 1, createdAt: -1, _id: -1 }
          : { actorUserId: 1, "financialContract.productKind": 1, createdAt: -1, _id: -1 };
      const cursorDate = new Date(now.getTime() - 8_000);
      const pageFilter = {
        ...filter,
        $or: [
          { createdAt: { $lt: cursorDate } },
          { createdAt: cursorDate, _id: { $lt: new Types.ObjectId() } },
        ],
      };
      const hinted = await collection
        .find(pageFilter)
        .sort(sort)
        .limit(21)
        .hint(hint)
        .maxTimeMS(2000)
        .explain("executionStats");
      plans.push({
        name: `${name}-hinted-keyset`,
        rowsSeeded: rows.length,
        filter: pageFilter,
        sort,
        hint,
        limit: 21,
        explain: hinted,
      });
      expect(hinted["executionStats"]["nReturned"]).toBeGreaterThan(0);
    }
  }
  evidence["queryPlans"] = plans;
});

it("enforces unique operation winners and majority/journaled transaction rollback", async () => {
  const claims = mongoose.model("BookingCreationClaim").collection;
  const winner = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      claims.insertOne({ idempotencyKey: "index-concurrent-operation" }),
    ),
  );
  expect(winner.filter((v) => v.status === "fulfilled")).toHaveLength(1);
  for (const result of winner)
    if (result.status === "rejected") expect(result.reason.code).toBe(11000);
  const consent = mongoose.model("PackageConsentEvidence").collection;
  await consent.insertOne({ operationKey: "index-consent", phase: "ISSUANCE" });
  await expect(
    consent.insertOne({ operationKey: "index-consent", phase: "ISSUANCE" }),
  ).rejects.toMatchObject({ code: 11000 });
  const session = await mongoose.startSession();
  try {
    await expect(
      session.withTransaction(
        async () => {
          await claims.insertOne({ idempotencyKey: "index-rollback" }, { session });
          throw Error("intentional qualification rollback");
        },
        { readConcern: { level: "snapshot" }, writeConcern: { w: "majority", j: true } },
      ),
    ).rejects.toThrow("intentional qualification rollback");
    expect(await claims.findOne({ idempotencyKey: "index-rollback" })).toBeNull();
    await session.withTransaction(
      async () => {
        await claims.insertOne({ idempotencyKey: "index-majority-commit" }, { session });
      },
      { readConcern: { level: "snapshot" }, writeConcern: { w: "majority", j: true } },
    );
    expect(
      await claims.findOne(
        { idempotencyKey: "index-majority-commit" },
        { readConcern: { level: "majority" }, readPreference: "primary" },
      ),
    ).toBeTruthy();
    evidence["durability"] = {
      contenders: 6,
      winners: 1,
      duplicatePhaseRejected: true,
      snapshotRollback: true,
      majorityJournaledCommitAndPrimaryMajorityRead: true,
      multiNodeFailoverQualified: false,
    };
  } finally {
    await session.endSession();
  }
});
