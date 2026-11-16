import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  measureHostForQualification,
  type ToolEnv,
} from "../../ops/first-class-authority/src/authority.js";
import { LINUX_PATHS } from "../../ops/first-class-authority/src/contract.js";
import type { HostIo } from "../../ops/first-class-authority/src/host.js";
import type { DeploymentAttestation } from "../../src/modules/booking/trusted-time/deployment-attestation.js";
import { createFirstClassDeploymentAuthority } from "../../src/modules/booking/trusted-time/first-class-deployment-authority.js";
import {
  computeArtifactSha256,
  FIRST_CLASS_AUTHORITY_FILE_NAMES,
} from "../../src/modules/booking/trusted-time/protected-authority-files.js";

/**
 * SYNTHETIC Linux host, clock, artifact, approvals and keys for the deployment authority tool.
 * Test-only: keys exist in memory or under a temporary directory; nothing here is an approval,
 * qualification or recommended value.
 */
export const NOW = Date.parse("2026-11-16T10:00:00Z");
export const BOOT = "bbbb2222-2222-4222-8222-222222222222";
export const MACHINE = "0123456789abcdef0123456789abcdef";
export const GIT_SHA = "f".repeat(40);
export const API_ROOT = "/srv/bookly/api";
export const SOURCE = "/opt/bookly-first-class-authority/source";
export const CHRONYC = "/usr/bin/chronyc";
export const VERSION = "chronyc (chrony) version 0.0-synthetic";
export const POLICY = {
  version: 1,
  approvalReference: "synthetic-policy",
  maxAcquireMs: 5000,
  maxSampleAgeMs: 10000,
  maxErrorMs: 1000,
  maxDriftPpm: 100,
  minRemainingMs: 1000,
};
const RELEASE_DOMAIN = "bookly:first-class-release:v1\0";

export const tracking = (wallMs: number, over: Partial<Record<number, string>> = {}) => {
  const f = [
    "TEST",
    "192.0.2.1",
    "2",
    ((wallMs - 1000) / 1000).toFixed(3),
    "0.000010",
    "0.000001",
    "0.000002",
    "1.000",
    "0.000",
    "0.500",
    "0.004",
    "0.002",
    "64.0",
    "Normal",
  ];
  for (const [i, v] of Object.entries(over)) f[Number(i)] = v as string;
  return f.join(",");
};

export function createToolFixture() {
  const root = mkdtempSync(join(tmpdir(), "bookly-authority-tool-"));
  const dir = (name: string) => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return path;
  };
  const config = dir("config");
  const state = dir("state");
  const authority = dir("authority");
  const api = dir("api");
  const source = dir("source");
  const tree = (base: string, files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(base, path)), { recursive: true });
      writeFileSync(join(base, path), content);
    }
  };
  const release = {
    "dist/app/server.js": "server\n",
    "dist/modules/booking.js": "booking\n",
    "package.json": "{}\n",
    "pnpm-lock.yaml": "lock\n",
  };
  tree(api, {
    ...release,
    "node_modules/.modules.yaml": "pnpm\n",
    "node_modules/zod/index.js": "z\n",
  });
  tree(source, release);

  /** Mutable synthetic host. */
  const host = {
    bootId: BOOT,
    machineId: MACHINE,
    kernel: "6.8.0-synthetic",
    files: new Map<string, string>([
      [CHRONYC, "chronyc-binary"],
      [LINUX_PATHS.chronyd, "chronyd-binary"],
      [LINUX_PATHS.chronyConfiguration, "server time.example iburst nts\n"],
    ]),
    confD: [] as string[],
    wall: NOW,
    mono: 0n,
    stepMs: 2,
    monoStepMs: 2,
    version: VERSION,
    tracking: (wallMs: number) => tracking(wallMs),
    chronycFails: false,
    timesyncd: "inactive",
    gitHead: GIT_SHA,
    gitStatus: "",
  };
  const io: HostIo = {
    readFile(path) {
      if (path === LINUX_PATHS.bootId) return Buffer.from(`${host.bootId}\n`);
      if (path === LINUX_PATHS.machineId) return Buffer.from(`${host.machineId}\n`);
      if (path === LINUX_PATHS.kernelRelease) return Buffer.from(`${host.kernel}\n`);
      const value = host.files.get(path);
      if (value === undefined) throw Error("ENOENT");
      return Buffer.from(value);
    },
    listRegularFiles: (path) => (path === "/etc/chrony/conf.d" ? host.confD : undefined),
    async exec(file, args) {
      host.wall += host.stepMs;
      host.mono += BigInt(host.monoStepMs) * 1_000_000n;
      if (file === CHRONYC) {
        if (host.chronycFails) throw Error("timeout");
        if (args[0] === "--version") return { stdout: `${host.version}\n`, exitCode: 0 };
        // Only the read-only loopback monitoring query is answered (never the control socket).
        if (args.join(" ") !== "-h 127.0.0.1 -n -c tracking") throw Error("unexpected chronyc use");
        return { stdout: `${host.tracking(host.wall)}\n`, exitCode: 0 };
      }
      if (file === LINUX_PATHS.systemctl)
        return { stdout: `${host.timesyncd}\n`, exitCode: host.timesyncd === "active" ? 0 : 3 };
      if (file === LINUX_PATHS.git)
        return args.includes("rev-parse")
          ? { stdout: `${host.gitHead}\n`, exitCode: 0 }
          : { stdout: host.gitStatus, exitCode: 0 };
      throw Error("ENOENT");
    },
    wallMs: () => host.wall,
    monotonicNs: () => host.mono,
  };
  const env: ToolEnv = {
    configDirectory: config,
    stateDirectory: state,
    authorityDirectory: authority,
    host: io,
    readConfig: (name) => readFileSync(join(config, name)),
    assertPrivateState: () => undefined,
    requireRootOwnedArtifact: false,
    localPath: (path) => (path === API_ROOT ? api : path === SOURCE ? source : path),
  };

  const approval = generateKeyPairSync("ed25519");
  const pem = (key: KeyObject) => key.export({ type: "spki", format: "pem" }) as string;
  const writeConfig = (name: string, value: unknown) =>
    writeFileSync(join(config, name), typeof value === "string" ? value : JSON.stringify(value));
  writeConfig("release-approval.pub", pem(approval.publicKey));
  writeConfig("clock-policy.json", POLICY);
  writeConfig("attestation-policy.json", {
    version: 1,
    approvalReference: "synthetic-attestation-policy",
    maxValidityMs: 3_600_000,
  });
  writeConfig("deployment.json", { version: 1, apiRoot: API_ROOT, apiUid: 1000 });

  const draftProfile = {
    chronycPath: CHRONYC,
    chronycSocketPath: "127.0.0.1",
    referenceIds: ["TEST"],
    maxAcquireMs: POLICY.maxAcquireMs,
  };
  /** Qualification: measure the synthetic host, then build a CURRENT registry entry. */
  const qualifiedEntry = async (
    authorityId = "synthetic-host-a",
    over: Record<string, unknown> = {},
  ) => {
    const m = await measureHostForQualification(env, draftProfile);
    const { version: _v, approvalReference: _a, ...limits } = POLICY;
    return {
      version: 1 as const,
      qualificationReference: "synthetic-only",
      chronycSha256: m.chronycSha256,
      chronydSha256: m.chronydSha256,
      profile: {
        approvedBootId: m.bootId,
        authorityId,
        hostId: m.hostId,
        configurationHash: m.configurationHash,
        chronycPath: draftProfile.chronycPath,
        chronycSocketPath: draftProfile.chronycSocketPath,
        chronycVersionOutput: m.configuration.chronyc.versionOutput,
        referenceIds: draftProfile.referenceIds,
        ...limits,
      },
      keyReference: "synthetic",
      keyVersion: "v1",
      disposition: "CURRENT" as const,
      ...over,
    };
  };
  const record = (entries: unknown[], over: Record<string, unknown> = {}) =>
    Buffer.from(
      JSON.stringify({
        version: 1,
        approvalReference: "synthetic-release",
        releaseSha: GIT_SHA,
        validFromMs: NOW - 60_000,
        validUntilMs: NOW + 10 * 86_400_000,
        lifetimeMs: 1_800_000,
        policy: POLICY,
        entries,
        keyRoot: "/var/lib/bookly/synthetic-test-keys",
        readerGroupId: 4242,
        ...over,
      }),
    );
  const signRecord = (payload: Buffer, key: KeyObject = approval.privateKey) =>
    sign(null, Buffer.concat([Buffer.from(RELEASE_DOMAIN), payload]), key);

  const published = (name: keyof typeof FIRST_CLASS_AUTHORITY_FILE_NAMES) =>
    readFileSync(join(authority, FIRST_CLASS_AUTHORITY_FILE_NAMES[name]));
  const publishedAttestation = () =>
    JSON.parse(published("attestation").toString("utf8")) as DeploymentAttestation;
  /** The PUBLISHED API authority reading exactly what the tool wrote (a fresh API start). */
  const startApi = () =>
    createFirstClassDeploymentAuthority({
      readFiles: () => ({
        deploymentPublicKeyPem: published("deploymentPublicKeyPem"),
        approvalPublicKeyPem: published("approvalPublicKeyPem"),
        releaseRecord: published("releaseRecord"),
        releaseSignature: published("releaseSignature"),
        attestation: published("attestation"),
        attestationSignature: published("attestationSignature"),
      }),
      readLiveFiles: () => ({
        deploymentPublicKeyPem: published("deploymentPublicKeyPem"),
        attestation: published("attestation"),
        attestationSignature: published("attestationSignature"),
      }),
      observe: () => ({
        bootId: host.bootId,
        artifactSha256: computeArtifactSha256(api),
        processUid: 1000,
      }),
      now: () => host.wall,
    });

  return {
    root,
    paths: { config, state, authority, api, source },
    host,
    env,
    approval,
    pem,
    writeConfig,
    draftProfile,
    qualifiedEntry,
    record,
    signRecord,
    published,
    publishedAttestation,
    startApi,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
