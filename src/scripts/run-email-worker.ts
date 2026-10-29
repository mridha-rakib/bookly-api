import { pathToFileURL } from "node:url";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { DatabaseManager } from "../database/database-manager.js";
import { BookingEmailDeliveryEligibility } from "../modules/booking/booking-email-delivery-eligibility.js";
import { EmailService } from "../modules/email/email.service.js";
import { EmailOutboxRepository } from "../modules/email-outbox/email-outbox.repository.js";
import {
  EmailOutboxWorker,
  type EmailWorkerOptions,
  type EmailWorkerPassCounts,
} from "../modules/email-outbox/email-outbox-worker.js";
import { InvoiceAttachmentResolver } from "../modules/invoice/invoice-attachment.resolver.js";

import { assertEmailWorkerLaunch, EmailWorkerLaunchError } from "./email-worker-runtime.js";
import { withMoneyRecoveryLifecycle as withWorkerLifecycle } from "./money-recovery-runtime.js";

/**
 * Runnable entry point for the transactional-email outbox worker (Phase S). Not a queue
 * framework: the atomic claim + unique dedupe index in EmailOutboxRepository are the
 * correctness guarantee, so concurrent consumers cannot claim the same row. Delivery is
 * AT-LEAST-ONCE, not exactly-once — see docs/EMAIL-WORKER.md.
 *
 * Disabled unless BOOKLY_EMAIL_WORKER_ENABLED=true and an explicit EMAIL_PROVIDER is configured.
 *
 *   node dist/scripts/run-email-worker.js --once   # single pass (external scheduler)
 *   node dist/scripts/run-email-worker.js          # serial passes, EMAIL_WORKER_POLL_INTERVAL_MS apart
 */
const buildWorker = (): EmailOutboxWorker => {
  const options: EmailWorkerOptions = {
    workerId: `${process.pid}@${process.env["HOSTNAME"] ?? "local"}`,
    maxAttempts: env.EMAIL_WORKER_MAX_ATTEMPTS,
    claimTimeoutMs: env.EMAIL_OUTBOX_CLAIM_TIMEOUT_MS,
    retryBaseMs: env.EMAIL_WORKER_RETRY_BASE_MS,
    concurrency: env.EMAIL_WORKER_CONCURRENCY,
  };
  return new EmailOutboxWorker(
    new EmailOutboxRepository(),
    new EmailService(),
    options,
    () => new Date(),
    new InvoiceAttachmentResolver(),
    new BookingEmailDeliveryEligibility(),
  );
};

const runOnce = async (
  worker: EmailOutboxWorker,
  shouldStop: () => boolean = () => false,
): Promise<EmailWorkerPassCounts> => {
  const counts = await worker.runOnce(env.EMAIL_WORKER_BATCH_SIZE, shouldStop);
  // "sent" = provider accepted. Bookly has no delivery receipt; never report it as delivered.
  if (counts.failed > 0 || counts.acceptedNotRecorded > 0 || counts.ownershipLost > 0) {
    logger.warn({ counts }, "Email worker pass completed with failures or unrecorded outcomes");
  } else {
    logger.info({ counts }, "Email worker pass complete");
  }
  return counts;
};

/** One pass at a time: the next pass starts only after the previous one fully settles. */
const runContinuous = async (
  worker: EmailOutboxWorker,
  intervalMs: number,
  shouldStop: () => boolean,
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> => {
  while (!shouldStop()) {
    try {
      await runOnce(worker, shouldStop);
    } catch {
      // Raw errors may carry connection details; the pass is retried on the next interval.
      logger.error({ event: "EMAIL_WORKER_PASS_FAILED" }, "Email worker pass failed");
    }
    if (!shouldStop()) await wait(intervalMs);
  }
};

const runCli = async (): Promise<void> => {
  // env.ts still validates the shared configuration on import; this adds explicit intent.
  assertEmailWorkerLaunch(process.env, process.argv.slice(2));
  const databaseManager = new DatabaseManager();
  const runForever = !process.argv.includes("--once");
  await withWorkerLifecycle({
    signals: process,
    connect: () => databaseManager.connect(),
    disconnect: () => databaseManager.disconnect(),
    onStopping: () =>
      logger.info("Email worker stopping: no new claims; finishing in-flight sends"),
    execute: async (shouldStop, wait) => {
      const worker = buildWorker();
      logger.info(
        {
          mode: runForever ? "continuous" : "once",
          intervalMs: env.EMAIL_WORKER_POLL_INTERVAL_MS,
          provider: env.EMAIL_PROVIDER,
        },
        "Email worker started",
      );
      if (runForever) {
        await runContinuous(worker, env.EMAIL_WORKER_POLL_INTERVAL_MS, shouldStop, wait);
      } else if (!shouldStop()) {
        await runOnce(worker, shouldStop);
      }
    },
  });
  logger.info("Email worker stopped");
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runCli();
  } catch (error) {
    // Never serialize raw provider/connection exceptions or environment values here.
    logger.error(
      {
        event: "EMAIL_WORKER_EXIT",
        reason:
          error instanceof EmailWorkerLaunchError ? error.message : "STARTUP_OR_EXECUTION_FAILURE",
      },
      "Email worker could not continue",
    );
    process.exitCode = 1;
  }
}

export { buildWorker, runContinuous, runOnce };
