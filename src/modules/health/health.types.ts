import type { DatabaseConnectionState } from "../../database/database-manager.js";

export type HealthStatus = "ok" | "ready" | "not_ready";

export type HealthBase = {
  application: string;
  environment: string;
  version: string;
  status: HealthStatus;
  uptime: number;
  timestamp: string;
};

export type LivenessHealth = HealthBase;

export type ReadinessHealth = HealthBase & {
  database: {
    state: DatabaseConnectionState;
  };
};
