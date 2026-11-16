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
  readdirSync: vi.fn(),
}));

import { readProtectedAuthorityFile } from "../../src/modules/booking/trusted-time/protected-authority-files.js";

const DIR = "/etc/bookly/first-class-authority";
const platform = Object.getOwnPropertyDescriptor(process, "platform");
if (!platform) throw new Error("process platform descriptor missing");
const directory = (over: Record<string, unknown> = {}) => ({
  isDirectory: () => true,
  isSymbolicLink: () => false,
  uid: 0,
  mode: 0o755,
  ...over,
});
const file = (over: Record<string, unknown> = {}) => ({
  isFile: () => true,
  isSymbolicLink: () => false,
  uid: 0,
  mode: 0o644,
  nlink: 1,
  size: 5,
  dev: 1,
  ino: 2,
  ...over,
});
const stats = (
  overrides: {
    dir?: string;
    dirStat?: Record<string, unknown>;
    fileStat?: Record<string, unknown>;
  } = {},
) =>
  io.lstat.mockImplementation((path: string) =>
    path.endsWith(".pub")
      ? file(overrides.fileStat)
      : path === overrides.dir
        ? directory(overrides.dirStat)
        : directory(),
  );

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  vi.resetAllMocks();
  stats();
  io.fstat.mockReturnValue(file());
  io.open.mockReturnValue(9);
  io.read.mockReturnValue(Buffer.from("hello"));
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
});

it("reads a root-owned, non-writable regular file under a root-controlled path", () => {
  expect(readProtectedAuthorityFile(DIR, "a.pub").toString()).toBe("hello");
  expect(io.lstat.mock.calls.map(([p]) => p)).toEqual([
    "/",
    "/etc",
    "/etc/bookly",
    DIR,
    `${DIR}/a.pub`,
  ]);
  expect(io.close).toHaveBeenCalledWith(9);
});

it.each([
  ["API-writable directory", { dir: "/etc/bookly", dirStat: { mode: 0o775 } }],
  ["non-root directory", { dir: DIR, dirStat: { uid: 1000 } }],
  ["symlinked directory", { dir: "/etc", dirStat: { isSymbolicLink: () => true } }],
  ["non-root file", { fileStat: { uid: 1000 } }],
  ["group-writable file", { fileStat: { mode: 0o664 } }],
  ["hard-linked file", { fileStat: { nlink: 2 } }],
  ["symlinked file", { fileStat: { isSymbolicLink: () => true } }],
  ["empty file", { fileStat: { size: 0 } }],
])("denies a %s", (_name, overrides) => {
  stats(overrides);
  expect(() => readProtectedAuthorityFile(DIR, "a.pub")).toThrow();
});

it("denies an inode swap between check and open, a short read, and unsafe names", () => {
  io.fstat.mockReturnValue(file({ ino: 3 }));
  expect(() => readProtectedAuthorityFile(DIR, "a.pub")).toThrow();
  expect(io.close).toHaveBeenCalledWith(9);
  io.fstat.mockReturnValue(file());
  io.read.mockReturnValue(Buffer.from("hell"));
  expect(() => readProtectedAuthorityFile(DIR, "a.pub")).toThrow();
  for (const name of ["../a.pub", "A.pub", ".pub", "a/b.pub"])
    expect(() => readProtectedAuthorityFile(DIR, name)).toThrow();
  expect(() => readProtectedAuthorityFile("/etc/../tmp", "a.pub")).toThrow();
});
