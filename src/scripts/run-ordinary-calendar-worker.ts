import { pathToFileURL } from "node:url";

import { logger } from "../config/logger.js";
import { DatabaseManager } from "../database/database-manager.js";
import { verifyOrdinaryCalendarDeliveryAuthority } from "../modules/booking/ordinary-calendar-journal-authority.js";
import { buildOrdinaryCalendarWorker } from "../modules/booking/ordinary-calendar-worker.js";
import { withMoneyRecoveryLifecycle as withWorkerLifecycle } from "./money-recovery-runtime.js";

/**
 * P4B-2B/2C — ordinary Booking Calendar worker entry point. NOT registered in any process
 * manager, ecosystem file, package script or schedule (registration is an activation step).
 * It refuses to start while the default-denied delivery authority throws, before connecting
 * to the database. Same lifecycle as the other workers: stop stops new
 * claims and drains the in-flight delivery.
 *
 *   node dist/scripts/run-ordinary-calendar-worker.js --once
 *   node dist/scripts/run-ordinary-calendar-worker.js
 */
const POLL_INTERVAL_MS = 30_000;
const BATCH_SIZE = 25;

const runCli = async (): Promise<void> => {
  await verifyOrdinaryCalendarDeliveryAuthority();
  const databaseManager = new DatabaseManager();
  const worker = await buildOrdinaryCalendarWorker({ batchSize: BATCH_SIZE });
  const runForever = !process.argv.includes("--once");

  await withWorkerLifecycle({
    signals: process,
    connect: () => databaseManager.connect(),
    disconnect: () => databaseManager.disconnect(),
    onStopping: () =>
      logger.info("Ordinary Calendar worker stopping: no new claims; draining in-flight work"),
    execute: async (shouldStop, wait) => {
      do {
        if (shouldStop()) break;
        try {
          const counts = await worker.runOnce(shouldStop);
          logger.info({ counts }, "Ordinary Calendar worker pass complete");
        } catch {
          logger.error(
            { event: "ORDINARY_CALENDAR_WORKER_PASS_FAILED" },
            "Ordinary Calendar worker pass failed",
          );
          if (!runForever) throw new Error("Ordinary Calendar worker pass failed");
        }
        if (!runForever || shouldStop()) break;
        await wait(POLL_INTERVAL_MS);
      } while (!shouldStop());
    },
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runCli();
  } catch {
    logger.error(
      { event: "ORDINARY_CALENDAR_WORKER_FAILED" },
      "Ordinary Calendar worker stopped with failure",
    );
    process.exitCode = 1;
  }
}
