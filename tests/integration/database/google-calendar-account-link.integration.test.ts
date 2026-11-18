import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { GoogleCalendarIntegrationModel } from "../../../src/modules/integration/integration.model.js";
import { IntegrationRepository } from "../../../src/modules/integration/integration.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/** The cross-Business guard query, against a real (isolated) MongoDB. */
const repository = new IntegrationRepository();
const connect = (businessId: Types.ObjectId, googleAccountId: string, email: string) =>
  repository.upsert({
    businessId,
    googleAccountEmail: email,
    googleAccountId,
    calendarId: "primary",
    encryptedAccessToken: "enc-access",
    encryptedRefreshToken: "enc-refresh",
    tokenExpiresAt: new Date(Date.now() + 3_600_000),
  });

beforeAll(async () => {
  await connectIsolatedDatabase();
}, 120_000);
beforeEach(async () => {
  await clearIsolatedDatabase();
  await GoogleCalendarIntegrationModel.syncIndexes();
});
afterAll(async () => {
  await stopIsolatedReplicaSet();
});

it("finds an account only when ANOTHER Business uses it; a Business keeps exactly one connection", async () => {
  const a = new Types.ObjectId();
  const b = new Types.ObjectId();
  await connect(a, "sub-1", "one@gmail.com");

  // Its own Business reconnecting the same account is not "in use elsewhere".
  expect(await repository.findByGoogleAccountForOtherBusiness("sub-1", a)).toBeNull();
  expect(await repository.findByGoogleAccountForOtherBusiness("sub-1", String(a))).toBeNull();
  // A different Business would be refused.
  expect(
    String((await repository.findByGoogleAccountForOtherBusiness("sub-1", b))?.businessId),
  ).toBe(String(a));
  expect(await repository.findByGoogleAccountForOtherBusiness("sub-2", b)).toBeNull();

  // Switching Business A to a different account replaces its single row (new generation).
  const before = await repository.findByBusinessId(a);
  await connect(a, "sub-2", "two@workspace.example");
  const rows = await GoogleCalendarIntegrationModel.find({ businessId: a }).lean().exec();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    googleAccountId: "sub-2",
    googleAccountEmail: "two@workspace.example",
    status: "CONNECTED",
  });
  expect(rows[0]!.connectionGeneration).not.toBe(before!.connectionGeneration);
  // The old account is now free for another Business.
  expect(await repository.findByGoogleAccountForOtherBusiness("sub-1", b)).toBeNull();
});
