import { pathToFileURL } from "node:url";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { DatabaseManager } from "../database/database-manager.js";
import { AppointmentReminderRepository } from "../modules/appointment-reminder/appointment-reminder.repository.js";
import { AppointmentReminderWorker } from "../modules/appointment-reminder/appointment-reminder.worker.js";
import { BookingRepository } from "../modules/booking/booking.repository.js";
import { BusinessRepository } from "../modules/business/business.repository.js";
import { EmailOutboxService } from "../modules/email-outbox/email-outbox.service.js";
import { CustomerNotificationPolicy } from "../modules/notification/customer-notification-policy.js";
import { createSmsTransport } from "../modules/sms/sms-transport.factory.js";
import { SmsOutboxService } from "../modules/sms-outbox/sms-outbox.service.js";
import { UserRepository } from "../modules/user/user.repository.js";
import { withMoneyRecoveryLifecycle as withWorkerLifecycle } from "./money-recovery-runtime.js";

/**
 * The 24h appointment-reminder worker entry point. Same design as run-no-show-worker.ts /
 * run-email-worker.ts — NOT a queue framework: correctness lives in
 * AppointmentReminderRepository's atomic claim + unique dedupe index, never in this loop.
 * Running it once or from many hosts at once is equally safe. It enqueues into the existing
 * EmailOutbox and never touches SendGrid directly.
 *
 * Run once (external scheduler):
 *   node dist/scripts/run-appointment-reminder-worker.js --once
 * Run continuously (polls every APPOINTMENT_REMINDER_WORKER_POLL_INTERVAL_MS):
 *   node dist/scripts/run-appointment-reminder-worker.js
 */
const buildWorker = (): AppointmentReminderWorker =>
  new AppointmentReminderWorker(
    new AppointmentReminderRepository(),
    new BookingRepository(),
    new BusinessRepository(),
    new UserRepository(),
    new CustomerNotificationPolicy(),
    new EmailOutboxService(),
    new SmsOutboxService(),
    createSmsTransport(),
    {
      workerId: `appointment-reminder-${process.pid}`,
      batchSize: env.APPOINTMENT_REMINDER_WORKER_BATCH_SIZE,
      concurrency: env.APPOINTMENT_REMINDER_WORKER_CONCURRENCY,
      maxAttempts: env.APPOINTMENT_REMINDER_WORKER_MAX_ATTEMPTS,
      claimTimeoutMs: env.APPOINTMENT_REMINDER_WORKER_CLAIM_TIMEOUT_MS,
    },
  );

const runOnce = async (
  worker: AppointmentReminderWorker,
  shouldStop: () => boolean = () => false,
): Promise<void> => {
  const counts = await worker.runOnce(shouldStop);
  logger.info({ counts }, "Appointment reminder worker pass complete");
};

const runCli = async (): Promise<void> => {
  const databaseManager = new DatabaseManager();
  const worker = buildWorker();
  const runForever = !process.argv.includes("--once");

  await withWorkerLifecycle({
    signals: process,
    connect: () => databaseManager.connect(),
    disconnect: () => databaseManager.disconnect(),
    onStopping: () =>
      logger.info("Reminder worker stopping: no new claims; draining in-flight work"),
    execute: async (shouldStop, wait) => {
      do {
        if (shouldStop()) break;
        try {
          await runOnce(worker, shouldStop);
        } catch {
          logger.error(
            { event: "REMINDER_WORKER_PASS_FAILED" },
            "Appointment reminder worker pass failed",
          );
          if (!runForever) throw new Error("Appointment reminder worker pass failed");
        }
        if (!runForever || shouldStop()) break;
        await wait(env.APPOINTMENT_REMINDER_WORKER_POLL_INTERVAL_MS);
      } while (!shouldStop());
    },
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runCli();
  } catch {
    logger.error(
      { event: "REMINDER_WORKER_FAILED" },
      "Appointment reminder worker stopped with failure",
    );
    process.exitCode = 1;
  }
}

export { buildWorker, runOnce };
