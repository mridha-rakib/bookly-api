import { readFileSync } from "node:fs";
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "../../src/config/logger.js";
import { EmailError } from "../../src/modules/email/email.errors.js";
import { EmailService } from "../../src/modules/email/email.service.js";
import type { EmailTransport } from "../../src/modules/email/email-transport.js";
import type { EmailOutboxDocument } from "../../src/modules/email-outbox/email-outbox.model.js";
import type {
  EmailOutboxClaimFence,
  EmailOutboxRepository,
} from "../../src/modules/email-outbox/email-outbox.repository.js";
import { emailOutboxStatuses } from "../../src/modules/email-outbox/email-outbox.types.js";
import {
  EmailOutboxWorker,
  type EmailWorkerOptions,
} from "../../src/modules/email-outbox/email-outbox-worker.js";
import {
  BookingCreatedNotifier,
  type BookingNotificationUserPort,
} from "../../src/modules/notification/booking-created.notifier.js";
import { buildBooking, buildBusiness } from "./stage-b-fixtures.js";

vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * F4A — queue / claim / provider-acceptance integrity of the transactional email worker.
 * Synthetic in-memory outbox + synthetic transport only. Nothing contacts a provider or DB.
 * The real Mongo fence semantics are covered in email-outbox-claim-fence.integration.test.ts.
 */

const OPTIONS: EmailWorkerOptions = {
  workerId: "f4a-worker",
  maxAttempts: 3,
  claimTimeoutMs: 120_000,
  retryBaseMs: 60_000,
  concurrency: 2,
};
const NOW = new Date("2026-10-26T09:00:00.000Z");

type Row = EmailOutboxDocument;

/** In-memory outbox that mirrors the repository's fence rules. */
class FencedOutbox {
  public rows: Row[] = [];
  public resetStaleProcessing = vi.fn(async (_staleBefore: Date, _maxAttempts?: number) => 0);

  public claimNext = vi.fn(async (): Promise<Row | null> => {
    const row = this.rows.find(
      (r) => r.status === "PENDING" && r.attemptCount < OPTIONS.maxAttempts,
    );
    if (!row) return null;
    row.status = "PROCESSING";
    row.attemptCount += 1;
    row.claimedAt = NOW;
    row.claimedBy = OPTIONS.workerId;
    return { ...row } as Row;
  });

  private owned(id: Types.ObjectId, claim?: EmailOutboxClaimFence): Row | undefined {
    const row = this.rows.find((r) => r._id.equals(id));
    if (!row || row.status !== "PROCESSING") return undefined;
    if (claim && (row.attemptCount !== claim.attemptCount || row.claimedBy !== claim.claimedBy))
      return undefined;
    return row;
  }

  public markSent = vi.fn(
    async (id: Types.ObjectId, input: { provider: string; providerMessageId?: string }) => {
      const row = this.rows.find((r) => r._id.equals(id));
      if (!row || (row.status !== "PROCESSING" && row.status !== "PENDING")) return null;
      row.status = "SENT";
      row.provider = input.provider;
      if (input.providerMessageId) row.providerMessageId = input.providerMessageId;
      return row;
    },
  );

  public scheduleRetry = vi.fn(
    async (
      id: Types.ObjectId,
      input: { nextAttemptAt: Date; category: string; claim?: EmailOutboxClaimFence },
    ) => {
      const row = this.owned(id, input.claim);
      if (!row) return null;
      row.status = "PENDING";
      row.nextAttemptAt = input.nextAttemptAt;
      return row;
    },
  );

  public markFailed = vi.fn(
    async (id: Types.ObjectId, input: { category: string; claim?: EmailOutboxClaimFence }) => {
      const row = this.owned(id, input.claim);
      if (!row) return null;
      row.status = "FAILED";
      row.lastErrorCategory = input.category;
      return row;
    },
  );
}

const makeRow = (overrides: Partial<Row> = {}): Row =>
  ({
    _id: new Types.ObjectId(),
    dedupeKey: `evt::BUSINESS_REGISTERED::${Math.random()}@example.com`,
    eventKey: "BUSINESS_REGISTERED:synthetic",
    templateKey: "BUSINESS_REGISTERED",
    recipient: "owner@example.com",
    payload: {},
    status: "PENDING",
    attemptCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }) as Row;

const emailService = (send: (...args: unknown[]) => Promise<unknown>) =>
  ({
    render: vi.fn(() => ({ subject: "s", text: "t" })),
    sendRendered: vi.fn(send),
  }) as unknown as EmailService;

const workerFor = (outbox: FencedOutbox, service: EmailService) =>
  new EmailOutboxWorker(outbox as unknown as EmailOutboxRepository, service, OPTIONS, () => NOW);

const accepted = { provider: "sendgrid", status: "PROVIDER_ACCEPTED", providerMessageId: "m-1" };

describe("F4A email outbox delivery integrity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes this claim's owner and attempt number into every retry/failure write", async () => {
    const outbox = new FencedOutbox();
    outbox.rows = [makeRow(), makeRow()];
    let call = 0;
    const service = emailService(async () => {
      call += 1;
      throw new EmailError(call === 1 ? "RATE_LIMITED" : "PROVIDER_PERMISSION_OR_SENDER_ERROR");
    });

    await workerFor(outbox, service).runOnce(2);

    expect(outbox.scheduleRetry.mock.calls[0]?.[1]).toMatchObject({
      claim: { claimedBy: OPTIONS.workerId, attemptCount: 1 },
    });
    expect(outbox.markFailed.mock.calls[0]?.[1]).toMatchObject({
      claim: { claimedBy: OPTIONS.workerId, attemptCount: 1 },
    });
  });

  it("a stale failure cannot overwrite a newer claim; it is counted, not hidden", async () => {
    const outbox = new FencedOutbox();
    const row = makeRow();
    outbox.rows = [row];
    const service = emailService(async () => {
      // While this send is in flight the claim goes stale and another worker reclaims it.
      row.attemptCount += 1;
      row.claimedBy = "other-worker";
      throw new EmailError("PROVIDER_PERMISSION_OR_SENDER_ERROR");
    });

    const counts = await workerFor(outbox, service).runOnce(1);

    expect(outbox.rows[0]?.status).toBe("PROCESSING");
    expect(outbox.rows[0]?.claimedBy).toBe("other-worker");
    expect(counts.ownershipLost).toBe(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ event: "EMAIL_CLAIM_SUPERSEDED" }),
      expect.any(String),
    );
  });

  it("a provider acceptance after the claim was reset to PENDING is still recorded (no avoidable resend)", async () => {
    const outbox = new FencedOutbox();
    const row = makeRow();
    outbox.rows = [row];
    const send = vi.fn(async () => {
      row.status = "PENDING"; // stale sweep ran mid-send
      return accepted;
    });
    const worker = workerFor(outbox, emailService(send));

    const first = await worker.runOnce(1);
    const second = await worker.runOnce(1);

    expect(first.sent).toBe(1);
    expect(outbox.rows[0]?.status).toBe("SENT");
    expect(second.claimed).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("acceptance that cannot be recorded is surfaced, never converted into a retry or failure", async () => {
    const outbox = new FencedOutbox();
    outbox.rows = [makeRow()];
    outbox.markSent.mockResolvedValueOnce(null);

    const counts = await workerFor(
      outbox,
      emailService(async () => accepted),
    ).runOnce(1);

    expect(counts.sent).toBe(1);
    expect(counts.acceptedNotRecorded).toBe(1);
    expect(outbox.scheduleRetry).not.toHaveBeenCalled();
    expect(outbox.markFailed).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "EMAIL_ACCEPTANCE_NOT_RECORDED",
        recipient: "o***r@example.com",
      }),
      expect.stringContaining("resend is possible"),
    );
  });

  it("a database error while recording SENT does not schedule a resend of an accepted email", async () => {
    const outbox = new FencedOutbox();
    outbox.rows = [makeRow()];
    outbox.markSent.mockRejectedValueOnce(new Error("mongodb://user:secret@db/x unreachable"));

    const counts = await workerFor(
      outbox,
      emailService(async () => accepted),
    ).runOnce(1);

    expect(counts.acceptedNotRecorded).toBe(1);
    expect(outbox.scheduleRetry).not.toHaveBeenCalled();
    expect(outbox.markFailed).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("secret");
  });

  it("crash after claim: the next pass asks the repository to recover stale and exhausted claims", async () => {
    const outbox = new FencedOutbox();
    await workerFor(
      outbox,
      emailService(async () => accepted),
    ).runOnce(5);

    expect(outbox.resetStaleProcessing).toHaveBeenCalledWith(
      new Date(NOW.getTime() - OPTIONS.claimTimeoutMs),
      OPTIONS.maxAttempts,
    );
  });

  it("shutdown during an active send: no new claims, the in-flight send finishes and is recorded", async () => {
    const outbox = new FencedOutbox();
    outbox.rows = [makeRow(), makeRow(), makeRow()];
    let stopping = false;
    const inFlight = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const send = vi.fn(async () => {
      inFlight.resolve();
      await release.promise;
      return accepted;
    });
    const worker = new EmailOutboxWorker(
      outbox as unknown as EmailOutboxRepository,
      emailService(send),
      { ...OPTIONS, concurrency: 1 },
      () => NOW,
    );

    const pass = worker.runOnce(3, () => stopping);
    await inFlight.promise;
    stopping = true;
    release.resolve();
    const counts = await pass;

    expect(counts.claimed).toBe(1);
    expect(counts.sent).toBe(1);
    expect(outbox.rows.map((r) => r.status)).toEqual(["SENT", "PENDING", "PENDING"]);
  });

  it("a failing runner does not end the pass while another runner's send is still in flight", async () => {
    const outbox = new FencedOutbox();
    outbox.rows = [makeRow(), makeRow()];
    const release = Promise.withResolvers<void>();
    let calls = 0;
    // Runner A sends row 1 at once, then its next claim fails. Runner B is still sending row 2.
    const send = vi.fn(async () => {
      calls += 1;
      if (calls === 2) await release.promise;
      return accepted;
    });
    const realClaim = outbox.claimNext.getMockImplementation() as () => Promise<Row | null>;
    let claims = 0;
    outbox.claimNext.mockImplementation(async () => {
      claims += 1;
      if (claims === 3) throw new Error("claim failed");
      return realClaim();
    });
    let settled = false;
    const pass = workerFor(outbox, emailService(send))
      .runOnce(4)
      .finally(() => {
        settled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    release.resolve();
    await expect(pass).rejects.toThrow("claim failed");
    expect(outbox.rows[1]?.status).toBe("SENT");
  });

  it("the outbox has no DELIVERED state; the worker only ever records provider acceptance as SENT", () => {
    expect(emailOutboxStatuses).toEqual(["PENDING", "PROCESSING", "SENT", "FAILED"]);
    const source = readFileSync(
      new URL("../../src/modules/email-outbox/email-outbox-worker.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/status:\s*"DELIVERED"/);
  });
});

describe("F4A committed Booking → outbox → worker (synthetic transport)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends the confirmation to the persisted Booking contact with payload facts from the Booking", async () => {
    const business = buildBusiness();
    const booking = buildBooking({
      businessId: business._id,
      createdBy: { actorUserId: new Types.ObjectId(), actorRole: "CUSTOMER" },
    });
    const outbox = new FencedOutbox();
    const enqueue = vi.fn(
      async (input: {
        eventKey: string;
        templateKey: string;
        recipient: string;
        payload: Record<string, unknown>;
      }) => {
        const dedupeKey = `${input.eventKey}::${input.templateKey}::${input.recipient}`;
        const existing = outbox.rows.find((r) => r.dedupeKey === dedupeKey);
        if (existing) return { created: false, record: existing };
        const row = makeRow({ ...input, dedupeKey });
        outbox.rows.push(row);
        return { created: true, record: row };
      },
    );
    const users: BookingNotificationUserPort = {
      findManyByIds: async () => [
        { _id: business.ownerUserId, normalizedEmail: "owner@example.com" },
      ],
      findProfilesByUserIds: async () => [],
    } as unknown as BookingNotificationUserPort;
    const notifier = new BookingCreatedNotifier({ enqueue } as never, users);

    await notifier.notifyBookingCreated(booking, business);
    // A replayed post-commit dispatch resolves to the same rows (deterministic event identity).
    await notifier.notifyBookingCreated(booking, business);
    expect(outbox.rows).toHaveLength(2);

    const sent: Array<{ to: string; subject: string; metadata?: Record<string, string> }> = [];
    const transport: EmailTransport = {
      provider: "sendgrid",
      isConfigured: () => true,
      send: vi.fn(async (input) => {
        sent.push(input);
        return { provider: "sendgrid", status: "PROVIDER_ACCEPTED" as const };
      }),
    };
    const counts = await workerFor(outbox, new EmailService(transport)).runOnce(10);

    expect(counts.sent).toBe(2);
    const customer = outbox.rows.find((r) => r.templateKey === "BOOKING_CUSTOMER_CONFIRMED");
    if (!customer) {
      throw new Error("Expected BOOKING_CUSTOMER_CONFIRMED notification to exist");
    }
    expect(customer?.recipient).toBe("dana@example.com");
    expect(customer?.eventKey).toBe(`BOOKING_CREATED:${String(booking._id)}`);
    expect((customer.payload as { reference?: string }).reference).toBe(booking.reference);
    expect(sent.map((s) => s.to).sort()).toEqual(["dana@example.com", "owner@example.com"]);
    expect(sent.every((s) => s.metadata?.["eventKey"] === customer?.eventKey)).toBe(true);
    expect(outbox.rows.every((r) => r.status === "SENT")).toBe(true);
  });
});
