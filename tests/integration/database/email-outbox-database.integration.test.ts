import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { EmailOutboxModel } from "../../../src/modules/email-outbox/email-outbox.model.js";
import { EmailOutboxRepository } from "../../../src/modules/email-outbox/email-outbox.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * MAILING STAGE A — durable Mongo EmailOutbox: DB-enforced idempotency, atomic claim, and
 * stale-claim recovery (Phase N/O/P/Q). Part Y items 31, 32, 33, 37, 38.
 */

type DbIndex = { name?: string; key: Record<string, unknown>; unique?: boolean };

const enqueueInput = (overrides: Record<string, unknown> = {}) => ({
  eventKey: "BUSINESS_REGISTERED:aaa",
  templateKey: "BUSINESS_REGISTERED" as const,
  recipient: "Owner@Example.com",
  payload: { businessId: "aaa" },
  ...overrides,
});

const claimOptions = (overrides: Record<string, unknown> = {}) => ({
  workerId: "worker-1",
  now: new Date(),
  claimTimeoutMs: 120_000,
  maxAttempts: 5,
  ...overrides,
});

describe("database-backed EmailOutbox integration", () => {
  let repository: EmailOutboxRepository;

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);

  beforeEach(async () => {
    await clearIsolatedDatabase();
    repository = new EmailOutboxRepository();
  });

  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  it("has a unique index on dedupeKey", async () => {
    const indexes = (await EmailOutboxModel.collection.indexes()) as DbIndex[];
    const dedupeIndex = indexes.find((index) => index.key["dedupeKey"] === 1);
    expect(dedupeIndex?.unique).toBe(true);
  });

  it("31 a duplicate (event, template, recipient) cannot create a second row", async () => {
    const first = await repository.enqueue(enqueueInput());
    const second = await repository.enqueue(
      enqueueInput({ payload: { businessId: "aaa", retried: true } }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.record._id.toString()).toBe(first.record._id.toString());
    expect(await EmailOutboxModel.countDocuments({})).toBe(1);
    // recipient was normalised on the way in.
    expect(first.record.recipient).toBe("owner@example.com");
  });

  it("32 claimNext atomically moves one row PENDING -> PROCESSING and won't re-hand it out", async () => {
    await repository.enqueue(enqueueInput());

    const claimed = await repository.claimNext(claimOptions());
    expect(claimed?.status).toBe("PROCESSING");
    expect(claimed?.attemptCount).toBe(1);
    expect(claimed?.claimedBy).toBe("worker-1");

    const again = await repository.claimNext(claimOptions({ workerId: "worker-2" }));
    expect(again).toBeNull();
  });

  it("33 two concurrent workers never claim the same row", async () => {
    for (let i = 0; i < 6; i += 1) {
      await repository.enqueue(
        enqueueInput({ eventKey: `EVT:${i}`, recipient: `u${i}@example.com` }),
      );
    }

    const now = new Date();
    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        repository.claimNext(claimOptions({ workerId: `w${i % 2}`, now })),
      ),
    );

    const claimedIds = claims
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .map((c) => c._id.toString());
    expect(claimedIds).toHaveLength(6);
    expect(new Set(claimedIds).size).toBe(6);
  });

  it("37 a stale PROCESSING row is recovered to PENDING and can be claimed again", async () => {
    await repository.enqueue(enqueueInput());
    const claimedAt = new Date(Date.now() - 10 * 60_000);
    await repository.claimNext(claimOptions({ now: claimedAt }));

    const recovered = await repository.resetStaleProcessing(new Date(Date.now() - 5 * 60_000));
    expect(recovered).toBe(1);

    const reclaimed = await repository.claimNext(claimOptions());
    expect(reclaimed?.status).toBe("PROCESSING");
    // attemptCount accumulates across claims so a poisoned row eventually stops.
    expect(reclaimed?.attemptCount).toBe(2);
  });

  it("claimNext also self-heals a stale PROCESSING row without an explicit sweep", async () => {
    await repository.enqueue(enqueueInput());
    const longAgo = new Date(Date.now() - 60 * 60_000);
    await repository.claimNext(claimOptions({ now: longAgo }));

    const reclaimed = await repository.claimNext(claimOptions({ now: new Date() }));
    expect(reclaimed?.status).toBe("PROCESSING");
  });

  it("38 a SENT row is terminal — never claimed and never overwritten", async () => {
    await repository.enqueue(enqueueInput());
    const claimed = await repository.claimNext(claimOptions());
    if (!claimed) {
      throw new Error("expected a claimed row");
    }
    await repository.markSent(claimed._id, {
      provider: "sendgrid",
      providerMessageId: "m1",
      now: new Date(),
    });

    expect(await repository.claimNext(claimOptions())).toBeNull();

    // A late settle attempt from a crashed worker must not move it off SENT.
    const lateRetry = await repository.scheduleRetry(claimed._id, {
      category: "RATE_LIMITED",
      message: "late",
      nextAttemptAt: new Date(),
    });
    expect(lateRetry).toBeNull();
    const row = await EmailOutboxModel.findById(claimed._id).lean();
    expect(row?.status).toBe("SENT");
    expect(row?.providerMessageId).toBe("m1");
  });
});
