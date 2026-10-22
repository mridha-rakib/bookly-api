import { randomUUID } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import mongoose from "mongoose";

let replica: MongoMemoryReplSet | undefined;
let owned: { uri: string; database: string; nonce: string } | undefined;
const assertOwned = () => {
  if (
    !owned ||
    mongoose.connection.host !== "127.0.0.1" ||
    mongoose.connection.name !== owned.database ||
    mongoose.connection.getClient().options.hosts[0]?.toString() !== new URL(owned.uri).host
  )
    throw new Error("Consent tests require their own verified loopback database");
  return owned;
};

/** A freshly launched replica set, never an application/env-supplied database URI.
 * Automatic schema writes are disabled until target identity has been checked.
 * Only initial collection/index creation is used; never syncIndexes/dropIndexes.
 */
export const connectIsolatedDatabase = async () => {
  if (replica || owned || mongoose.connection.readyState !== 0)
    throw new Error("A disconnected test-owned process is required");
  replica = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  const uri = replica.getUri();
  if (new URL(uri).hostname !== "127.0.0.1") throw new Error("Nonlocal replica rejected");
  const database = `bookly_consent_v1_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  await mongoose.connect(uri, {
    dbName: database,
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: 10000,
  });
  const hello = await mongoose.connection.db?.admin().command({ hello: 1 });
  if (!hello?.["setName"] || mongoose.connection.name !== database)
    throw new Error("Disposable replica identity failed");
  owned = { uri, database, nonce: randomUUID() };
  assertOwned();
  // The brand-new random database must be empty before any test-owned writes.
  if ((await mongoose.connection.db?.listCollections().toArray())?.length)
    throw new Error("Disposable database already contains data");
  await mongoose.connection.db?.collection("consent_test_owner").insertOne({ nonce: owned.nonce });
  const fixtureModels = new Set([
    "BookingCreationClaim",
    "User",
    "UserProfile",
    "Session",
    "Business",
    "Package",
    "Service",
    "ServiceCategory",
    "BusinessCancellationPolicy",
    "StaffMembership",
    "StaffSchedule",
    "BusinessOpeningHours",
  ]);
  for (const name of mongoose.modelNames().filter((name) => fixtureModels.has(name))) {
    assertOwned();
    await mongoose.model(name).createCollection();
    await mongoose.model(name).createIndexes();
  }
  const claimIndexes = await mongoose.model("BookingCreationClaim").collection.indexes();
  if (!claimIndexes.some((index) => index.unique && index.key["idempotencyKey"] === 1))
    throw new Error("Disposable canonical claim uniqueness is not initialized");
  process.stdout.write(
    `${JSON.stringify({ database, host: mongoose.connection.host, replicaSet: hello["setName"], indexMode: "create-only", syncIndexes: false })}\n`,
  );
  return database;
};

export const clearIsolatedDatabase = async () => {
  const identity = assertOwned();
  const db = mongoose.connection.db;
  if (!(await db?.collection("consent_test_owner").findOne({ nonce: identity.nonce })))
    throw new Error("Disposable ownership marker missing");
  for (const collection of (await db?.collections()) ?? []) {
    if (collection.collectionName !== "consent_test_owner") await collection.deleteMany({});
  }
};

export const stopIsolatedReplicaSet = async () => {
  try {
    if (owned && mongoose.connection.readyState === 1) {
      assertOwned();
      await mongoose.disconnect();
    }
  } finally {
    await replica?.stop();
    replica = undefined;
    owned = undefined;
  }
};
