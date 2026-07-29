import { z } from "zod";

export const databaseConnectionStateSchema = z.enum([
  "disconnected",
  "connected",
  "connecting",
  "disconnecting",
  "unknown",
]);

export const healthBaseSchema = z.object({
  application: z.string(),
  environment: z.string(),
  version: z.string(),
  status: z.enum(["ok", "ready", "not_ready"]),
  uptime: z.number(),
  timestamp: z.string().datetime(),
});

export const livenessHealthSchema = healthBaseSchema;

export const readinessHealthSchema = healthBaseSchema.extend({
  database: z.object({
    state: databaseConnectionStateSchema,
  }),
});
