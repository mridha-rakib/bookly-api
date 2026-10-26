import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const workerConfig = require("../../ecosystem.money-recovery.config.cjs");
const apiConfig = require("../../ecosystem.config.cjs");

describe("opt-in money recovery process configuration", () => {
  it("keeps default API startup separate and does not provide enablement", () => {
    expect(apiConfig.apps.map((app: { name: string }) => app.name)).toEqual(["bookly-api"]);
    expect(workerConfig.apps).toHaveLength(1);
    expect(workerConfig.apps[0].env).toEqual({ NODE_ENV: "production" });
    const docker = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
    expect(docker).toContain('CMD ["node", "dist/app/server.js"]');
  });

  it("runs one independently supervised Node process from the API directory", () => {
    expect(workerConfig.apps[0]).toMatchObject({
      name: "bookly-money-recovery",
      cwd: fileURLToPath(new URL("../..", import.meta.url)).replace(/[\\/]$/, ""),
      script: "dist/scripts/run-money-recovery-worker.js",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      kill_timeout: 120000,
    });
  });

  it("maps to an included TypeScript entry without a development-only interpreter", () => {
    const tsconfig = JSON.parse(
      readFileSync(new URL("../../tsconfig.json", import.meta.url), "utf8"),
    );
    expect(tsconfig.compilerOptions).toMatchObject({ rootDir: "src", outDir: "dist" });
    expect(tsconfig.include).toContain("src/**/*.ts");
    const source = readFileSync(
      new URL("../../src/scripts/run-money-recovery-worker.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("assertMoneyRecoveryLaunch(process.env, process.argv.slice(2))");
    expect(workerConfig.apps[0].script).not.toContain("tsx");
    // Actual dist existence/runtime closure must be checked after the trusted build.
  });
});
