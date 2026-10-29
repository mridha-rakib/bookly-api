import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const workerConfig = require("../../ecosystem.email-worker.config.cjs");
const apiConfig = require("../../ecosystem.config.cjs");
const moneyRecoveryConfig = require("../../ecosystem.money-recovery.config.cjs");

const read = (relative: string): string =>
  readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");

describe("opt-in transactional email worker process configuration", () => {
  it("leaves default API startup unchanged and does not provide enablement", () => {
    expect(apiConfig.apps.map((app: { name: string }) => app.name)).toEqual(["bookly-api"]);
    expect(apiConfig.apps[0].script).toBe("dist/app/server.js");
    expect(read("Dockerfile")).toContain('CMD ["node", "dist/app/server.js"]');
    expect(workerConfig.apps).toHaveLength(1);
    expect(workerConfig.apps[0].env).toEqual({ NODE_ENV: "production" });
    expect(JSON.stringify(workerConfig)).not.toContain("BOOKLY_EMAIL_WORKER_ENABLED");
  });

  it("runs one independently supervised forked Node process from the API directory", () => {
    expect(workerConfig.apps[0]).toMatchObject({
      name: "bookly-email-worker",
      cwd: fileURLToPath(new URL("../..", import.meta.url)).replace(/[\\/]$/, ""),
      script: "dist/scripts/run-email-worker.js",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      kill_timeout: 60000,
    });
    expect(workerConfig.apps[0].name).not.toBe(moneyRecoveryConfig.apps[0].name);
  });

  it("drain grace is shorter than the default outbox claim timeout", () => {
    // A gracefully stopped worker must finish (or be killed) before its claim can go stale and
    // be reclaimed elsewhere; see EMAIL_OUTBOX_CLAIM_TIMEOUT_MS default in env.ts.
    expect(read("src/config/env.ts")).toContain(
      "EMAIL_OUTBOX_CLAIM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000)",
    );
    expect(workerConfig.apps[0].kill_timeout).toBeLessThan(120_000);
  });

  it("maps to an included TypeScript entry without a development-only interpreter", () => {
    const tsconfig = JSON.parse(read("tsconfig.json"));
    expect(tsconfig.compilerOptions).toMatchObject({ rootDir: "src", outDir: "dist" });
    expect(tsconfig.include).toContain("src/**/*.ts");
    const source = read("src/scripts/run-email-worker.ts");
    expect(source).toContain("assertEmailWorkerLaunch(process.env, process.argv.slice(2))");
    expect(source).not.toContain("process.exit(");
    expect(source).not.toContain("setInterval(");
    expect(workerConfig.apps[0].script).not.toContain("tsx");
    // Actual dist existence and production dependency closure need the trusted build.
  });
});
