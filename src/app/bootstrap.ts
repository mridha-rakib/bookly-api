import type { Server } from "node:http";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { DatabaseManager } from "../database/database-manager.js";
import { bootstrapStorage } from "../modules/storage/storage.bootstrap.js";
import { ExpressApplication } from "./app.js";

export class ApplicationBootstrap {
  private server?: Server;
  private isShuttingDown = false;

  public constructor(private readonly databaseManager = new DatabaseManager()) {}

  public async start(): Promise<void> {
    try {
      await this.databaseManager.connect();
      await bootstrapStorage();

      const expressApplication = new ExpressApplication(this.databaseManager);
      this.server = expressApplication.app.listen(env.PORT, () => {
        logger.info(
          {
            port: env.PORT,
            environment: env.NODE_ENV,
          },
          "Bookly API server started",
        );
      });

      this.registerProcessHandlers();
    } catch (error) {
      logger.fatal({ err: error }, "Bookly API startup failed");
      this.flushLogger();
      process.exit(1);
    }
  }

  private registerProcessHandlers(): void {
    process.once("SIGINT", () => {
      void this.shutdown("SIGINT", 0);
    });

    process.once("SIGTERM", () => {
      void this.shutdown("SIGTERM", 0);
    });

    process.once("unhandledRejection", (reason) => {
      logger.fatal({ err: reason }, "Unhandled promise rejection");
      void this.shutdown("unhandledRejection", 1);
    });

    process.once("uncaughtException", (error) => {
      logger.fatal({ err: error }, "Uncaught exception");
      void this.shutdown("uncaughtException", 1);
    });
  }

  private async shutdown(reason: string, exitCode: number): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn({ reason }, "Shutdown already in progress");
      return;
    }

    this.isShuttingDown = true;
    logger.info({ reason }, "Starting graceful shutdown");

    const timeout = setTimeout(() => {
      logger.error({ reason }, "Graceful shutdown timed out");
      this.flushLogger();
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    timeout.unref();

    try {
      await this.closeServer();
      await this.databaseManager.disconnect();
      logger.info("Graceful shutdown completed");
      clearTimeout(timeout);
      this.flushLogger();
      process.exit(exitCode);
    } catch (error) {
      logger.error({ err: error }, "Graceful shutdown failed");
      clearTimeout(timeout);
      this.flushLogger();
      process.exit(1);
    }
  }

  private closeServer(): Promise<void> {
    if (!this.server) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private flushLogger(): void {
    if (typeof logger.flush === "function") {
      logger.flush();
    }
  }
}
