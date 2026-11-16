import { afterEach, beforeEach, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  lstat: vi.fn(),
  fstat: vi.fn(),
  open: vi.fn(),
  read: vi.fn(),
  close: vi.fn(),
}));
vi.mock("node:fs", () => ({
  constants: { O_RDONLY: 0, O_NOFOLLOW: 131072, O_NONBLOCK: 2048 },
  lstatSync: io.lstat,
  fstatSync: io.fstat,
  openSync: io.open,
  readFileSync: io.read,
  closeSync: io.close,
}));

import { createFileAuditKeyResolver } from "../../src/modules/booking/trusted-time/file-audit-key-resolver.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform");
if (!platform) throw new Error("process platform descriptor missing");
const directory = (restricted: boolean) => ({
  isDirectory: () => true,
  isSymbolicLink: () => false,
  uid: 0,
  gid: 42,
  mode: restricted ? 0o750 : 0o755,
});
const file = () => ({
  isFile: () => true,
  isSymbolicLink: () => false,
  uid: 0,
  gid: 42,
  mode: 0o640,
  nlink: 1,
  size: 32,
  dev: 1,
  ino: 2,
});
const withoutGit = (stat: (path: string) => unknown) => (path: string) => {
  if (path.endsWith("/.git")) throw Object.assign(new Error("missing"), { code: "ENOENT" });
  return stat(path);
};
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  vi.resetAllMocks();
  io.lstat.mockImplementation(
    withoutGit((p: string) =>
      p.endsWith(".key") ? file() : directory(p === "/keys" || p === "/keys/audit"),
    ),
  );
  io.fstat.mockReturnValue(file());
  io.open.mockReturnValue(17);
  io.read.mockReturnValue(Buffer.alloc(32, 7));
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
});

it("resolves distinct versioned keys on every signing and historical verification call", () => {
  const resolve = createFileAuditKeyResolver("/keys", 42);
  expect(resolve("audit", "v2", "SIGN")).toEqual(Buffer.alloc(32, 7));
  expect(resolve("audit", "v1", "VERIFY")).toEqual(Buffer.alloc(32, 7));
  expect(io.open.mock.calls.map(([path]) => path)).toEqual([
    "/keys/audit/v2.key",
    "/keys/audit/v1.key",
  ]);
  expect(io.close).toHaveBeenCalledTimes(2);
});

it("refuses traversal, writable or linked paths, and an exchanged file", () => {
  const resolve = createFileAuditKeyResolver("/keys", 42);
  expect(() => resolve("../audit", "v1", "SIGN")).toThrow("unavailable");
  io.lstat.mockImplementation(
    withoutGit((p: string) =>
      p === "/keys" ? { ...directory(true), mode: 0o770 } : directory(false),
    ),
  );
  expect(() => resolve("audit", "v1", "SIGN")).toThrow("unavailable");
  io.lstat.mockImplementation(
    withoutGit((p: string) =>
      p.endsWith(".key")
        ? { ...file(), isSymbolicLink: () => true }
        : directory(p === "/keys" || p === "/keys/audit"),
    ),
  );
  expect(() => resolve("audit", "v1", "VERIFY")).toThrow("unavailable");
  io.lstat.mockImplementation(
    withoutGit((p: string) =>
      p.endsWith(".key") ? file() : directory(p === "/keys" || p === "/keys/audit"),
    ),
  );
  io.fstat.mockReturnValue({ ...file(), ino: 3 });
  expect(() => resolve("audit", "v1", "VERIFY")).toThrow("unavailable");
  expect(io.close).toHaveBeenCalledTimes(1);
});

it("refuses a key directory inside a Git worktree", () => {
  const resolve = createFileAuditKeyResolver("/keys", 42);
  io.lstat.mockImplementation((path: string) => {
    if (path === "/keys/.git") return file();
    return withoutGit((p) =>
      p.endsWith(".key") ? file() : directory(p === "/keys" || p === "/keys/audit"),
    )(path);
  });
  expect(() => resolve("audit", "v1", "SIGN")).toThrow("unavailable");
  expect(io.open).not.toHaveBeenCalled();
});

it("fails closed outside Linux and when a protected key disappears", () => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  expect(() => createFileAuditKeyResolver("/keys", 42)).toThrow("unavailable");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const resolve = createFileAuditKeyResolver("/keys", 42);
  io.open.mockImplementation(() => {
    throw new Error("private path must not escape");
  });
  expect(() => resolve("audit", "v1", "VERIFY")).toThrow(/^Protected audit key unavailable$/);
});
