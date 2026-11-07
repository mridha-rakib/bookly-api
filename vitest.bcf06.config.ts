import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";
export default mergeConfig(
  base,
  defineConfig({
    test: {
      pool: "forks",
      fileParallelism: false,
      allowOnly: false,
      passWithNoTests: false,
      setupFiles: ["tests/interactive/bcf06.setup.ts"],
      include: ["tests/interactive/**/*.bcf06.ts"],
      hookTimeout: 600000,
    },
  }),
);
