import { pathToFileURL } from "node:url";
import mongoose from "mongoose";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { DatabaseManager } from "../database/database-manager.js";
import {
  assertOrdinaryCalendarJournalProvisioned,
  evaluateOrdinaryCalendarActivationReadiness,
  type OrdinaryCalendarIndexDescription,
  ordinaryCalendarWorkerStop,
} from "../modules/booking/ordinary-calendar-activation.js";
import { OrdinaryCalendarJournalModel } from "../modules/booking/ordinary-calendar-journal.model.js";
import {
  ordinaryCalendarAuthoritativeModeAvailable,
  verifyOrdinaryCalendarDeliveryAuthority,
} from "../modules/booking/ordinary-calendar-journal-authority.js";
import { buildOrdinaryCalendarWorker } from "../modules/booking/ordinary-calendar-worker.js";
import { withMoneyRecoveryLifecycle as withWorkerLifecycle } from "./money-recovery-runtime.js";

/**
 * P4B-2B/2C, P2.2.9.1 — ordinary Booking Calendar worker entry point.
 *
 *   node dist/scripts/run-ordinary-calendar-worker.js --check   read-only activation report
 *   node dist/scripts/run-ordinary-calendar-worker.js --once    one bounded pass, then exit
 *   node dist/scripts/run-ordinary-calendar-worker.js           poll every 30 s until stopped
 *
 * Delivery modes refuse to start while the default-denied delivery authority throws (before
 * connecting), and refuse to deliver unless both journal indexes exist with their exact options.
 * `--check` never delivers, never writes and never calls Google: it only reads authority state,
 * index metadata, the server `hello` and whether configuration is present (no values printed).
 * Opt-in process file: `ecosystem.ordinary-calendar.config.cjs` (not loaded by the API's own).
 * Several instances are safe (lease + durable issue + one-time send permission), but one is
 * enough; `--once` suits a host scheduler that the deployment already has.
 */
const POLL_INTERVAL_MS = 30_000;
const BATCH_SIZE = 25;

const listJournalIndexes = () =>
  OrdinaryCalendarJournalModel.collection.listIndexes({ maxTimeMS: 3_000 }).toArray() as Promise<
    OrdinaryCalendarIndexDescription[]
  >;

const runCheck = async (): Promise<boolean> => {
  const databaseManager = new DatabaseManager();
  await databaseManager.connect();
  try {
    const report = await evaluateOrdinaryCalendarActivationReadiness({
      deliveryAuthority: verifyOrdinaryCalendarDeliveryAuthority,
      creationAuthority: ordinaryCalendarAuthoritativeModeAvailable,
      listIndexes: listJournalIndexes,
      hello: async () => {
        const db = mongoose.connection.db;
        if (!db) throw new Error("NOT_CONNECTED");
        return db.command({ hello: 1, maxTimeMS: 3_000 });
      },
      googleOAuthConfigured: () =>
        Boolean(
          env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CALENDAR_REDIRECT_URI,
        ),
      tokenEncryptionKeyConfigured: () => Boolean(env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY),
    });
    logger.info(
      { event: "ORDINARY_CALENDAR_ACTIVATION_READINESS", report },
      "Ordinary Calendar activation readiness (read-only)",
    );
    return report.infrastructureReady;
  } finally {
    await databaseManager.disconnect();
  }
};

const runCli = async (): Promise<void> => {
  if (process.argv.includes("--check")) {
    if (!(await runCheck())) process.exitCode = 1;
    return;
  }
  await verifyOrdinaryCalendarDeliveryAuthority();
  const databaseManager = new DatabaseManager();
  const worker = await buildOrdinaryCalendarWorker({ batchSize: BATCH_SIZE });
  const runForever = !process.argv.includes("--once");

  await withWorkerLifecycle({
    signals: process,
    connect: async () => {
      await databaseManager.connect();
      // Fail closed: never deliver against an unprovisioned or mis-indexed journal.
      await assertOrdinaryCalendarJournalProvisioned(listJournalIndexes);
    },
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
  } catch (error) {
    const stop = ordinaryCalendarWorkerStop(error);
    if (stop.refused)
      // A deliberate gate decision, not a crash: exit 78 so the process manager does not restart.
      logger.warn(
        { event: "ORDINARY_CALENDAR_WORKER_REFUSED", reason: stop.reason },
        "Ordinary Calendar worker refused to start; reliable delivery prerequisites are not met",
      );
    else
      logger.error(
        { event: "ORDINARY_CALENDAR_WORKER_FAILED" },
        "Ordinary Calendar worker stopped with failure",
      );
    process.exitCode = stop.exitCode;
  }
}
