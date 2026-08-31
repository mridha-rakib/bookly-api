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

const runOnce = async (worker: AppointmentReminderWorker): Promise<void> => {
  const counts = await worker.runOnce();
  logger.info({ counts }, "Appointment reminder worker pass complete");
};

const runCli = async (): Promise<void> => {
  const databaseManager = new DatabaseManager();
  const worker = buildWorker();
  const runForever = !process.argv.includes("--once");

  try {
    await databaseManager.connect();

    if (!runForever) {
      await runOnce(worker);
      return;
    }

    logger.info(
      { intervalMs: env.APPOINTMENT_REMINDER_WORKER_POLL_INTERVAL_MS },
      "Appointment reminder worker starting continuous polling",
    );

    let stopping = false;
    const shutdown = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      clearInterval(interval);
      await databaseManager.disconnect();
      logger.info("Appointment reminder worker stopped");
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());

    const interval = setInterval(() => {
      runOnce(worker).catch((error: unknown) => {
        logger.error({ err: error }, "Appointment reminder worker pass failed");
      });
    }, env.APPOINTMENT_REMINDER_WORKER_POLL_INTERVAL_MS);

    await runOnce(worker);
    return;
  } catch (error) {
    logger.error({ err: error }, "Appointment reminder worker failed to start");
    throw error;
  } finally {
    if (!runForever) {
      await databaseManager.disconnect();
    }
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}

export { buildWorker, runOnce };
