import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SmsOutboxModel } from "../../../src/modules/sms-outbox/sms-outbox.model.js";
import {
  SmsOutboxEnqueueError,
  SmsOutboxRepository,
} from "../../../src/modules/sms-outbox/sms-outbox.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

type DbIndex = { name?: string; key: Record<string, unknown>; unique?: boolean };

const enqueueInput = (overrides: Record<string, unknown> = {}) => ({
  eventKey: "APPOINTMENT_REMINDER_24H:650000000000000000000001:123",
  recipientE164: " +35799123456 ",
  body: "Bookly reminder: your appointment is tomorrow.",
  ...overrides,
});

const claimOptions = (overrides: Record<string, unknown> = {}) => ({
  workerId: "sms-worker-1",
  now: new Date(),
  claimTimeoutMs: 120_000,
  maxAttempts: 5,
  ...overrides,
});

describe("database-backed SmsOutbox integration", () => {
  let repository: SmsOutboxRepository;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    repository = new SmsOutboxRepository();
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  it("has a unique dedupeKey index plus the claim and stale-recovery indexes", async () => {
    const indexes = (await SmsOutboxModel.collection.indexes()) as DbIndex[];
    expect(indexes.find((i) => i.key["dedupeKey"] === 1)?.unique).toBe(true);
    expect(
      indexes.some(
        (i) => i.key["status"] === 1 && i.key["nextAttemptAt"] === 1 && i.key["createdAt"] === 1,
      ),
    ).toBe(true);
    expect(indexes.some((i) => i.key["status"] === 1 && i.key["claimedAt"] === 1)).toBe(true);
  });

  it("enqueue creates one PENDING row and normalises the recipient", async () => {
    const { created, record } = await repository.enqueue(enqueueInput());
    expect(created).toBe(true);
    expect(record.status).toBe("PENDING");
    expect(record.recipientE164).toBe("+35799123456");
    expect(record.attemptCount).toBe(0);
    expect(await SmsOutboxModel.countDocuments({})).toBe(1);
  });

  it("is idempotent — a duplicate (eventKey, recipient) returns the same row, never a second", async () => {
    const first = await repository.enqueue(enqueueInput());
    const second = await repository.enqueue(
      enqueueInput({ body: "different text, same logical SMS" }),
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.record._id.toString()).toBe(first.record._id.toString());
    expect(await SmsOutboxModel.countDocuments({})).toBe(1);
  });

  it("rejects an obviously invalid recipient or an empty body at the boundary", async () => {
    await expect(
      repository.enqueue(enqueueInput({ recipientE164: "not-a-number" })),
    ).rejects.toBeInstanceOf(SmsOutboxEnqueueError);
    await expect(repository.enqueue(enqueueInput({ body: "   " }))).rejects.toBeInstanceOf(
      SmsOutboxEnqueueError,
    );
    expect(await SmsOutboxModel.countDocuments({})).toBe(0);
  });

  it("claimNext atomically moves one row PENDING -> PROCESSING and won't re-hand it out", async () => {
    await repository.enqueue(enqueueInput());
    const claimed = await repository.claimNext(claimOptions());
    expect(claimed?.status).toBe("PROCESSING");
    expect(claimed?.attemptCount).toBe(1);
    expect(claimed?.claimedBy).toBe("sms-worker-1");
    expect(await repository.claimNext(claimOptions({ workerId: "sms-worker-2" }))).toBeNull();
  });

  it("two concurrent workers never claim the same row", async () => {
    for (let i = 0; i < 6; i += 1) {
      await repository.enqueue(
        enqueueInput({ eventKey: `EVT:${i}`, recipientE164: `+3579912345${i}` }),
      );
    }
    const now = new Date();
    const claims = await Promise.all([
      repository.claimNext(claimOptions({ workerId: "a", now })),
      repository.claimNext(claimOptions({ workerId: "b", now })),
      repository.claimNext(claimOptions({ workerId: "c", now })),
    ]);
    const ids = claims.filter(Boolean).map((c) => c?._id.toString());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("markSent persists provider + providerMessageId and is terminal", async () => {
    const { record } = await repository.enqueue(enqueueInput());
    await repository.claimNext(claimOptions());
    const sent = await repository.markSent(record._id, {
      provider: "twilio",
      providerMessageId: "SM123",
      now: new Date(),
    });
    expect(sent?.status).toBe("SENT");
    expect(sent?.provider).toBe("twilio");
    expect(sent?.providerMessageId).toBe("SM123");
    expect(sent?.sentAt).toBeInstanceOf(Date);
  });

  it("scheduleRetry returns the row to PENDING with nextAttemptAt; markFailed is terminal", async () => {
    const { record } = await repository.enqueue(enqueueInput());
    await repository.claimNext(claimOptions());
    const retried = await repository.scheduleRetry(record._id, {
      category: "NETWORK_TRANSIENT",
      message: "network error contacting provider",
      nextAttemptAt: new Date(Date.now() + 60_000),
    });
    expect(retried?.status).toBe("PENDING");
    expect(retried?.nextAttemptAt).toBeInstanceOf(Date);
    expect(retried?.lastErrorCategory).toBe("NETWORK_TRANSIENT");

    // its backoff window elapses → it becomes claimable again
    await SmsOutboxModel.updateOne(
      { _id: record._id },
      { $set: { nextAttemptAt: new Date(Date.now() - 1000) } },
    );
    const reclaimed = await repository.claimNext(claimOptions());
    expect(reclaimed?.status).toBe("PROCESSING");
    const failed = await repository.markFailed(record._id, {
      category: "PROVIDER_PERMANENT",
      message: "provider returned 422",
    });
    expect(failed?.status).toBe("FAILED");
  });

  it("a row that has burned all attempts is no longer claimable (bounded retries)", async () => {
    const { record } = await repository.enqueue(enqueueInput());
    await SmsOutboxModel.updateOne(
      { _id: record._id },
      { $set: { attemptCount: 5, status: "PENDING" } },
    );
    expect(await repository.claimNext(claimOptions({ maxAttempts: 5 }))).toBeNull();
  });

  it("resetStaleProcessing returns a stale PROCESSING row to PENDING", async () => {
    const { record } = await repository.enqueue(enqueueInput());
    await repository.claimNext(claimOptions());
    await SmsOutboxModel.updateOne(
      { _id: record._id },
      { $set: { claimedAt: new Date(Date.now() - 10 * 60_000) } },
    );
    const recovered = await repository.resetStaleProcessing(new Date(Date.now() - 5 * 60_000));
    expect(recovered).toBe(1);
    expect((await SmsOutboxModel.findById(record._id))?.status).toBe("PENDING");
  });
});
