import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { BookingCreationClaimModel } from "../../../src/modules/booking/booking-creation-claim.model.js";
import { setupConsentHttp } from "../../helpers/consent-http-fixture.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "../../helpers/consent-isolated-database.js";

// Rejected-candidate experiments only. No production consent issuer, grant or clock is installed.
// Real Mongo operations are distinguished from the explicitly controlled application clock.
beforeAll(connectIsolatedDatabase, 60000);
beforeEach(clearIsolatedDatabase);
afterEach(() => vi.restoreAllMocks());
afterAll(stopIsolatedReplicaSet);
const evidence = process.env["BOOKLY_B1C_EVIDENCE_PATH"];
const record = async (value: object) => {
  if (evidence) await appendFile(evidence, `${JSON.stringify(value)}\n`);
};
const db = () => {
  const result = mongoose.connection.db;
  if (!result) throw Error("Owned disposable database required");
  return result;
};
const serverNow = async () => {
  const result = await db().admin().command({ hello: 1 });
  const now = result["localTime"];
  if (!(now instanceof Date)) throw Error("Actual database wall-clock sample required");
  return now;
};
const waitPast = async (deadline: Date) => {
  const limit = process.hrtime.bigint() + 8_000_000_000n;
  let now = await serverNow();
  while (now.getTime() <= deadline.getTime()) {
    if (process.hrtime.bigint() > limit) throw Error("Bounded database-clock wait exceeded");
    await delay(20);
    now = await serverNow();
  }
  return now;
};
type Probe = {
  _id: string;
  issuedAt: Date;
  expiresAt: Date;
  epoch: number;
  evaluatedAt?: Date;
  disclosure?: string;
};
const probe = async (name: string) => {
  const collection = db().collection<Probe>(name);
  const now = await serverNow();
  const expiresAt = new Date(now.getTime() + 1500);
  const issuedAt = new Date(expiresAt.getTime() - 1_800_000);
  await collection.insertOne({ _id: "PROBE_ONLY", issuedAt, expiresAt, epoch: 0 });
  return { collection, issuedAt, expiresAt };
};

it.each([-60000, -1000, -1, 0, 1, 1000, 60000])(
  "B1c application-clock boundary D%+i: real authenticated CAS, not commit-time proof",
  async (offset) => {
    const s = await setupConsentHttp();
    expect((await s.quote()).status).toBe(200);
    const presentation = (await s.present()).body.data;
    const before = await BookingCreationClaimModel.findOne().orFail();
    const retained = before.packageCheckoutRetention;
    if (!retained) throw Error("Original retained quote required");
    expect(retained.seed.expiresAt.getTime() - retained.seed.issuedAt.getTime()).toBe(1_800_000);
    const sample = new Date(retained.seed.expiresAt.getTime() + offset);
    s.advance(sample);
    const response = await s.accept(s.actionFor(presentation));
    expect(response.status).toBe(offset < 0 ? 200 : 409);
    const after = await BookingCreationClaimModel.findById(before._id).orFail();
    expect(after.packageCheckoutRetention).toEqual(retained);
    expect(Boolean(after.packageCheckoutAcceptance)).toBe(offset < 0);
    if (offset < 0) expect(after.packageCheckoutAcceptance?.evidence.acceptedAt).toEqual(sample);
    for (const name of ["bookings", "packageprogresses", "paymentattempts"])
      expect(await db().collection(name).countDocuments()).toBe(0);
    await record({
      kind: "CONTROLLED_APP_CLOCK_REAL_CAS",
      offset,
      status: response.status,
      originalIssuedAt: retained.seed.issuedAt,
      originalDeadline: retained.seed.expiresAt,
      sample,
      authoritativeCommitTimeProven: false,
    });
  },
);

it.each(["NOW", "CURRENT_DATE"] as const)(
  "%s is not a transaction-commit deadline: invisible early write commits after D",
  async (clock) => {
    const { collection, issuedAt, expiresAt } = await probe(`b1c_late_commit_${clock}`);
    const session = await mongoose.startSession();
    try {
      session.startTransaction({
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority", j: true },
      });
      const update =
        clock === "NOW"
          ? [{ $set: { evaluatedAt: "$$NOW" } }]
          : { $currentDate: { evaluatedAt: true as const } };
      expect(
        (
          await collection.updateOne(
            { _id: "PROBE_ONLY", $expr: { $lt: ["$$NOW", "$expiresAt"] } },
            update,
            { session },
          )
        ).matchedCount,
      ).toBe(1);
      const staged = await collection.findOne({ _id: "PROBE_ONLY" }, { session });
      expect(staged?.evaluatedAt?.getTime()).toBeLessThan(expiresAt.getTime());
      expect((await collection.findOne({ _id: "PROBE_ONLY" }))?.evaluatedAt).toBeUndefined();
      const beforeCommit = await waitPast(expiresAt);
      await session.commitTransaction();
      const stored = await collection.findOne(
        { _id: "PROBE_ONLY" },
        { readConcern: { level: "majority" } },
      );
      expect(stored?.evaluatedAt).toEqual(staged?.evaluatedAt);
      expect(stored?.issuedAt).toEqual(issuedAt);
      expect(beforeCommit.getTime()).toBeGreaterThan(expiresAt.getTime());
      await record({
        kind: "REAL_TRANSACTION_LATE_COMMIT_COUNTEREXAMPLE",
        clock,
        issuedAt,
        expiresAt,
        evaluatedAt: stored?.evaluatedAt,
        beforeCommit,
        afterCommit: await serverNow(),
        writeConcern: "majority+journal, single member only",
        operationTime: session.operationTime,
      });
    } finally {
      if (session.inTransaction()) await session.abortTransaction();
      await session.endSession();
    }
  },
  15000,
);

it("definite abort removes the staged candidate timestamp and preserves original quote fields", async () => {
  const { collection, issuedAt, expiresAt } = await probe("b1c_known_abort");
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    await collection.updateOne({ _id: "PROBE_ONLY" }, [{ $set: { evaluatedAt: "$$NOW" } }], {
      session,
    });
    expect(
      (await collection.findOne({ _id: "PROBE_ONLY" }, { session }))?.evaluatedAt,
    ).toBeInstanceOf(Date);
    await session.abortTransaction();
    const stored = await collection.findOne({ _id: "PROBE_ONLY" });
    expect(stored).toEqual({ _id: "PROBE_ONLY", issuedAt, expiresAt, epoch: 0 });
    await record({
      kind: "REAL_TRANSACTION_ABORT",
      originalQuoteFieldsPreserved: true,
      noCandidateAuthority: true,
    });
  } finally {
    await session.endSession();
  }
});

it("real write conflict retries the callback after D with the same original quote", async () => {
  const { collection, issuedAt, expiresAt } = await probe("b1c_real_conflict");
  const session = await mongoose.startSession();
  let callbacks = 0;
  const conflicts: { code: unknown; labels: string[] }[] = [];
  try {
    await session.withTransaction(async () => {
      callbacks++;
      const original = await collection.findOne({ _id: "PROBE_ONLY" }, { session });
      expect(original?.issuedAt).toEqual(issuedAt);
      expect(original?.expiresAt).toEqual(expiresAt);
      if (callbacks === 1) {
        await collection.updateOne({ _id: "PROBE_ONLY" }, { $inc: { epoch: 1 } });
        await waitPast(expiresAt);
      }
      try {
        if (callbacks === 1)
          await collection.updateOne({ _id: "PROBE_ONLY" }, { $inc: { epoch: 1 } }, { session });
        const result = await collection.updateOne(
          { _id: "PROBE_ONLY", $expr: { $lt: ["$$NOW", "$expiresAt"] } },
          [{ $set: { evaluatedAt: "$$NOW" } }],
          { session },
        );
        expect(result.matchedCount).toBe(0);
      } catch (error) {
        if (error instanceof mongoose.mongo.MongoServerError) {
          conflicts.push({ code: error.code, labels: error.errorLabels });
        }
        throw error;
      }
    });
    expect(callbacks).toBe(2);
    expect(conflicts).toEqual([{ code: 112, labels: ["TransientTransactionError"] }]);
    const stored = await collection.findOne({ _id: "PROBE_ONLY" });
    expect(stored?.evaluatedAt).toBeUndefined();
    expect(stored?.issuedAt).toEqual(issuedAt);
    await record({
      kind: "REAL_SERVER_WRITE_CONFLICT",
      callbacks,
      conflicts,
      issuedAt,
      expiresAt,
      finalSample: await serverNow(),
      newEvaluationDenied: true,
      staleCommandNowStillNotACommitFence: true,
    });
  } finally {
    await session.endSession();
  }
}, 15000);

it("actual duplicate-key transactions elect one probe row without manufacturing consent", async () => {
  const collection = db().collection<Probe>("b1c_duplicate_key");
  await collection.createIndex({ _id: 1 });
  const issuedAt = await serverNow();
  const expiresAt = new Date(issuedAt.getTime() + 1_800_000);
  const attempt = async (disclosure: string) => {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await collection.insertOne(
          { _id: "PROBE_ONLY", issuedAt, expiresAt, epoch: 0, disclosure },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
  };
  const results = await Promise.allSettled([attempt("A"), attempt("B")]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const loser = results.find((r) => r.status === "rejected");
  expect(loser?.status === "rejected" && loser.reason.code).toBe(11000);
  expect(await collection.countDocuments()).toBe(1);
  expect(await BookingCreationClaimModel.countDocuments()).toBe(0);
  await record({
    kind: "REAL_DUPLICATE_KEY_TRANSACTION",
    loserCode: 11000,
    canonicalProbeRows: 1,
    realConsentRows: 0,
    temporalAuthorityProven: false,
  });
});
