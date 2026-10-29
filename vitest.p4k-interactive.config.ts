import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

/** P4K isolated interactive First-Class Package lane. The ONLY place the synthetic setup is
 * registered. Files use the `.p4k.ts` suffix so the ordinary suite never collects them.
 * Each entry is skipped unless its explicit environment selector is present.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      pool: "forks",
      fileParallelism: false,
      allowOnly: false,
      passWithNoTests: false,
      setupFiles: ["tests/interactive/p4k-synthetic-authority.setup.ts"],
      include: ["tests/interactive/**/*.p4k.ts"],
      hookTimeout: 180000,
    },
  }),
);
