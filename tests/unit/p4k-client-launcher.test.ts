import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startP4kClient } from "../interactive/p4k-client.js";

const launched = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: launched.spawn }));
const owned: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  launched.spawn.mockReset();
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "bookly-p4k-launch-test-"));
  owned.push(root);
  const next = join(root, "node_modules/next/dist/bin/next");
  mkdirSync(dirname(next), { recursive: true });
  writeFileSync(next, "// test-owned placeholder; never executed");
  return {
    clientRoot: root,
    apiOrigin: "http://127.0.0.1:3100",
    uiOrigin: "http://127.0.0.1:3101",
  };
};

it("launches copied clients with Webpack and local fonts without inheriting provider settings", async () => {
  const input = fixture();
  vi.stubEnv("STRIPE_SECRET_KEY", "synthetic-must-not-reach-child");
  // stop() tears down the whole process tree of a running child (it needs a pid): taskkill /T /F
  // on Windows, child.kill() elsewhere — so the fake child is an emitter with a pid.
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: null,
    pid: 4242,
    kill: vi.fn(() => queueMicrotask(() => child.emit("exit", 0))),
  });
  launched.spawn.mockImplementation((command: string) => {
    if (command === "taskkill") {
      const killer = new EventEmitter();
      queueMicrotask(() => killer.emit("exit", 0));
      return killer;
    }
    queueMicrotask(() => child.stdout.emit("data", "Ready in 1ms"));
    return child;
  });
  const client = await startP4kClient(input);
  expect(launched.spawn).toHaveBeenCalledOnce();
  const [, args, options] = launched.spawn.mock.calls[0] ?? [];
  expect(args).toContain("--webpack");
  expect(options.cwd).toBe(input.clientRoot);
  expect(options.env.STRIPE_SECRET_KEY).toBeUndefined();
  expect(options.env.NEXT_PUBLIC_API_BASE_URL).toBe(`${input.apiOrigin}/api/v1`);
  const font = options.env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES;
  owned.push(dirname(font));
  expect(readFileSync(font, "utf8")).toContain("src: local('Arial')");
  await client.stop();
  if (process.platform === "win32") {
    expect(launched.spawn).toHaveBeenCalledTimes(2);
    expect(launched.spawn.mock.calls[1]?.slice(0, 2)).toEqual([
      "taskkill",
      ["/PID", "4242", "/T", "/F"],
    ]);
    expect(child.kill).not.toHaveBeenCalled();
  } else {
    expect(child.kill).toHaveBeenCalledOnce();
  }
});

it("refuses a client with dotenv files before spawning Next", async () => {
  const input = fixture();
  writeFileSync(join(input.clientRoot, ".env"), "SYNTHETIC=1");
  await expect(startP4kClient(input)).rejects.toThrow("Client root contains .env*");
  expect(launched.spawn).not.toHaveBeenCalled();
});

it("refuses a nonlocal API before spawning Next", async () => {
  await expect(
    startP4kClient({ ...fixture(), apiOrigin: "https://example.invalid" }),
  ).rejects.toThrow("must both use 127.0.0.1");
  expect(launched.spawn).not.toHaveBeenCalled();
});
