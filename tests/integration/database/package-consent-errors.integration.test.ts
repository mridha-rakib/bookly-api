import mongoose, { mongo } from "mongoose";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { BookingError } from "../../../src/modules/booking/booking.errors.js";
import { BookingCreationClaimModel } from "../../../src/modules/booking/booking-creation-claim.model.js";
import { PackageCheckoutConflictError } from "../../../src/modules/booking/package-checkout.errors.js";
import { setupConsentHttp } from "../../helpers/consent-http-fixture.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "../../helpers/consent-isolated-database.js";

beforeAll(connectIsolatedDatabase, 60000);
beforeEach(clearIsolatedDatabase);
afterEach(() => vi.restoreAllMocks());
afterAll(stopIsolatedReplicaSet);
const prepared = async () => {
  const s = await setupConsentHttp();
  expect((await s.quote()).status).toBe(200);
  const p = (await s.present()).body.data;
  return { ...s, event: s.actionFor(p) };
};

it.each([
  [new PackageCheckoutConflictError("unavailable outage domain diagnostic"), 409],
  [new mongo.MongoNetworkError("private network credentials must not leak"), 503],
  [new mongoose.Error.MongooseServerSelectionError("private server selection URI"), 503],
  [new Error("unavailable outage unexpected programming failure"), 500],
  [Object.assign(new Error("spoofed driver name"), { name: "MongoNetworkError" }), 500],
] as const)(
  "maps a typed %s to %i without message/name heuristics or acceptance",
  async (error, status) => {
    const s = await prepared();
    vi.spyOn(s.f.preparer, "prepare").mockRejectedValueOnce(error);
    const response = await s.accept(s.event);
    expect(response.status).toBe(status);
    expect(JSON.stringify(response.body)).not.toContain(error.message);
    expect(response.body.stack).toBeUndefined();
    expect(
      (await BookingCreationClaimModel.findOne().orFail()).packageCheckoutAcceptance,
    ).toBeUndefined();
  },
);

it("preserves existing Booking AppError status and code", async () => {
  const s = await prepared();
  vi.spyOn(s.f.preparer, "prepare").mockRejectedValueOnce(
    new BookingError("BOOKING_IDEMPOTENCY_CONFLICT", 409),
  );
  const response = await s.accept(s.event);
  expect(response.status).toBe(409);
  expect(response.body.errors[0].code).toBe("BOOKING_IDEMPOTENCY_CONFLICT");
});

it("an actually closed owned Mongo client fails 503 during fresh persistent reads", async () => {
  const s = await prepared();
  const db = mongoose.connection.db,
    client = mongoose.connection.getClient();
  const host = client.options.hosts[0]?.toString(),
    database = mongoose.connection.name;
  if (!db || !host?.startsWith("127.0.0.1:") || !database.startsWith("bookly_consent_v1_"))
    throw new Error("Owned target required");
  vi.spyOn(s.f.dependencies.packages, "findById").mockImplementationOnce(async () => {
    await client.close();
    await db.collection("packages").findOne({});
    throw new Error("Expected closed-driver failure");
  });
  const response = await s.accept(s.event);
  expect(response.status).toBe(503);
  expect(response.body.errors[0].code).toBe("PACKAGE_CONSENT_UNAVAILABLE");
  const verification = new mongo.MongoClient(`mongodb://${host}`, {
    serverSelectionTimeoutMS: 1000,
  });
  try {
    await verification.connect();
    expect(
      await verification
        .db(database)
        .collection("bookingcreationclaims")
        .countDocuments({ packageCheckoutAcceptance: { $exists: true } }),
    ).toBe(0);
  } finally {
    await verification.close();
  }
});
