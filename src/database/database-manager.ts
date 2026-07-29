import mongoose from "mongoose";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

export type DatabaseConnectionState =
  | "disconnected"
  | "connected"
  | "connecting"
  | "disconnecting"
  | "unknown";

export interface DatabaseStateReader {
  getConnectionState(): DatabaseConnectionState;
}

const connectionStateByReadyState: Record<number, DatabaseConnectionState> = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting",
};

export class DatabaseManager implements DatabaseStateReader {
  private connectPromise: Promise<typeof mongoose> | undefined;

  public getConnectionState(): DatabaseConnectionState {
    return connectionStateByReadyState[mongoose.connection.readyState] ?? "unknown";
  }

  public async connect(): Promise<void> {
    if (this.getConnectionState() === "connected") {
      logger.debug("MongoDB connection already established");
      return;
    }

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    logger.info("Connecting to MongoDB");

    this.connectPromise = mongoose
      .connect(env.MONGODB_URI, {
        autoIndex: env.NODE_ENV !== "production",
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 10_000,
      })
      .then((connection) => {
        logger.info({ databaseState: this.getConnectionState() }, "MongoDB connected");
        return connection;
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, "MongoDB initial connection failed");
        throw error;
      })
      .finally(() => {
        this.connectPromise = undefined;
      });

    await this.connectPromise;
  }

  public async disconnect(): Promise<void> {
    const state = this.getConnectionState();

    if (state === "disconnected") {
      logger.debug("MongoDB connection already disconnected");
      return;
    }

    if (state === "disconnecting") {
      logger.debug("MongoDB connection is already disconnecting");
      return;
    }

    logger.info("Disconnecting from MongoDB");
    await mongoose.disconnect();
    logger.info({ databaseState: this.getConnectionState() }, "MongoDB disconnected");
  }
}
