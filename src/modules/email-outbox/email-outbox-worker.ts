import { logger } from "../../config/logger.js";
import { EmailError } from "../email/email.errors.js";
import { logEmailAccepted, logEmailFailed } from "../email/email.logging.js";
import type { EmailService } from "../email/email.service.js";
import type { RenderedEmail } from "../email/email.types.js";
import { maskEmail } from "../email/email-transport.js";
import {
  type EmailTemplateKey,
  EmailTemplateNotRegisteredError,
} from "../email/template-registry.js";
import type { EmailOutboxDocument } from "./email-outbox.model.js";
import type { EmailOutboxRepository } from "./email-outbox.repository.js";

export type EmailWorkerOptions = {
  workerId: string;
  maxAttempts: number;
  claimTimeoutMs: number;
  /** First retry waits this long; each subsequent retry doubles it. */
  retryBaseMs: number;
  /** Upper bound on rows processed concurrently within a single pass. */
  concurrency: number;
};

export type EmailWorkerPassCounts = {
  claimed: number;
  /** Provider ACCEPTED the request. Never proof of recipient delivery. */
  sent: number;
  retried: number;
  failed: number;
  recoveredStale: number;
  /** Provider accepted, but the row was already terminal so SENT could not be recorded. */
  acceptedNotRecorded: number;
  /** A retry/failure outcome was dropped because a newer claim owns the row. */
  ownershipLost: number;
};

type ProcessOutcome = "sent" | "retried" | "failed";
type IntegrityEvent = "acceptedNotRecorded" | "ownershipLost";

/** Safe fields only (masked recipient, no payload, no raw error). */
const logEmailOutcomeNotRecorded = (context: {
  provider?: string | undefined;
  templateKey: string;
  eventKey: string;
  recipient: string;
  outcome: ProcessOutcome;
}): void => {
  logger.warn(
    {
      event:
        context.outcome === "sent" ? "EMAIL_ACCEPTANCE_NOT_RECORDED" : "EMAIL_CLAIM_SUPERSEDED",
      ...(context.provider ? { provider: context.provider } : {}),
      templateKey: context.templateKey,
      eventKey: context.eventKey,
      recipient: maskEmail(context.recipient),
      outcome: context.outcome,
    },
    context.outcome === "sent"
      ? "Email accepted by provider but SENT was not recorded — a later resend is possible"
      : "Email outcome dropped — a newer claim owns this outbox row",
  );
};

const safeErrorMessage = (error: unknown): string => {
  if (error instanceof EmailError) {
    return error.safeProviderMessage ?? error.category;
  }
  if (error instanceof Error) {
    return error.name;
  }
  return "unknown error";
};

/**
 * Drains the {@link EmailOutboxRepository}. Not a queue framework — correctness lives in the
 * repository's atomic claim + unique index (same philosophy as the no-show worker). This class
 * only decides send / retry / fail and bounds concurrency.
 */
/**
 * Optional per-template attachment producer (Stage C). Lets the worker attach a rendered PDF
 * (or any other Buffer) that a pure, synchronous template cannot build itself — generated ONCE
 * per send attempt, right before the provider call. Returns `[]` for templates it doesn't
 * handle.
 */
export type EmailAttachmentResolver = {
  resolve(
    templateKey: string,
    payload: unknown,
  ): Promise<
    Array<{
      filename: string;
      content: Buffer;
      type: string;
      disposition?: "attachment" | "inline";
      contentId?: string;
    }>
  >;
};

export class EmailOutboxWorker {
  public constructor(
    private readonly repository: EmailOutboxRepository,
    private readonly emailService: EmailService,
    private readonly options: EmailWorkerOptions,
    private readonly clock: () => Date = () => new Date(),
    private readonly attachmentResolver?: EmailAttachmentResolver,
    private readonly deliveryEligibility?: {
      check(record: EmailOutboxDocument, now: Date): Promise<boolean>;
    },
  ) {}

  /**
   * @param shouldStop optional shutdown signal: once true, no NEW row is claimed; sends already
   *   in flight finish and record their outcome.
   */
  public async runOnce(
    batchSize: number,
    shouldStop: () => boolean = () => false,
  ): Promise<EmailWorkerPassCounts> {
    const counts: EmailWorkerPassCounts = {
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
      recoveredStale: 0,
      acceptedNotRecorded: 0,
      ownershipLost: 0,
    };

    counts.recoveredStale = await this.repository.resetStaleProcessing(
      new Date(this.clock().getTime() - this.options.claimTimeoutMs),
      this.options.maxAttempts,
    );

    let remaining = batchSize;
    const claimLock = { taken: 0 };

    const runner = async (): Promise<void> => {
      while (claimLock.taken < remaining && !shouldStop()) {
        claimLock.taken += 1;
        const record = await this.repository.claimNext({
          workerId: this.options.workerId,
          now: this.clock(),
          claimTimeoutMs: this.options.claimTimeoutMs,
          maxAttempts: this.options.maxAttempts,
        });
        if (!record) {
          remaining = 0;
          return;
        }
        counts.claimed += 1;
        const { outcome, integrity } = await this.processClaimed(record);
        counts[outcome] += 1;
        if (integrity) counts[integrity] += 1;
      }
    };

    const poolSize = Math.max(1, Math.min(this.options.concurrency, batchSize));
    // Wait for EVERY runner, even when one fails, so a pass (and a shutdown drain) never ends
    // while another runner still has a send in flight.
    const settled = await Promise.allSettled(Array.from({ length: poolSize }, () => runner()));
    const rejected = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected) throw rejected.reason;

    return counts;
  }

  public async processOne(record: EmailOutboxDocument): Promise<ProcessOutcome> {
    return (await this.processClaimed(record)).outcome;
  }

  private async processClaimed(
    record: EmailOutboxDocument,
  ): Promise<{ outcome: ProcessOutcome; integrity?: IntegrityEvent }> {
    const logContext = {
      provider: record.provider ?? undefined,
      templateKey: record.templateKey,
      eventKey: record.eventKey,
      recipient: record.recipient,
    };
    // This claim only — a stale result can't overwrite a newer claim of the same row.
    const claim = { claimedBy: record.claimedBy, attemptCount: record.attemptCount };
    const recordedAs = (
      outcome: ProcessOutcome,
      persisted: EmailOutboxDocument | null,
    ): { outcome: ProcessOutcome; integrity?: IntegrityEvent } => {
      if (persisted) return { outcome };
      logEmailOutcomeNotRecorded({ ...logContext, outcome });
      return { outcome, integrity: "ownershipLost" };
    };

    let rendered: RenderedEmail;
    try {
      rendered = this.emailService.render(record.templateKey as EmailTemplateKey, record.payload);
    } catch (error) {
      // A missing renderer or a bad payload is permanent — retrying won't help.
      const category =
        error instanceof EmailTemplateNotRegisteredError
          ? "TEMPLATE_NOT_REGISTERED"
          : "RENDER_ERROR";
      const persisted = await this.repository.markFailed(record._id, {
        category,
        message: safeErrorMessage(error),
        claim,
      });
      logEmailFailed({ ...logContext, errorCategory: "RENDER_ERROR", willRetry: false });
      return recordedAs("failed", persisted);
    }

    let result: Awaited<ReturnType<EmailService["sendRendered"]>>;
    try {
      // Stage C — generate any per-template attachment (the BOOKING_COMPLETED invoice PDF) once,
      // from the SAME payload the template rendered from. A failure here is caught below and
      // handled exactly like a send failure — the committed booking is never affected.
      const extraAttachments = this.attachmentResolver
        ? await this.attachmentResolver.resolve(record.templateKey, record.payload)
        : [];
      const toSend =
        extraAttachments.length > 0
          ? { ...rendered, attachments: [...(rendered.attachments ?? []), ...extraAttachments] }
          : rendered;

      // P4B: recheck current Booking state AFTER rendering/attachments, immediately before
      // provider dispatch. A queued reminder/confirmation is not perpetual send authority.
      if (
        this.deliveryEligibility &&
        !(await this.deliveryEligibility.check(record, this.clock()))
      ) {
        const persisted = await this.repository.markFailed(record._id, {
          category: "BOOKING_DELIVERY_INELIGIBLE",
          message: "Retired without provider dispatch: Booking evidence changed or is unverified",
          claim,
        });
        return recordedAs("failed", persisted);
      }

      result = await this.emailService.sendRendered(record.recipient, toSend, {
        eventKey: record.eventKey,
        templateKey: record.templateKey,
      });
    } catch (error) {
      const retryable = error instanceof EmailError && error.retryable;
      const hasAttemptsLeft = record.attemptCount < this.options.maxAttempts;

      if (retryable && hasAttemptsLeft) {
        const delayMs = this.backoffMs(record.attemptCount);
        const persisted = await this.repository.scheduleRetry(record._id, {
          category: error.category,
          message: safeErrorMessage(error),
          nextAttemptAt: new Date(this.clock().getTime() + delayMs),
          claim,
        });
        logEmailFailed({
          ...logContext,
          errorCategory: error.category,
          ...(error.providerStatus === undefined ? {} : { providerStatus: error.providerStatus }),
          safeMessage: error.safeProviderMessage,
          willRetry: true,
        });
        return recordedAs("retried", persisted);
      }

      const category = error instanceof EmailError ? error.category : "UNKNOWN";
      const persisted = await this.repository.markFailed(record._id, {
        category,
        message: safeErrorMessage(error),
        claim,
      });
      logEmailFailed({
        ...logContext,
        errorCategory: category,
        ...(error instanceof EmailError && error.providerStatus !== undefined
          ? { providerStatus: error.providerStatus }
          : {}),
        safeMessage: error instanceof EmailError ? error.safeProviderMessage : undefined,
        willRetry: false,
      });
      return recordedAs("failed", persisted);
    }

    // The provider accepted the request. From here on a persistence error must NOT be treated
    // as a send failure (that would immediately schedule a resend of an accepted email). The
    // row keeps its claim; if SENT was never written, the stale path may resend it later —
    // at-least-once, documented, not hidden.
    logEmailAccepted({
      ...logContext,
      provider: result.provider,
      ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
    });
    let recorded: EmailOutboxDocument | null;
    try {
      recorded = await this.repository.markSent(record._id, {
        provider: result.provider,
        ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
        now: this.clock(),
      });
    } catch {
      recorded = null;
    }
    if (!recorded) {
      logEmailOutcomeNotRecorded({ ...logContext, provider: result.provider, outcome: "sent" });
      return { outcome: "sent", integrity: "acceptedNotRecorded" };
    }
    return { outcome: "sent" };
  }

  /** `attemptCount` is already incremented on claim, so on the first delivery it is 1. */
  private backoffMs(attemptCount: number): number {
    const exponent = Math.max(0, attemptCount - 1);
    return this.options.retryBaseMs * 2 ** exponent;
  }
}
