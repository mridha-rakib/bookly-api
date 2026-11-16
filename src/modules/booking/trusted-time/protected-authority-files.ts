import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FirstClassAuthorityFiles, IndependentObservation } from "./deployment-attestation.js";

/** Fixed, source-controlled location of the root-provisioned deployment-authority handoff.
 * There is deliberately no environment, CLI or configuration override. */
export const FIRST_CLASS_AUTHORITY_DIRECTORY = "/etc/bookly/first-class-authority";

export const FIRST_CLASS_AUTHORITY_FILE_NAMES = {
  deploymentPublicKeyPem: "deployment-authority.pub",
  approvalPublicKeyPem: "release-approval.pub",
  releaseRecord: "release-record.json",
  releaseSignature: "release-record.sig",
  attestation: "attestation.json",
  attestationSignature: "attestation.sig",
} as const satisfies Record<keyof FirstClassAuthorityFiles, string>;

const MAX_FILE_BYTES = 262144;
const denied = (): never => {
  throw Error("Protected First-Class authority input unavailable");
};
const requireLinux = () => {
  if (process.platform !== "linux") denied();
};

/** Every component from `/` to `path` must be a root-owned directory that neither group nor
 * other may write, so the unprivileged API user cannot create, rename or replace entries. */
function verifyRootControlledDirectory(path: string) {
  if (!path.startsWith("/") || path === "/" || posix.normalize(path) !== path) denied();
  const parts = path.split("/").filter(Boolean);
  const chain = ["/", ...parts.map((_, i) => `/${parts.slice(0, i + 1).join("/")}`)];
  for (const component of chain) {
    const stat = lstatSync(component);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0)
      denied();
  }
}

/** Reads one protected authority file: regular, root-owned, not group/other writable, single
 * link, bounded size, opened without following a final symlink and rechecked by inode. */
export function readProtectedAuthorityFile(directory: string, name: string): Buffer {
  requireLinux();
  if (!/^[a-z][a-z0-9.-]{0,63}$/.test(name)) denied();
  verifyRootControlledDirectory(directory);
  const path = `${directory}/${name}`;
  const checkFile = (stat: Stats) =>
    stat.isFile() &&
    stat.uid === 0 &&
    (stat.mode & 0o022) === 0 &&
    stat.nlink === 1 &&
    stat.size > 0 &&
    stat.size <= MAX_FILE_BYTES;
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !checkFile(before)) denied();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!checkFile(opened) || opened.dev !== before.dev || opened.ino !== before.ino) denied();
    const data = readFileSync(fd);
    if (data.length !== opened.size) denied();
    return data;
  } finally {
    closeSync(fd);
  }
}

export function readFirstClassAuthorityFiles(
  directory: string,
  names: readonly (keyof FirstClassAuthorityFiles)[] = Object.keys(
    FIRST_CLASS_AUTHORITY_FILE_NAMES,
  ) as (keyof FirstClassAuthorityFiles)[],
): Partial<FirstClassAuthorityFiles> {
  return Object.fromEntries(
    names.map((key) => [
      key,
      readProtectedAuthorityFile(directory, FIRST_CLASS_AUTHORITY_FILE_NAMES[key]),
    ]),
  );
}

export function readRunningBootId(): string {
  requireLinux();
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

const SAFE_ARTIFACT_PATH = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;

/**
 * Artifact digest v1, reproducible by the deployment authority without application code:
 *
 *   cd <api root> && { find dist -type f; printf '%s\n' package.json pnpm-lock.yaml; } \
 *     | LC_ALL=C sort | while IFS= read -r f; do \
 *       printf '%s\0%s\n' "$f" "$(sha256sum < "$f" | cut -d' ' -f1)"; done | sha256sum
 *
 * Paths are relative, `/`-separated and restricted to a safe ASCII set; any other entry type
 * (symlink, device, socket) or unsafe name makes the artifact unverifiable. `node_modules` is
 * outside the digest: the deployment authority must install it from the attested lockfile
 * with a frozen install and treat it as part of the release it verifies.
 */
export function computeArtifactSha256(
  apiRoot: string,
  options: { requireRootOwned?: boolean } = {},
): string {
  // Deployed artifacts must not be modifiable by the API user after they are measured.
  const owned = (stat: Stats) =>
    !options.requireRootOwned || (stat.uid === 0 && (stat.mode & 0o022) === 0);
  if (!owned(lstatSync(apiRoot)) || !owned(lstatSync(resolve(apiRoot, "dist")))) denied();
  const files: string[] = [];
  const walk = (relative: string) => {
    for (const name of readdirSync(resolve(apiRoot, relative))) {
      const child = `${relative}/${name}`;
      if (!SAFE_ARTIFACT_PATH.test(child)) denied();
      const stat = lstatSync(resolve(apiRoot, child));
      if (stat.isSymbolicLink() || !owned(stat)) denied();
      else if (stat.isDirectory()) walk(child);
      else if (stat.isFile()) files.push(child);
      else denied();
    }
  };
  walk("dist");
  for (const name of ["package.json", "pnpm-lock.yaml"]) {
    const stat = lstatSync(resolve(apiRoot, name));
    if (stat.isSymbolicLink() || !stat.isFile() || !owned(stat)) denied();
    files.push(name);
  }
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const manifest = createHash("sha256");
  for (const file of files) {
    const digest = createHash("sha256")
      .update(readFileSync(resolve(apiRoot, file)))
      .digest("hex");
    manifest.update(`${file}\0${digest}\n`);
  }
  return manifest.digest("hex");
}

/** The API root of the compiled artifact executing this module (`<root>/dist/...`). Running
 * from source (tsx, tests) has no `dist` ancestor here and is refused. */
export function runningArtifactRoot(): string {
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  if (basename(dist) !== "dist") denied();
  return dirname(dist);
}

export function observeRunningArtifact(): IndependentObservation {
  requireLinux();
  const uid = process.getuid?.();
  if (uid === undefined) return denied();
  return Object.freeze({
    bootId: readRunningBootId(),
    artifactSha256: computeArtifactSha256(runningArtifactRoot(), { requireRootOwned: true }),
    processUid: uid,
  });
}
