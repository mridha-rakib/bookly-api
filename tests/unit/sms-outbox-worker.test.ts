import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

import { SmsError } from "../../src/modules/sms/sms.errors.js";
import type { SmsTransport } from "../../src/modules/sms/sms-transport.js";
import type { SmsOutboxDocument } from "../../src/modules/sms-outbox/sms-outbox.model.js";
import type { SmsOutboxRepository } from "../../src/modules/sms-outbox/sms-outbox.repository.js";
import { SmsOutboxWorker } from "../../src/modules/sms-outbox/sms-outbox-worker.js";

const NOW = new Date("2026-09-10T09:00:00.000Z");

const makeRow = (overrides: Partial<SmsOutboxDocument> = {}): SmsOutboxDocument =>
  ({
    _id: new Types.ObjectId(),
    dedupeKey: "APPOINTMENT_REMINDER_24H:booking:1::+35799123456",
    eventKey: "APPOINTMENT_REMINDER_24H:booking:1",
    recipientE164: "+35799123456",
    body: "Bookly reminder: ...",
    status: "PROCESSING",
    attemptCount: 1,
    ...overrides,
  }) as unknown as SmsOutboxDocument;

const build = (transportImpl: Partial<SmsTransport>) => {
  const repository = {
    resetStaleProcessing: vi.fn().mockResolvedValue(0),
    claimNext: vi.fn(),
    markSent: vi.fn().mockResolvedValue(null),
    scheduleRetry: vi.fn().mockResolvedValue(null),
    markFailed: vi.fn().mockResolvedValue(null),
  } as unknown as SmsOutboxRepository & Record<string, ReturnType<typeof vi.fn>>;

  const transport: SmsTransport = {
    provider: "twilio",
    isConfigured: () => true,
    send: vi.fn(),
    ...transportImpl,
  };

  const worker = new SmsOutboxWorker(
    repository,
    transport,
    { workerId: "t", maxAttempts: 5, claimTimeoutMs: 120_000, retryBaseMs: 60_000, concurrency: 2 },
    () => NOW,
  );
  return { worker, repository, transport };
};

describe("SmsOutboxWorker.processOne", () => {
  it("SENT + providerMessageId persisted on provider acceptance", async () => {
    const h = build({
      send: vi.fn().mockResolvedValue({
        provider: "twilio",
        status: "PROVIDER_ACCEPTED",
        providerMessageId: "SM42",
      }),
    });
    expect(await h.worker.processOne(makeRow())).toBe("sent");
    expect(h.transport.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+35799123456", body: "Bookly reminder: ..." }),
    );
    expect(h.repository.markSent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: "twilio", providerMessageId: "SM42" }),
    );
  });

  it("retryable failure → scheduleRetry with an exponential-backoff nextAttemptAt", async () => {
    const h = build({ send: vi.fn().mockRejectedValue(new SmsError("NETWORK_TRANSIENT")) });
    expect(await h.worker.processOne(makeRow({ attemptCount: 1 }))).toBe("retried");
    expect(h.repository.scheduleRetry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        category: "NETWORK_TRANSIENT",
        nextAttemptAt: new Date(NOW.getTime() + 60_000), // base * 2^(1-1)
      }),
    );
    expect(h.repository.markFailed).not.toHaveBeenCalled();
  });

  it("permanent failure → markFailed immediately", async () => {
    const h = build({ send: vi.fn().mockRejectedValue(new SmsError("INVALID_DESTINATION")) });
    expect(await h.worker.processOne(makeRow({ attemptCount: 1 }))).toBe("failed");
    expect(h.repository.markFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ category: "INVALID_DESTINATION" }),
    );
    expect(h.repository.scheduleRetry).not.toHaveBeenCalled();
  });

  it("retryable but attempts exhausted → markFailed", async () => {
    const h = build({ send: vi.fn().mockRejectedValue(new SmsError("PROVIDER_TRANSIENT")) });
    expect(await h.worker.processOne(makeRow({ attemptCount: 5 }))).toBe("failed");
    expect(h.repository.markFailed).toHaveBeenCalled();
    expect(h.repository.scheduleRetry).not.toHaveBeenCalled();
  });

  it("runOnce recovers stale claims and stops when claimNext returns null", async () => {
    const h = build({});
    vi.mocked(h.repository.resetStaleProcessing).mockResolvedValue(2);
    vi.mocked(h.repository.claimNext).mockResolvedValue(null);
    const counts = await h.worker.runOnce(10);
    expect(counts.recoveredStale).toBe(2);
    expect(counts.claimed).toBe(0);
  });
});
