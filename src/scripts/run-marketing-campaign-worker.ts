import { pathToFileURL } from "node:url";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { DatabaseManager } from "../database/database-manager.js";
import { BlogPostRepository } from "../modules/content/blog.repository.js";
import { createEmailTransport } from "../modules/email/email-transport.factory.js";
import { MarketingAudienceService } from "../modules/marketing/marketing-audience.service.js";
import { MarketingCampaignRepository } from "../modules/marketing/marketing-campaign.repository.js";
import {
  MarketingCampaignWorker,
  type MarketingWorkerOptions,
} from "../modules/marketing/marketing-campaign.worker.js";
import { MarketingCampaignRecipientRepository } from "../modules/marketing/marketing-campaign-recipient.repository.js";
import { MarketingCampaignSourceService } from "../modules/marketing/marketing-campaign-source.service.js";
import { PromoRepository } from "../modules/promo/promo.repository.js";
import { UserRepository } from "../modules/user/user.repository.js";

/**
 * Runnable entry point for the Marketing Email campaign delivery worker (Stage M3B) — same
 * shape as scripts/run-email-worker.ts. Not a queue framework: the atomic recipient claim +
 * per-claim token fence + the `{campaignId,userId}` unique index are the correctness guarantee,
 * so running this from one host or several, once or continuously, is all safe. Deploy with a
 * clean stop/start (not rolling).
 *
 *   node dist/scripts/run-marketing-campaign-worker.js --once
 *   node dist/scripts/run-marketing-campaign-worker.js          # poll every MARKETING_WORKER_POLL_INTERVAL_MS
 */
const buildWorker = (): MarketingCampaignWorker => {
  const options: MarketingWorkerOptions = {
    workerId: `${process.pid}@${process.env["HOSTNAME"] ?? "local"}`,
    batchSize: env.MARKETING_WORKER_BATCH_SIZE,
    concurrency: env.MARKETING_WORKER_CONCURRENCY,
    maxAttempts: env.MARKETING_WORKER_MAX_ATTEMPTS,
    retryBaseMs: env.MARKETING_WORKER_RETRY_BASE_MS,
    claimTimeoutMs: env.MARKETING_WORKER_CLAIM_TIMEOUT_MS,
    promoteBatchSize: env.MARKETING_WORKER_PROMOTE_BATCH_SIZE,
  };
  const userRepository = new UserRepository();
  const recipientRepository = new MarketingCampaignRecipientRepository();
  return new MarketingCampaignWorker(
    new MarketingCampaignRepository(),
    recipientRepository,
    new MarketingAudienceService(userRepository, recipientRepository),
    new MarketingCampaignSourceService(new BlogPostRepository(), new PromoRepository()),
    userRepository,
    createEmailTransport(),
    options,
  );
};

const runOnce = async (worker: MarketingCampaignWorker): Promise<void> => {
  const counts = await worker.runOnce();
  logger.info({ counts }, "Marketing campaign worker pass complete");
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
      { intervalMs: env.MARKETING_WORKER_POLL_INTERVAL_MS },
      "Marketing campaign worker starting continuous polling",
    );

    let stopping = false;
    const shutdown = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      clearInterval(interval);
      await databaseManager.disconnect();
      logger.info("Marketing campaign worker stopped");
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());

    const interval = setInterval(() => {
      runOnce(worker).catch((error: unknown) => {
        logger.error({ err: error }, "Marketing campaign worker pass failed");
      });
    }, env.MARKETING_WORKER_POLL_INTERVAL_MS);

    await runOnce(worker);
    return;
  } catch (error) {
    logger.error({ err: error }, "Marketing campaign worker failed to start");
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
