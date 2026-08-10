import { pathToFileURL } from "node:url";

import mongoose from "mongoose";

import { logger } from "../config/logger.js";
import { DatabaseManager } from "../database/database-manager.js";
import "../modules/business/business-access.model.js";
import "../modules/business/business-link-verification.model.js";
import "../modules/business/business.model.js";
import "../modules/business-onboarding/business-onboarding.model.js";
import "../modules/registration-session/registration-session.model.js";
import "../modules/session/session.model.js";
import "../modules/user/user.model.js";

type SyncIndexesLogger = Pick<typeof logger, "info" | "error">;

export type SyncIndexesResult = {
  modelName: string;
  createdOrDropped: string[];
};

/**
 * Deterministic, production-safe index provisioning.
 *
 * `autoIndex` is disabled in production (see DatabaseManager.connect), so index
 * creation/removal must be applied out-of-band via this script rather than
 * implicitly on server boot. Run it as an explicit deploy step, after reviewing
 * for duplicate-key conflicts on any newly-unique index (e.g. Business.ownerUserId,
 * BusinessAccess.{userId,businessId}) against the target database.
 */
export const syncDatabaseIndexes = async (
  dependencies: { logger: SyncIndexesLogger } = { logger },
): Promise<SyncIndexesResult[]> => {
  const results: SyncIndexesResult[] = [];

  for (const modelName of mongoose.modelNames()) {
    const model = mongoose.model(modelName);
    const changes = await model.syncIndexes();
    results.push({ modelName, createdOrDropped: changes });
    dependencies.logger.info({ modelName, changes }, "Synced indexes for model");
  }

  return results;
};

const runCli = async (): Promise<void> => {
  const databaseManager = new DatabaseManager();

  try {
    await databaseManager.connect();
    await syncDatabaseIndexes({ logger });
    logger.info("Index sync completed");
  } catch (error) {
    logger.error({ err: error }, "Index sync failed");
    throw error;
  } finally {
    await databaseManager.disconnect();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
