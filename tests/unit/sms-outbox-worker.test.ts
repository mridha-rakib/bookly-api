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
    claimedBy: "t",
    ...overrides,
  }) as unknown as SmsOutboxDocument;

const build = (transportImpl: Partial<SmsTransport>) => {
  const repository = {
    resetStaleProcessing: vi.fn().mockResolvedValue(0),
    claimNext: vi.fn(),
    markProviderStarted: vi.fn().mockImplementation(async (row: SmsOutboxDocument) => row),
    markUnknown: vi.fn().mockImplementation(async (row: SmsOutboxDocument) => row),
    markSent: vi.fn().mockImplementation(async () => makeRow({ status: "SENT" })),
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

  it("network ambiguity after provider permission is quarantined without another send", async () => {
    const h = build({ send: vi.fn().mockRejectedValue(new SmsError("NETWORK_TRANSIENT")) });
    expect(await h.worker.processOne(makeRow({ attemptCount: 1 }))).toBe("failed");
    expect(h.repository.markUnknown).toHaveBeenCalledWith(expect.anything(), "NETWORK_TRANSIENT");
    expect(h.repository.scheduleRetry).not.toHaveBeenCalled();
  });

  it("permanent failure → markFailed immediately", async () => {
    const h = build({ send: vi.fn().mockRejectedValue(new SmsError("INVALID_DESTINATION")) });
    expect(await h.worker.processOne(makeRow({ attemptCount: 1 }))).toBe("failed");
    expect(h.repository.markUnknown).toHaveBeenCalledWith(expect.anything(), "INVALID_DESTINATION");
    expect(h.repository.scheduleRetry).not.toHaveBeenCalled();
  });

  it("retryable but attempts exhausted → markFailed", async () => {
    const h = build({ send: vi.fn().mockRejectedValue(new SmsError("PROVIDER_TRANSIENT")) });
    expect(await h.worker.processOne(makeRow({ attemptCount: 5 }))).toBe("failed");
    expect(h.repository.markUnknown).toHaveBeenCalled();
    expect(h.repository.scheduleRetry).not.toHaveBeenCalled();
  });

  it("does not call provider without a durable exact-claim send permission", async () => {
    const h = build({ send: vi.fn() });
    vi.mocked(h.repository.markProviderStarted).mockResolvedValue(null);
    expect(await h.worker.processOne(makeRow())).toBe("failed");
    expect(h.transport.send).not.toHaveBeenCalled();
  });

  it("does not retry an accepted SMS if result persistence fails", async () => {
    const h = build({
      send: vi.fn().mockResolvedValue({ provider: "twilio", status: "PROVIDER_ACCEPTED" }),
    });
    vi.mocked(h.repository.markSent).mockRejectedValue(new Error("write acknowledgement lost"));
    expect(await h.worker.processOne(makeRow())).toBe("failed");
    expect(h.repository.markUnknown).toHaveBeenCalled();
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
