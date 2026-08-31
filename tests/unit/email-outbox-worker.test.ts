import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmailError } from "../../src/modules/email/email.errors.js";
import type { EmailService } from "../../src/modules/email/email.service.js";
import type { EmailOutboxDocument } from "../../src/modules/email-outbox/email-outbox.model.js";
import type { EmailOutboxRepository } from "../../src/modules/email-outbox/email-outbox.repository.js";
import {
  EmailOutboxWorker,
  type EmailWorkerOptions,
} from "../../src/modules/email-outbox/email-outbox-worker.js";

/**
 * MAILING STAGE A — worker send/retry/fail decisions + bounded processing (Phase R/S).
 * Part Y items 34, 35, 36, 39, 40, 41, 42. The DB-level atomic-claim / dedupe / stale-recovery
 * guarantees (items 31–33, 37, 38) are exercised in the database integration test.
 */

const OPTIONS: EmailWorkerOptions = {
  workerId: "test-worker",
  maxAttempts: 5,
  claimTimeoutMs: 120_000,
  retryBaseMs: 60_000,
  concurrency: 3,
};

const NOW = new Date("2026-08-29T12:00:00.000Z");

type Row = EmailOutboxDocument;

const makeRow = (overrides: Partial<Row> = {}): Row =>
  ({
    _id: new Types.ObjectId(),
    dedupeKey: `evt::OTP_VERIFICATION::to${Math.random()}@example.com`,
    eventKey: "evt",
    templateKey: "BUSINESS_REGISTERED",
    recipient: "to@example.com",
    payload: {},
    status: "PENDING",
    attemptCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }) as Row;

/** Minimal in-memory stand-in with an atomic-ish claim (pops eligible rows one at a time). */
class FakeRepo {
  public rows: Row[] = [];
  public resetStaleProcessing = vi.fn(async () => 0);

  public claimNext = vi.fn(async (): Promise<Row | null> => {
    const row = this.rows.find(
      (r) => r.status === "PENDING" && r.attemptCount < OPTIONS.maxAttempts,
    );
    if (!row) return null;
    row.status = "PROCESSING";
    row.attemptCount += 1;
    row.claimedAt = NOW;
    return { ...row } as Row;
  });

  public markSent = vi.fn(
    async (id: Types.ObjectId, input: { provider: string; providerMessageId?: string }) => {
      const row = this.rows.find((r) => r._id.equals(id));
      if (row) {
        row.status = "SENT";
        row.provider = input.provider;
        if (input.providerMessageId) row.providerMessageId = input.providerMessageId;
      }
      return row ?? null;
    },
  );

  public scheduleRetry = vi.fn(
    async (id: Types.ObjectId, input: { nextAttemptAt: Date; category: string }) => {
      const row = this.rows.find((r) => r._id.equals(id));
      if (row) {
        row.status = "PENDING";
        row.nextAttemptAt = input.nextAttemptAt;
        row.lastErrorCategory = input.category;
      }
      return row ?? null;
    },
  );

  public markFailed = vi.fn(async (id: Types.ObjectId, input: { category: string }) => {
    const row = this.rows.find((r) => r._id.equals(id));
    if (row) {
      row.status = "FAILED";
      row.lastErrorCategory = input.category;
    }
    return row ?? null;
  });
}

const makeEmailService = (send: EmailService["sendRendered"]): EmailService =>
  ({
    render: vi.fn(() => ({ subject: "s", html: "<p>h</p>", text: "t" })),
    sendRendered: send,
  }) as unknown as EmailService;

const buildWorker = (repo: FakeRepo, email: EmailService) =>
  new EmailOutboxWorker(repo as unknown as EmailOutboxRepository, email, OPTIONS, () => NOW);

describe("EmailOutboxWorker", () => {
  beforeEach(() => vi.clearAllMocks());

  it("39/40 successful send marks the row SENT and persists the provider message id", async () => {
    const repo = new FakeRepo();
    repo.rows = [makeRow()];
    const send = vi.fn().mockResolvedValue({
      provider: "sendgrid",
      status: "PROVIDER_ACCEPTED",
      providerMessageId: "x-msg-77",
    });

    const counts = await buildWorker(repo, makeEmailService(send)).runOnce(10);

    expect(counts.sent).toBe(1);
    expect(repo.markSent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: "sendgrid", providerMessageId: "x-msg-77" }),
    );
    expect(repo.rows[0]?.status).toBe("SENT");
    expect(repo.rows[0]?.providerMessageId).toBe("x-msg-77");
  });

  it("34 a transient provider error schedules a bounded backoff retry", async () => {
    const repo = new FakeRepo();
    repo.rows = [makeRow()];
    const send = vi.fn().mockRejectedValue(new EmailError("RATE_LIMITED"));

    const counts = await buildWorker(repo, makeEmailService(send)).runOnce(10);

    expect(counts.retried).toBe(1);
    expect(repo.markFailed).not.toHaveBeenCalled();
    const retryArg = repo.scheduleRetry.mock.calls[0]?.[1] as { nextAttemptAt: Date };
    // attemptCount == 1 after claim -> first retry waits exactly retryBaseMs.
    expect(retryArg.nextAttemptAt.getTime()).toBe(NOW.getTime() + OPTIONS.retryBaseMs);
    expect(repo.rows[0]?.status).toBe("PENDING");
  });

  it("35 a permanent provider error moves the row straight to FAILED", async () => {
    const repo = new FakeRepo();
    repo.rows = [makeRow()];
    const send = vi.fn().mockRejectedValue(new EmailError("PROVIDER_PERMISSION_OR_SENDER_ERROR"));

    const counts = await buildWorker(repo, makeEmailService(send)).runOnce(10);

    expect(counts.failed).toBe(1);
    expect(repo.scheduleRetry).not.toHaveBeenCalled();
    expect(repo.rows[0]?.status).toBe("FAILED");
  });

  it("36 retries stop once maxAttempts is reached — even for a retryable error", async () => {
    const repo = new FakeRepo();
    repo.rows = [makeRow({ attemptCount: OPTIONS.maxAttempts - 1 })];
    const send = vi.fn().mockRejectedValue(new EmailError("PROVIDER_TRANSIENT"));

    const counts = await buildWorker(repo, makeEmailService(send)).runOnce(10);

    expect(counts.retried).toBe(0);
    expect(counts.failed).toBe(1);
    expect(repo.markFailed).toHaveBeenCalled();
    expect(repo.rows[0]?.status).toBe("FAILED");
  });

  it("41 never processes more than batchSize rows in one pass", async () => {
    const repo = new FakeRepo();
    repo.rows = [makeRow(), makeRow(), makeRow(), makeRow(), makeRow()];
    const send = vi.fn().mockResolvedValue({ provider: "sendgrid", status: "PROVIDER_ACCEPTED" });

    const counts = await buildWorker(repo, makeEmailService(send)).runOnce(2);

    expect(counts.claimed).toBe(2);
    expect(counts.sent).toBe(2);
    expect(repo.rows.filter((r) => r.status === "SENT")).toHaveLength(2);
    expect(repo.rows.filter((r) => r.status === "PENDING")).toHaveLength(3);
  });

  it("42 a restart re-run does not resend an already-SENT row", async () => {
    const repo = new FakeRepo();
    repo.rows = [makeRow()];
    const send = vi.fn().mockResolvedValue({ provider: "sendgrid", status: "PROVIDER_ACCEPTED" });
    const worker = buildWorker(repo, makeEmailService(send));

    await worker.runOnce(10);
    const secondPass = await worker.runOnce(10);

    expect(send).toHaveBeenCalledTimes(1);
    expect(secondPass.sent).toBe(0);
    expect(secondPass.claimed).toBe(0);
  });
});
