import { describe, expect, it, vi } from "vitest";

import { logger } from "../../src/config/logger.js";
import type {
  EmailOutboxWorker,
  EmailWorkerPassCounts,
} from "../../src/modules/email-outbox/email-outbox-worker.js";
import { runContinuous, runOnce } from "../../src/scripts/run-email-worker.js";

vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** F4A — transactional email worker runner. Synthetic worker doubles only. */

const counts = (overrides: Partial<EmailWorkerPassCounts> = {}): EmailWorkerPassCounts => ({
  claimed: 0,
  sent: 0,
  retried: 0,
  failed: 0,
  recoveredStale: 0,
  acceptedNotRecorded: 0,
  ownershipLost: 0,
  ...overrides,
});

describe("email worker runner", () => {
  it("runs passes strictly one at a time (no overlapping interval passes)", async () => {
    let stopping = false;
    let active = 0;
    let maximumActive = 0;
    let passes = 0;
    const worker = {
      runOnce: vi.fn(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active -= 1;
        passes += 1;
        return counts();
      }),
    } as unknown as EmailOutboxWorker;

    await runContinuous(
      worker,
      5_000,
      () => stopping,
      async (milliseconds) => {
        expect(milliseconds).toBe(5_000);
        if (passes >= 3) stopping = true;
      },
    );

    expect(worker.runOnce).toHaveBeenCalledTimes(3);
    expect(maximumActive).toBe(1);
  });

  it("passes the shutdown signal into the pass so no new rows are claimed while stopping", async () => {
    const stop = () => true;
    const worker = { runOnce: vi.fn(async () => counts()) } as unknown as EmailOutboxWorker;

    await runOnce(worker, stop);

    expect(vi.mocked(worker.runOnce).mock.calls[0]?.[1]).toBe(stop);
  });

  it("a failed pass is logged without the raw error and retried after the interval", async () => {
    let stopping = false;
    const worker = {
      runOnce: vi
        .fn()
        .mockRejectedValueOnce(new Error("mongodb://user:secret@db.example.test refused"))
        .mockResolvedValueOnce(counts()),
    } as unknown as EmailOutboxWorker;
    const waits: number[] = [];

    await runContinuous(
      worker,
      7_000,
      () => stopping,
      async (milliseconds) => {
        waits.push(milliseconds);
        if (waits.length === 2) stopping = true;
      },
    );

    expect(worker.runOnce).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([7_000, 7_000]);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      { event: "EMAIL_WORKER_PASS_FAILED" },
      "Email worker pass failed",
    );
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("secret");
  });

  it("makes failures and unrecorded outcomes visible instead of reporting a clean pass", async () => {
    const worker = {
      runOnce: vi.fn(async () => counts({ claimed: 1, sent: 1, acceptedNotRecorded: 1 })),
    } as unknown as EmailOutboxWorker;

    await runOnce(worker);

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ counts: expect.objectContaining({ acceptedNotRecorded: 1 }) }),
      "Email worker pass completed with failures or unrecorded outcomes",
    );
  });
});
