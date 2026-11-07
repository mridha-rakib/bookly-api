/** P4K isolated Client launcher: the existing Next app, unmodified, as a dev server bound to
 * 127.0.0.1 and pointed only at the harness API. Shared by the manual session and the journeys.
 *
 * The child environment is built from scratch (no inherited secrets). The Client root must have
 * no `.env*` files: Next loads them itself, and an operational NEXT_PUBLIC_API_BASE_URL or real
 * publishable key must never reach this run. The publishable key is obviously synthetic; the
 * harness browser answers the Stripe.js request with the local stub (p4k-browser.ts).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const P4K_SYNTHETIC_PUBLISHABLE_KEY = "pk_test_p4k_synthetic_never_valid";

export type P4kClient = { origin: string; stop: () => Promise<void> };

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
  // Audit copies reuse provisioned dependencies through a junction. Turbopack rejects
  // a dependency junction outside its root; use the same Webpack lane as the Next E2Es.
  // Font responses stay local too, without changing application source or fetching Google.
  const fontMock = join(mkdtempSync(join(tmpdir(), "bookly-p4k-font-")), "fonts.cjs");
  writeFileSync(
    fontMock,
    `module.exports=new Proxy({}, {get:()=>"@font-face { font-family: 'Poppins'; font-style: normal; font-weight: 400; src: local('Arial'); }"});`,
  );
  const child: ChildProcess = spawn(
    process.execPath,
    [nextBin, "dev", "--webpack", "--hostname", "127.0.0.1", "--port", ui.port],
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
        NEXT_FONT_GOOGLE_MOCKED_RESPONSES: fontMock,
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
  const stopTree = async () => {
    if (!child.pid) return;
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("error", () => resolve());
        killer.once("exit", () => resolve());
      });
    } else if (child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, "exit").then(() => undefined), delay(2000)]);
    }
  };
  for (let i = 0; i < 1800 && !/Ready in/.test(log); i++) {
    if (child.exitCode !== null) {
      await stopTree();
      throw Error(`Next exited: ${log.slice(-4000)}`);
    }
    await delay(100);
  }
  if (!/Ready in/.test(log)) {
    await stopTree();
    throw Error(`Next readiness timeout: ${log.slice(-4000)}`);
  }
  return {
    origin: input.uiOrigin,
    stop: stopTree,
  };
}
