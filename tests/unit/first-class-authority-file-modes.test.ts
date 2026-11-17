import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The renewal unit runs with UMask=0077. Published authority files must still be 0644 (the
 * non-root API reads them) while private state stays 0600: the mode is set explicitly on the
 * descriptor and never depends on the inherited umask.
 */

const fchmodCalls: Array<[number, number]> = [];
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fchmodSync: (fd: number, mode: number) => {
      fchmodCalls.push([fd, mode]);
      return actual.fchmodSync(fd, mode);
    },
  };
});

const { writeFileAtomic } = await import("../../ops/first-class-authority/src/state.js");

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
  fchmodCalls.length = 0;
});

describe("first-class authority tool file modes", () => {
  it("sets the requested mode on the descriptor before writing", () => {
    directory = mkdtempSync(join(tmpdir(), "fc-modes-"));
    writeFileAtomic(directory, "published.json", Buffer.from("public"), 0o644);
    writeFileAtomic(directory, "private.json", Buffer.from("secret"), 0o600);
    expect(fchmodCalls.map(([, mode]) => mode)).toEqual([0o644, 0o600]);
    expect(readFileSync(join(directory, "published.json"), "utf8")).toBe("public");
  });

  it.skipIf(process.platform === "win32")(
    "publishes 0644 and keeps private files 0600 under UMask=0077 and 0022",
    () => {
      for (const umask of [0o077, 0o022]) {
        const previous = process.umask(umask);
        try {
          directory = mkdtempSync(join(tmpdir(), "fc-modes-"));
          writeFileAtomic(directory, "published.json", Buffer.from("public"), 0o644);
          writeFileAtomic(directory, "private.json", Buffer.from("secret"), 0o600);
          expect(statSync(join(directory, "published.json")).mode & 0o777).toBe(0o644);
          expect(statSync(join(directory, "private.json")).mode & 0o777).toBe(0o600);
        } finally {
          process.umask(previous);
          rmSync(directory as string, { recursive: true, force: true });
          directory = undefined;
        }
      }
    },
  );
});
