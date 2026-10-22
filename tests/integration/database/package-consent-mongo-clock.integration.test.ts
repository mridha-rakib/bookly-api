import { setTimeout as delay } from "node:timers/promises";
import mongoose from "mongoose";
import { afterAll, beforeAll, expect, it } from "vitest";
// Register the canonical claim model required by the owned helper's unique-index proof.
import "../../../src/modules/booking/booking-creation-claim.model.js";
import {
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "../../helpers/consent-isolated-database.js";

beforeAll(connectIsolatedDatabase, 60000);
afterAll(stopIsolatedReplicaSet);
const databaseTime = async () => {
  const hello = await mongoose.connection.db?.admin().command({ hello: 1 });
  const now = hello?.["localTime"];
  if (!(now instanceof Date)) throw new Error("Actual Mongo wall time required");
  return now;
};

it("Mongo 8.2 supports $$NOW in updateOne predicates, with real database-time expiry", async () => {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Owned database required");
  const build = await db.admin().command({ buildInfo: 1 });
  expect(build["version"]).toBe("8.2.6");
  const collection = db.collection<{ _id: number; expiresAt: Date; observedNow?: Date }>(
    "consent_clock_probe",
  );
  const now = await databaseTime();
  await collection.insertMany([
    { _id: 1, expiresAt: new Date(now.getTime() + 60000) },
    { _id: 2, expiresAt: new Date(now.getTime() - 1) },
  ]);
  const update = (_id: number) =>
    collection.updateOne({ _id, $expr: { $lt: ["$$NOW", "$expiresAt"] } }, [
      { $set: { observedNow: "$$NOW" } },
    ]);
  expect((await update(1)).matchedCount).toBe(1);
  expect((await update(2)).matchedCount).toBe(0);
  expect((await collection.findOne({ _id: 1 }))?.observedNow).toBeInstanceOf(Date);
  process.stdout.write(
    `${JSON.stringify({ mongoVersion: build["version"], mongooseVersion: mongoose.version, realDbClockPredicate: "SUPPORTED" })}\n`,
  );
});

it("characterizes $$NOW across a real transaction write conflict spanning expiry", async () => {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Owned database required");
  const collection = db.collection<{
    _id: number;
    expiresAt: Date;
    observedNow?: Date;
    held?: boolean;
    accepted?: boolean;
  }>("consent_clock_contention");
  const initial = await databaseTime();
  const expiresAt = new Date(initial.getTime() + 2000);
  await collection.insertOne({ _id: 1, expiresAt });
  const session = await mongoose.startSession();
  let pending: ReturnType<typeof collection.updateOne> | undefined;
  try {
    session.startTransaction();
    await collection.updateOne({ _id: 1 }, { $set: { held: true } }, { session });
    let settled = false;
    pending = collection.updateOne(
      { _id: 1, $expr: { $lt: ["$$NOW", "$expiresAt"] } },
      [{ $set: { accepted: true, observedNow: "$$NOW" } }],
      { maxTimeMS: 10000 },
    );
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const limit = Date.now() + 6000;
    while ((await databaseTime()) < expiresAt) {
      if (Date.now() > limit) throw new Error("Bounded actual database clock wait exceeded");
      await delay(20);
    }
    expect(settled).toBe(false);
    const releaseAt = await databaseTime();
    await session.commitTransaction();
    const result = await pending;
    const stored = await collection.findOne({ _id: 1 });
    process.stdout.write(
      `${JSON.stringify({ mongoNowContention: { initial, expiresAt, releaseAt, observedNow: stored?.observedNow, matchedCount: result.matchedCount, accepted: stored?.accepted } })}\n`,
    );
    // Characterization of the candidate, NOT production acceptance or a claimed fence.
    expect(result.matchedCount).toBe(1);
    expect(stored?.observedNow?.getTime()).toBeLessThan(expiresAt.getTime());
    expect(releaseAt.getTime()).toBeGreaterThanOrEqual(expiresAt.getTime());
  } finally {
    if (session.inTransaction()) await session.abortTransaction();
    if (pending) await pending.catch(() => undefined);
    await session.endSession();
  }
}, 15000);
