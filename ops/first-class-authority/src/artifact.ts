import { lstatSync, readdirSync, readFileSync, readlinkSync, type Stats } from "node:fs";
import { posix, resolve } from "node:path";
import { computeArtifactSha256 } from "../../../src/modules/booking/trusted-time/protected-authority-files.js";
import { LINUX_PATHS, refuse, sha256Hex } from "./contract.js";
import type { HostIo } from "./host.js";

export type ArtifactMeasurement = Readonly<{
  /** Exactly the API's artifact digest v1 (dist/** + package.json + pnpm-lock.yaml). */
  artifactSha256: string;
  /** Tool-only digest of node_modules (outside the API digest). Pinned at adoption and
   * re-checked on every renewal; never trusted from a claim. */
  dependencySha256: string;
}>;

const rootOwned = (stat: Stats) => stat.uid === 0 && (stat.mode & 0o022) === 0;

/**
 * `node_modules` digest v1: sorted lines `<type>\0<relative path>\0<sha256 | link target>\n`
 * hashed with SHA-256, where type is `f` (regular file) or `l` (symlink). Symlinks (pnpm
 * layout) must be relative and stay inside node_modules. Any other entry type, control
 * character in a name, or (when required) a non-root-owned / group- or other-writable entry
 * makes the dependency tree unverifiable.
 */
export function computeDependencySha256(apiRoot: string, requireRootOwned: boolean): string {
  const base = resolve(apiRoot, "node_modules");
  const lines: string[] = [];
  const check = (stat: Stats) => {
    if (requireRootOwned && !rootOwned(stat))
      refuse("ARTIFACT_NOT_ROOT_OWNED", "node_modules entry is not root-owned and read-only");
  };
  const top = lstatSync(base);
  if (!top.isDirectory() || top.isSymbolicLink())
    refuse("DEPENDENCIES_UNAVAILABLE", "node_modules is missing");
  check(top);
  const walk = (relative: string) => {
    for (const name of readdirSync(resolve(base, relative)).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters
      if (/[\x00-\x1f\x7f\\]/.test(child)) refuse("DEPENDENCIES_UNSAFE", "unsafe file name");
      const path = resolve(base, child);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        // Symlink ownership is checked; permission bits on Linux symlinks are not meaningful.
        if (requireRootOwned && stat.uid !== 0)
          refuse("ARTIFACT_NOT_ROOT_OWNED", "node_modules symlink is not root-owned");
        const target = readlinkSync(path).split("\\").join("/");
        const joined = posix.normalize(posix.join(posix.dirname(child), target));
        if (target.startsWith("/") || joined.startsWith("..") || /^[A-Za-z]:/.test(target))
          refuse("DEPENDENCIES_UNSAFE", "node_modules link escapes the tree");
        lines.push(`l\0${child}\0${target}\n`);
      } else if (stat.isDirectory()) {
        check(stat);
        walk(child);
      } else if (stat.isFile()) {
        check(stat);
        lines.push(`f\0${child}\0${sha256Hex(readFileSync(path))}\n`);
      } else refuse("DEPENDENCIES_UNSAFE", "special file in node_modules");
    }
  };
  walk("");
  // pnpm records a successful install here; its absence means an incomplete tree.
  if (!lines.some((line) => line.startsWith("f\0.modules.yaml\0")))
    refuse("DEPENDENCIES_UNAVAILABLE", "node_modules/.modules.yaml missing (not a pnpm install)");
  lines.sort();
  return sha256Hex(lines.join(""));
}

export function measureArtifact(apiRoot: string, requireRootOwned: boolean): ArtifactMeasurement {
  try {
    if (requireRootOwned) {
      // Every ancestor of the API root must also be root-controlled.
      const parts = apiRoot.split("/").filter(Boolean);
      for (let i = 0; i <= parts.length; i++) {
        const stat = lstatSync(`/${parts.slice(0, i).join("/")}`);
        if (stat.isSymbolicLink() || !stat.isDirectory() || !rootOwned(stat)) throw Error();
      }
    }
  } catch {
    return refuse("ARTIFACT_NOT_ROOT_OWNED", "API root or an ancestor is not root-controlled");
  }
  let artifactSha256: string;
  try {
    artifactSha256 = computeArtifactSha256(apiRoot, { requireRootOwned });
  } catch {
    return refuse("ARTIFACT_UNVERIFIABLE", "dist/package.json/pnpm-lock.yaml unverifiable");
  }
  let dependencySha256: string;
  try {
    dependencySha256 = computeDependencySha256(apiRoot, requireRootOwned);
  } catch (error) {
    if (error instanceof Error && /^[A-Z_]+: /.test(error.message)) throw error;
    return refuse("DEPENDENCIES_UNAVAILABLE", "node_modules unreadable");
  }
  return Object.freeze({ artifactSha256, dependencySha256 });
}

/**
 * Establishes the Git release independently of the signed record: the root-owned source
 * checkout must be clean at exactly `gitSha`, carry byte-identical package.json and
 * pnpm-lock.yaml, and its built `dist` must produce the same artifact digest as the deployed
 * tree. Git runs with hooks and fsmonitor disabled so repository config cannot execute code.
 */
export async function verifySourceCheckout(
  io: HostIo,
  source: string,
  localSource: string,
  gitSha: string,
  deployed: ArtifactMeasurement,
  requireRootOwned: boolean,
): Promise<void> {
  const git = (args: string[]) =>
    io.exec(
      LINUX_PATHS.git,
      ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", source, ...args],
      30000,
    );
  let head: { stdout: string; exitCode: number };
  let status: { stdout: string; exitCode: number };
  try {
    head = await git(["rev-parse", "--verify", "HEAD^{commit}"]);
    status = await git(["status", "--porcelain=v1", "--untracked-files=all", "--ignored=no"]);
  } catch {
    return refuse("RELEASE_SOURCE_UNAVAILABLE", "git checkout unreadable");
  }
  if (head.exitCode !== 0 || head.stdout.trim() !== gitSha)
    refuse("RELEASE_SHA_MISMATCH", "source checkout HEAD is not the approved release SHA");
  if (status.exitCode !== 0 || status.stdout.trim() !== "")
    refuse("RELEASE_SOURCE_DIRTY", "source checkout has local modifications");
  let built: string;
  try {
    built = computeArtifactSha256(localSource, { requireRootOwned });
  } catch {
    return refuse("RELEASE_SOURCE_UNAVAILABLE", "source checkout build output unverifiable");
  }
  if (built !== deployed.artifactSha256)
    refuse("ARTIFACT_MISMATCH", "deployed artifact differs from the approved source build");
}
