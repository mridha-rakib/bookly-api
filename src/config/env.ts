import "dotenv/config";

import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const nodeEnvSchema = z.enum(["development", "test", "production"]).default("development");
const rawNodeEnv = nodeEnvSchema.parse(process.env["NODE_ENV"] ?? "development");

const booleanString = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((value) => value === "true" || value === "1");

const docsEnabledSchema = z
  .enum(["true", "false", "1", "0"])
  .default(rawNodeEnv === "production" ? "false" : "true")
  .transform((value) => value === "true" || value === "1");

const corsOriginsSchema = z
  .string()
  .default("http://localhost:3000")
  .transform((value) =>
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .superRefine((origins, context) => {
    if (origins.length === 0) {
      context.addIssue({
        code: "custom",
        message: "At least one CORS origin must be configured",
      });
    }

    if (rawNodeEnv === "production" && origins.includes("*")) {
      context.addIssue({
        code: "custom",
        message: "Wildcard CORS origins are not allowed in production",
      });
    }
  });

const mongodbUriSchema = z.preprocess(
  (value) => {
    if (rawNodeEnv === "test" && (value === undefined || value === "")) {
      return "mongodb://127.0.0.1:27017/bookly-test";
    }

    return value;
  },
  z
    .string()
    .min(1, "MONGODB_URI is required")
    .regex(/^mongodb(\+srv)?:\/\//, "MONGODB_URI must start with mongodb:// or mongodb+srv://"),
);

export const env = createEnv({
  server: {
    NODE_ENV: nodeEnvSchema,
    PORT: z.coerce.number().int().positive().max(65535).default(3000),
    APP_NAME: z.string().min(1).default("Bookly API"),
    API_VERSION: z
      .string()
      .regex(/^v\d+$/)
      .default("v1"),
    MONGODB_URI: mongodbUriSchema,
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default(rawNodeEnv === "development" ? "debug" : "info"),
    CORS_ORIGINS: corsOriginsSchema,
    RATE_LIMIT_WINDOW_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60 * 1000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    API_DOCS_ENABLED: docsEnabledSchema,
    TRUST_PROXY: booleanString,
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  onValidationError: (issues) => {
    const details = issues
      .map((issue) => `${issue.path?.join(".") ?? "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  },
});
