import { pathToFileURL } from "node:url";
import { logger } from "../config/logger.js";
import { DatabaseManager } from "../database/database-manager.js";
import { createCentralPayoutService } from "../modules/central-payout/central-payout.route.js";
import { UserRepository } from "../modules/user/user.repository.js";
import { withMoneyRecoveryLifecycle } from "./money-recovery-runtime.js";
import {
  assertPayoutEvidenceLaunch,
  PayoutEvidenceLaunchError,
  runPayoutEvidencePass,
} from "./payout-evidence-runtime.js";

/**
 * FG03B-3 — OPTIONAL Stripe payout-evidence refresh worker (`pnpm worker:payout-evidence`).
 * Disabled unless BOOKLY_PAYOUT_EVIDENCE_WORKER_ENABLED=true AND the approved
 * CENTRAL_PAYOUT_HISTORY_SYNC_ENABLED=true; not wired into any process manager. It re-reads the
 * full Stripe payout list in bounded, leased, resumable passes (the same path as the Super Admin
 * action), so it is safe alongside an operator read. Evidence refresh only: no payout creation,
 * no ledger writes, no withdrawal authority.
 */
const runCli = async (): Promise<void> => {
  const { intervalMs } = assertPayoutEvidenceLaunch(process.env, process.argv.slice(2));
  const databaseManager = new DatabaseManager();
  const runForever = !process.argv.includes("--once");
  await withMoneyRecoveryLifecycle({
    signals: process,
    connect: () => databaseManager.connect(),
    disconnect: () => databaseManager.disconnect(),
    onStopping: () => logger.info("Payout evidence worker stopping after the active pass"),
    execute: async (shouldStop, wait) => {
      const service = createCentralPayoutService(new UserRepository());
      const pass = async () => {
        const summary = await runPayoutEvidencePass(() =>
          service.syncProviderHistory("worker", { maxPages: 10, trigger: "WORKER" }),
        );
        const log = summary.result === "COMPLETED" ? logger.info : logger.warn;
        log.call(
          logger,
          { event: "CENTRAL_PAYOUT_EVIDENCE_PASS", ...summary },
          "Payout evidence pass",
        );
      };
      logger.info(
        { mode: runForever ? "continuous" : "once", intervalMs },
        "Payout evidence worker started",
      );
      do {
        await pass();
        if (runForever && !shouldStop()) await wait(intervalMs);
      } while (runForever && !shouldStop());
    },
  });
  logger.info("Payout evidence worker stopped");
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runCli();
  } catch (error) {
    // Never serialize raw provider/connection exceptions or environment values here.
    logger.error(
      {
        event: "CENTRAL_PAYOUT_EVIDENCE_WORKER_EXIT",
        reason:
          error instanceof PayoutEvidenceLaunchError
            ? error.message
            : "STARTUP_OR_EXECUTION_FAILURE",
      },
      "Payout evidence worker could not continue",
    );
    process.exitCode = 1;
  }
}
