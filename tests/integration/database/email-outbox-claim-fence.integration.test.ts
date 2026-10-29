import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { EmailOutboxModel } from "../../../src/modules/email-outbox/email-outbox.model.js";
import {
  EMAIL_OUTBOX_CLAIM_ABANDONED,
  EmailOutboxRepository,
} from "../../../src/modules/email-outbox/email-outbox.repository.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

/**
 * F4A — claim ownership, crash recovery and acceptance recording on the real EmailOutbox
 * collection (isolated replica set; synthetic rows only).
 */

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 120_000;

const claimAt = (repository: EmailOutboxRepository, workerId: string, now: Date) =>
  repository.claimNext({ workerId, now, claimTimeoutMs: TIMEOUT_MS, maxAttempts: MAX_ATTEMPTS });

const enqueue = (repository: EmailOutboxRepository) =>
  repository.enqueue({
    eventKey: "BOOKING_CREATED:f4a-synthetic",
    templateKey: "BOOKING_CUSTOMER_CONFIRMED",
    recipient: "customer@example.test",
    payload: { reference: "BK-SYNTH" },
  });

const fenceOf = (row: { claimedBy?: string | undefined; attemptCount: number }) => ({
  claimedBy: row.claimedBy,
  attemptCount: row.attemptCount,
});

describe("EmailOutbox claim fence integration", () => {
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

  it("a stale worker cannot fail or reschedule a row another worker reclaimed", async () => {
    await enqueue(repository);
    const stale = await claimAt(repository, "worker-a", new Date(Date.now() - 10 * 60_000));
    const fresh = await claimAt(repository, "worker-b", new Date());
    if (!stale || !fresh) throw new Error("expected both claims");
    expect(fresh.attemptCount).toBe(2);

    expect(
      await repository.markFailed(stale._id, {
        category: "PROVIDER_PERMISSION_OR_SENDER_ERROR",
        message: "late",
        claim: fenceOf(stale),
      }),
    ).toBeNull();
    expect(
      await repository.scheduleRetry(stale._id, {
        category: "RATE_LIMITED",
        message: "late",
        nextAttemptAt: new Date(),
        claim: fenceOf(stale),
      }),
    ).toBeNull();

    const row = await EmailOutboxModel.findById(fresh._id).lean();
    expect(row).toMatchObject({ status: "PROCESSING", claimedBy: "worker-b", attemptCount: 2 });

    // The current owner's outcome still applies.
    const retried = await repository.scheduleRetry(fresh._id, {
      category: "RATE_LIMITED",
      message: "now",
      nextAttemptAt: new Date(),
      claim: fenceOf(fresh),
    });
    expect(retried?.status).toBe("PENDING");
  });

  it("a provider acceptance from a reset (PENDING) claim is recorded, preventing a later resend", async () => {
    await enqueue(repository);
    const claimed = await claimAt(repository, "worker-a", new Date(Date.now() - 10 * 60_000));
    if (!claimed) throw new Error("expected a claim");
    await repository.resetStaleProcessing(new Date(Date.now() - 5 * 60_000), MAX_ATTEMPTS);

    const sent = await repository.markSent(claimed._id, {
      provider: "sendgrid",
      providerMessageId: "synthetic-msg",
      now: new Date(),
    });

    expect(sent?.status).toBe("SENT");
    expect(await claimAt(repository, "worker-b", new Date())).toBeNull();
  });

  it("markSent never overwrites a FAILED or SENT row", async () => {
    await enqueue(repository);
    const claimed = await claimAt(repository, "worker-a", new Date());
    if (!claimed) throw new Error("expected a claim");
    await repository.markFailed(claimed._id, {
      category: "PROVIDER_PERMISSION_OR_SENDER_ERROR",
      message: "permanent",
      claim: fenceOf(claimed),
    });

    expect(
      await repository.markSent(claimed._id, { provider: "sendgrid", now: new Date() }),
    ).toBeNull();
    expect((await EmailOutboxModel.findById(claimed._id).lean())?.status).toBe("FAILED");
  });

  it("crash on the final attempt: the sweep marks the row FAILED with an explicit unknown outcome", async () => {
    await enqueue(repository);
    let last: Awaited<ReturnType<typeof claimAt>> = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      // Every claim is abandoned (simulated crash); each reclaim happens after the previous one
      // has gone stale (10 minutes apart > 2-minute claim timeout).
      last = await claimAt(
        repository,
        `crashed-${attempt}`,
        new Date(Date.now() - (60 - attempt * 10) * 60_000),
      );
    }
    expect(last?.attemptCount).toBe(MAX_ATTEMPTS);

    const recovered = await repository.resetStaleProcessing(
      new Date(Date.now() - 5 * 60_000),
      MAX_ATTEMPTS,
    );

    expect(recovered).toBe(1);
    const row = await EmailOutboxModel.findOne({}).lean();
    expect(row).toMatchObject({
      status: "FAILED",
      lastErrorCategory: EMAIL_OUTBOX_CLAIM_ABANDONED,
    });
    expect(row?.lastErrorMessage).toMatch(/unknown/);
    expect(row?.claimedBy).toBeUndefined();
  });

  it("restart recovery: a stale claim with attempts left returns to PENDING and is reclaimed once", async () => {
    await enqueue(repository);
    await claimAt(repository, "crashed", new Date(Date.now() - 10 * 60_000));

    expect(
      await repository.resetStaleProcessing(new Date(Date.now() - 5 * 60_000), MAX_ATTEMPTS),
    ).toBe(1);
    const [first, second] = await Promise.all([
      claimAt(repository, "restarted-1", new Date()),
      claimAt(repository, "restarted-2", new Date()),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((first ?? second)?.attemptCount).toBe(2);
  });

  it("the legacy one-argument sweep keeps its previous behavior", async () => {
    await enqueue(repository);
    await claimAt(repository, "crashed", new Date(Date.now() - 10 * 60_000));

    expect(await repository.resetStaleProcessing(new Date(Date.now() - 5 * 60_000))).toBe(1);
    expect((await EmailOutboxModel.findOne({}).lean())?.status).toBe("PENDING");
  });
});
