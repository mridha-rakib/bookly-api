import { EmailError } from "../email/email.errors.js";
import { logEmailAccepted, logEmailFailed } from "../email/email.logging.js";
import type { EmailService } from "../email/email.service.js";
import type { RenderedEmail } from "../email/email.types.js";
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
  sent: number;
  retried: number;
  failed: number;
  recoveredStale: number;
};

type ProcessOutcome = "sent" | "retried" | "failed";

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
  ) {}

  public async runOnce(batchSize: number): Promise<EmailWorkerPassCounts> {
    const counts: EmailWorkerPassCounts = {
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
      recoveredStale: 0,
    };

    counts.recoveredStale = await this.repository.resetStaleProcessing(
      new Date(this.clock().getTime() - this.options.claimTimeoutMs),
    );

    let remaining = batchSize;
    const claimLock = { taken: 0 };

    const runner = async (): Promise<void> => {
      while (claimLock.taken < remaining) {
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
        const outcome = await this.processOne(record);
        counts[outcome] += 1;
      }
    };

    const poolSize = Math.max(1, Math.min(this.options.concurrency, batchSize));
    await Promise.all(Array.from({ length: poolSize }, () => runner()));

    return counts;
  }

  public async processOne(record: EmailOutboxDocument): Promise<ProcessOutcome> {
    const logContext = {
      provider: record.provider ?? undefined,
      templateKey: record.templateKey,
      eventKey: record.eventKey,
      recipient: record.recipient,
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
      await this.repository.markFailed(record._id, { category, message: safeErrorMessage(error) });
      logEmailFailed({ ...logContext, errorCategory: "RENDER_ERROR", willRetry: false });
      return "failed";
    }

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

      const result = await this.emailService.sendRendered(record.recipient, toSend, {
        eventKey: record.eventKey,
        templateKey: record.templateKey,
      });
      await this.repository.markSent(record._id, {
        provider: result.provider,
        ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
        now: this.clock(),
      });
      logEmailAccepted({
        ...logContext,
        provider: result.provider,
        ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
      });
      return "sent";
    } catch (error) {
      const retryable = error instanceof EmailError && error.retryable;
      const hasAttemptsLeft = record.attemptCount < this.options.maxAttempts;

      if (retryable && hasAttemptsLeft) {
        const delayMs = this.backoffMs(record.attemptCount);
        await this.repository.scheduleRetry(record._id, {
          category: error.category,
          message: safeErrorMessage(error),
          nextAttemptAt: new Date(this.clock().getTime() + delayMs),
        });
        logEmailFailed({
          ...logContext,
          errorCategory: error.category,
          ...(error.providerStatus === undefined ? {} : { providerStatus: error.providerStatus }),
          safeMessage: error.safeProviderMessage,
          willRetry: true,
        });
        return "retried";
      }

      const category = error instanceof EmailError ? error.category : "UNKNOWN";
      await this.repository.markFailed(record._id, {
        category,
        message: safeErrorMessage(error),
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
      return "failed";
    }
  }

  /** `attemptCount` is already incremented on claim, so on the first delivery it is 1. */
  private backoffMs(attemptCount: number): number {
    const exponent = Math.max(0, attemptCount - 1);
    return this.options.retryBaseMs * 2 ** exponent;
  }
}
