import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  computeArtifactSha256,
  observeRunningArtifact,
  readProtectedAuthorityFile,
  runningArtifactRoot,
} from "../../src/modules/booking/trusted-time/protected-authority-files.js";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});
const tree = (extra: Record<string, string> = {}) => {
  root = mkdtempSync(join(tmpdir(), "bookly-artifact-"));
  const files: Record<string, string> = {
    "dist/app/server.js": "a\n",
    "dist/modules/x.js": "b\n",
    "dist/a-b/C.js": "c\n",
    "dist/Upper.js": "Z\n",
    "package.json": "{}\n",
    "pnpm-lock.yaml": "lock\n",
    ...extra,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};

it("matches the documented shell recipe the deployment authority runs", () => {
  // Reference value computed with the exact `find | LC_ALL=C sort | sha256sum` recipe
  // documented on computeArtifactSha256, over this same synthetic tree.
  expect(computeArtifactSha256(tree())).toBe(
    "a8fc7b4e90917e70bd74137822e6fd7e773ea542a8c537c8afebed6fd9d54d7b",
  );
});

it("changes with any artifact byte and refuses unsafe names", () => {
  expect(computeArtifactSha256(tree({ "dist/app/server.js": "A\n" }))).not.toBe(
    "a8fc7b4e90917e70bd74137822e6fd7e773ea542a8c537c8afebed6fd9d54d7b",
  );
  rmSync(root as string, { recursive: true, force: true });
  expect(() => computeArtifactSha256(tree({ "dist/has space.js": "x" }))).toThrow();
});

it("refuses a source (non-dist) execution and non-Linux protected reads", () => {
  expect(() => runningArtifactRoot()).toThrow();
  expect(() => observeRunningArtifact()).toThrow();
  expect(() => readProtectedAuthorityFile("/etc/bookly/first-class-authority", "x.pub")).toThrow();
});

it("requires a root-owned, non-writable artifact when measuring the running release", () => {
  // Temporary test files are user-owned (Linux) or report group/other-writable modes (Windows),
  // so the shipped measurement mode refuses them.
  expect(() => computeArtifactSha256(tree(), { requireRootOwned: true })).toThrow();
});
