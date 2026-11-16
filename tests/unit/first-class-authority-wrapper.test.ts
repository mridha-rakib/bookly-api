import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const WRAPPER = resolve("ops/first-class-authority/bin/bookly-first-class-authority");
const SHIPPED = readFileSync(WRAPPER, "utf8");

/** True when every component of the running Node binary is root-controlled (as on Hetzner). */
const rootControlledNode = (() => {
  if (process.platform !== "linux") return false;
  let path = realpathSync(process.execPath);
  for (;;) {
    const stat = lstatSync(path);
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) return false;
    if (path === "/") return true;
    path = dirname(path);
  }
})();

describe.skipIf(process.platform !== "linux")("authority tool wrapper Node resolution", () => {
  const work = mkdtempSync(join(tmpdir(), "fc-wrapper-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  writeFileSync(
    join(work, "main.js"),
    "console.log(JSON.stringify({ version: process.version, env: Object.keys(process.env).sort(), argv: process.argv.slice(2) }));\n",
  );

  /** The shipped wrapper with only its fixed candidate list and tool root substituted. */
  const run = (candidates: string) => {
    const script = SHIPPED.replace(
      'NODE_CANDIDATES="/usr/bin/node /usr/local/bin/node"',
      `NODE_CANDIDATES="${candidates}"`,
    ).replace(
      '"$TOOL_ROOT/ops/first-class-authority/build/ops/first-class-authority/src/main.js"',
      `"${join(work, "main.js")}"`,
    );
    const path = join(work, `wrapper-${Math.random().toString(16).slice(2)}.sh`);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
    try {
      return { ok: true, out: execFileSync("/bin/sh", [path, "status"], { encoding: "utf8" }) };
    } catch (error) {
      const e = error as { stderr?: string; status?: number };
      return { ok: false, out: String(e.stderr ?? ""), status: e.status };
    }
  };

  it("ships fixed candidates and never hard-codes a single Node path", () => {
    expect(SHIPPED).toContain('NODE_CANDIDATES="/usr/bin/node /usr/local/bin/node"');
    expect(SHIPPED).toMatch(/exec \/usr\/bin\/env -i LC_ALL=C PATH=/);
    expect(SHIPPED).not.toMatch(/\$\{?NODE_PATH|\$\{?BOOKLY_/);
  });

  it("refuses when no candidate exists", () => {
    const result = run(`${work}/missing-a ${work}/missing-b`);
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/^NODE_RUNTIME_UNAVAILABLE: no Node\.js 24/);
  });

  it("refuses a Node binary that is not root-owned", () => {
    const copy = join(work, "user-node");
    writeFileSync(copy, readFileSync(realpathSync(process.execPath)));
    chmodSync(copy, 0o755);
    const result = run(copy);
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/^NODE_RUNTIME_UNAVAILABLE: .* is not a root-controlled/);
  });

  it("refuses a non-root symlink even when it points at a root-owned runtime", () => {
    const link = join(work, "user-link-node");
    symlinkSync(realpathSync(process.execPath), link);
    const result = run(link);
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/is not a root-controlled/);
  });

  it("does not fall back past an unsafe earlier candidate", () => {
    const unsafe = join(work, "user-node");
    const result = run(`${unsafe} ${realpathSync(process.execPath)}`);
    expect(result.ok).toBe(false);
  });

  it.skipIf(!rootControlledNode)(
    "uses the first root-controlled Node.js 24 candidate with an empty environment",
    () => {
      const result = run(`${work}/missing ${realpathSync(process.execPath)}`);
      expect(result.ok).toBe(true);
      const shown = JSON.parse(result.out) as { version: string; env: string[]; argv: string[] };
      expect(shown.version).toMatch(/^v24\./);
      expect(shown.env).toEqual(["LC_ALL", "PATH"]);
      expect(shown.argv).toEqual(["status"]);
    },
  );
});
