#!/usr/bin/env node
// Docker's production-only install (`pnpm install --prod`) excludes the husky
// devDependency but pnpm still runs this "prepare" lifecycle script, so this
// wrapper must decide whether it is safe to run before assuming husky exists.
import { existsSync } from "node:fs";
import path from "node:path";

const log = (message) => {
  process.stdout.write(`${message}\n`);
};

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
};

const main = async () => {
  if (process.env.HUSKY === "0") {
    log("husky: skipped (HUSKY=0)");
    return;
  }

  const gitDir = path.join(process.cwd(), ".git");

  if (!existsSync(gitDir)) {
    log("husky: skipped (not a Git checkout)");
    return;
  }

  const { default: husky } = await import("husky");
  const result = husky();

  if (result) {
    throw new Error(`husky initialization failed: ${result}`);
  }

  log("husky: git hooks installed");
};

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
