import { SmsError } from "../sms/sms.errors.js";
import { logSmsAccepted, logSmsFailed } from "../sms/sms.logging.js";
import type { SmsTransport } from "../sms/sms-transport.js";
import type { SmsOutboxDocument } from "./sms-outbox.model.js";
import type { SmsOutboxRepository } from "./sms-outbox.repository.js";

export type SmsWorkerOptions = {
  workerId: string;
  maxAttempts: number;
  claimTimeoutMs: number;
  /** First retry waits this long; each subsequent retry doubles it. */
  retryBaseMs: number;
  /** Upper bound on rows processed concurrently within a single pass. */
  concurrency: number;
};

export type SmsWorkerPassCounts = {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  recoveredStale: number;
};

type ProcessOutcome = "sent" | "retried" | "failed";

const safeErrorMessage = (error: unknown): string => {
  if (error instanceof SmsError) {
    return error.safeProviderMessage ?? error.category;
  }
  if (error instanceof Error) {
    return error.name;
  }
  return "unknown error";
};

/**
 * Drains the {@link SmsOutboxRepository}. Same philosophy as EmailOutboxWorker / the no-show
 * worker — correctness lives in the repository's atomic claim + unique index, not in this loop.
 * This class only decides send / retry / fail, bounds concurrency, and hands the frozen `body`
 * to the {@link SmsTransport}. It performs NO Booking/User/preference reads.
 */
export class SmsOutboxWorker {
  public constructor(
    private readonly repository: SmsOutboxRepository,
    private readonly transport: SmsTransport,
    private readonly options: SmsWorkerOptions,
    private readonly clock: () => Date = () => new Date(),
    private readonly deliveryEligibility?: {
      check(record: SmsOutboxDocument, now: Date): Promise<boolean>;
    },
  ) {}

  public async runOnce(
    batchSize: number,
    shouldStop: () => boolean = () => false,
  ): Promise<SmsWorkerPassCounts> {
    const counts: SmsWorkerPassCounts = {
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
        counts[await this.processOne(record)] += 1;
      }
    };

    const poolSize = Math.max(1, Math.min(this.options.concurrency, batchSize));
    const settled = await Promise.allSettled(Array.from({ length: poolSize }, () => runner()));
    const rejected = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected) throw rejected.reason;

    return counts;
  }

  public async processOne(record: SmsOutboxDocument): Promise<ProcessOutcome> {
    const logContext = {
      provider: this.transport.provider,
      eventKey: record.eventKey,
      recipientE164: record.recipientE164,
    };

    try {
      if (
        this.deliveryEligibility &&
        !(await this.deliveryEligibility.check(record, this.clock()))
      ) {
        await this.repository.markFailed(record, {
          category: "BOOKING_DELIVERY_INELIGIBLE",
          message: "Retired without provider dispatch: Booking is ineligible",
        });
        return "failed";
      }
      const issued = await this.repository.markProviderStarted(record);
      if (!issued) throw new Error("SMS claim lost before provider permission");
      let result: Awaited<ReturnType<SmsTransport["send"]>>;
      try {
        result = await this.transport.send({
          to: record.recipientE164,
          body: record.body,
          ...(record.metadata ? { metadata: record.metadata } : {}),
        });
      } catch (error) {
        await this.repository.markUnknown(
          record,
          error instanceof SmsError ? error.category : "UNKNOWN",
        );
        logSmsFailed({
          ...logContext,
          errorCategory: error instanceof SmsError ? error.category : "UNKNOWN",
          safeMessage: "Provider outcome requires reconciliation",
          willRetry: false,
        });
        return "failed";
      }
      const stored = await this.repository.markSent(record, {
        provider: result.provider,
        ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
        now: this.clock(),
      });
      if (!stored) throw new Error("SMS result persistence not confirmed");
      logSmsAccepted({
        ...logContext,
        provider: result.provider,
        ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
      });
      return "sent";
    } catch (error) {
      // A failed acknowledgement write is not evidence that the provider did not accept.
      // The durable providerStarted barrier prevents an automatic resend after any such error.
      const existing = await this.repository.markUnknown(
        record,
        error instanceof SmsError ? error.category : "UNKNOWN",
      );
      if (existing) return "failed";
      const retryable = error instanceof SmsError && error.retryable;
      const hasAttemptsLeft = record.attemptCount < this.options.maxAttempts;
      if (retryable && hasAttemptsLeft) {
        await this.repository.scheduleRetry(record, {
          category: error.category,
          message: safeErrorMessage(error),
          nextAttemptAt: new Date(this.clock().getTime() + this.backoffMs(record.attemptCount)),
        });
        return "retried";
      }
      await this.repository.markFailed(record, {
        category: error instanceof SmsError ? error.category : "UNKNOWN",
        message: safeErrorMessage(error),
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
