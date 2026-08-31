import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmailError } from "../../src/modules/email/email.errors.js";
import type { EmailService } from "../../src/modules/email/email.service.js";
import type { EmailOutboxDocument } from "../../src/modules/email-outbox/email-outbox.model.js";
import type { EmailOutboxRepository } from "../../src/modules/email-outbox/email-outbox.repository.js";
import {
  type EmailAttachmentResolver,
  EmailOutboxWorker,
  type EmailWorkerOptions,
} from "../../src/modules/email-outbox/email-outbox-worker.js";
import { InvoiceAttachmentResolver } from "../../src/modules/invoice/invoice-attachment.resolver.js";
import { buildInvoiceDataFixture } from "./stage-c-fixtures.js";

/** MAILING STAGE C — worker PDF-attachment flow (Part AE items 46–51). */

const OPTIONS: EmailWorkerOptions = {
  workerId: "w",
  maxAttempts: 5,
  claimTimeoutMs: 120_000,
  retryBaseMs: 60_000,
  concurrency: 2,
};
const NOW = new Date("2026-09-05T12:00:00.000Z");

const makeRow = (): EmailOutboxDocument =>
  ({
    _id: new Types.ObjectId(),
    dedupeKey: `d${Math.random()}`,
    eventKey: "BOOKING_COMPLETED:1",
    templateKey: "BOOKING_COMPLETED",
    recipient: "dana@example.com",
    payload: { invoice: buildInvoiceDataFixture() },
    status: "PENDING",
    attemptCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
  }) as EmailOutboxDocument;

class FakeRepo {
  public rows: EmailOutboxDocument[] = [];
  public resetStaleProcessing = vi.fn(async () => 0);
  public claimNext = vi.fn(async () => {
    const row = this.rows.find((r) => r.status === "PENDING");
    if (!row) return null;
    row.status = "PROCESSING";
    row.attemptCount += 1;
    return { ...row } as EmailOutboxDocument;
  });
  public markSent = vi.fn(async (id: Types.ObjectId) => {
    const r = this.rows.find((x) => x._id.equals(id));
    if (r) r.status = "SENT";
    return r ?? null;
  });
  public scheduleRetry = vi.fn(async (id: Types.ObjectId) => {
    const r = this.rows.find((x) => x._id.equals(id));
    if (r) r.status = "PENDING";
    return r ?? null;
  });
  public markFailed = vi.fn(async (id: Types.ObjectId) => {
    const r = this.rows.find((x) => x._id.equals(id));
    if (r) r.status = "FAILED";
    return r ?? null;
  });
}

const realRenderedEmail = { subject: "Your booking is complete", html: "<p>h</p>", text: "t" };

const makeWorker = (
  repo: FakeRepo,
  sendRendered: EmailService["sendRendered"],
  resolver: EmailAttachmentResolver = new InvoiceAttachmentResolver(),
) =>
  new EmailOutboxWorker(
    repo as unknown as EmailOutboxRepository,
    { render: vi.fn(() => realRenderedEmail), sendRendered } as unknown as EmailService,
    OPTIONS,
    () => NOW,
    resolver,
  );

describe("EmailOutboxWorker — BOOKING_COMPLETED PDF attachment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("46/47/48 attaches exactly one generated PDF and marks SENT on acceptance", async () => {
    const repo = new FakeRepo();
    repo.rows = [makeRow()];
    const sendRendered = vi.fn(async (_to: string, rendered: { attachments?: unknown[] }) => {
      const pdfs = (rendered.attachments ?? []).filter(
        (a) => (a as { type?: string }).type === "application/pdf",
      );
      expect(pdfs).toHaveLength(1);
      expect((pdfs[0] as { filename: string }).filename).toBe("Bookly-Invoice-BK-7F3K9QZC.pdf");
      expect((pdfs[0] as { content: Buffer }).content.subarray(0, 5).toString("ascii")).toBe(
        "%PDF-",
      );
      return { provider: "sendgrid" as const, status: "PROVIDER_ACCEPTED" as const };
    });

    const counts = await makeWorker(repo, sendRendered).runOnce(5);

    expect(counts.sent).toBe(1);
    expect(sendRendered).toHaveBeenCalledTimes(1);
    expect(repo.rows[0]?.status).toBe("SENT");
  });

  it("49 a transient SendGrid error still retries (PDF regenerated next attempt)", async () => {
    const repo = new FakeRepo();
    repo.rows = [makeRow()];
    const sendRendered = vi.fn().mockRejectedValue(new EmailError("PROVIDER_TRANSIENT"));

    const counts = await makeWorker(repo, sendRendered).runOnce(5);

    expect(counts.retried).toBe(1);
    expect(repo.rows[0]?.status).toBe("PENDING");
  });

  it("50/51 a permanent send error → FAILED; nothing about the row implies the booking changed", async () => {
    const repo = new FakeRepo();
    repo.rows = [makeRow()];
    const sendRendered = vi
      .fn()
      .mockRejectedValue(new EmailError("PROVIDER_PERMISSION_OR_SENDER_ERROR"));

    const counts = await makeWorker(repo, sendRendered).runOnce(5);

    expect(counts.failed).toBe(1);
    expect(repo.rows[0]?.status).toBe("FAILED");
  });

  it("a PDF-generation failure fails the send without touching the row's completion meaning", async () => {
    const repo = new FakeRepo();
    repo.rows = [makeRow()];
    const explodingResolver: EmailAttachmentResolver = {
      resolve: vi.fn().mockRejectedValue(new Error("pdfkit boom")),
    };
    const sendRendered = vi.fn();

    const counts = await makeWorker(repo, sendRendered, explodingResolver).runOnce(5);

    expect(sendRendered).not.toHaveBeenCalled();
    expect(counts.failed).toBe(1);
    expect(repo.rows[0]?.status).toBe("FAILED");
  });
});
