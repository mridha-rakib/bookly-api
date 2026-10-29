/** P4K isolated Client launcher: the existing Next app, unmodified, as a dev server bound to
 * 127.0.0.1 and pointed only at the harness API. Shared by the manual session and the journeys.
 *
 * The child environment is built from scratch (no inherited secrets). The Client root must have
 * no `.env*` files: Next loads them itself, and an operational NEXT_PUBLIC_API_BASE_URL or real
 * publishable key must never reach this run. The publishable key is obviously synthetic; the
 * harness browser answers the Stripe.js request with the local stub (p4k-browser.ts).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const P4K_SYNTHETIC_PUBLISHABLE_KEY = "pk_test_p4k_synthetic_never_valid";

export type P4kClient = { origin: string; stop: () => void };

export async function startP4kClient(input: {
  clientRoot: string;
  apiOrigin: string;
  uiOrigin: string;
}): Promise<P4kClient> {
  const root = resolve(input.clientRoot);
  if (readdirSync(root).some((name) => name.startsWith(".env")))
    throw Error(
      "Client root contains .env* files; refusing (Next would load them). Use a clean checkout.",
    );
  const nextBin = join(root, "node_modules/next/dist/bin/next");
  if (!existsSync(nextBin)) throw Error("Provisioned client dependencies required");
  const ui = new URL(input.uiOrigin),
    api = new URL(input.apiOrigin);
  if (ui.hostname !== "127.0.0.1" || api.hostname !== "127.0.0.1")
    throw Error("P4K Client and API must both use 127.0.0.1");
  const child: ChildProcess = spawn(
    process.execPath,
    [nextBin, "dev", "--hostname", "127.0.0.1", "--port", ui.port],
    {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        ...(process.env["SystemRoot"] ? { SystemRoot: process.env["SystemRoot"] } : {}),
        NODE_ENV: "development",
        NEXT_TELEMETRY_DISABLED: "1",
        NEXT_PUBLIC_API_BASE_URL: `${input.apiOrigin}/api/v1`,
        NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: P4K_SYNTHETIC_PUBLISHABLE_KEY,
      },
    },
  );
  let log = "";
  child.stdout?.on("data", (d) => {
    log = (log + d).slice(-20000);
  });
  child.stderr?.on("data", (d) => {
    log = (log + d).slice(-20000);
  });
  for (let i = 0; i < 1800 && !/Ready in/.test(log); i++) {
    if (child.exitCode !== null) throw Error(`Next exited: ${log.slice(-4000)}`);
    await delay(100);
  }
  if (!/Ready in/.test(log)) {
    child.kill();
    throw Error("Next readiness timeout");
  }
  return {
    origin: input.uiOrigin,
    stop: () => {
      child.kill();
    },
  };
}
