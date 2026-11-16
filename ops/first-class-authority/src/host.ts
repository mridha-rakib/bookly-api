import { chronyClockBound } from "../../../src/modules/booking/trusted-time/chrony-bound.js";
import { clockPolicyFingerprint } from "../../../src/modules/booking/trusted-time/deployment-attestation.js";
import type { ConsentHostAuthorityEntry } from "../../../src/modules/booking/trusted-time/host-authority-registry.js";
import {
  HOST_CONFIGURATION_CONTRACT,
  type HostConfigurationV1,
  hostConfigurationHash,
  LINUX_PATHS,
  refuse,
  sha256Hex,
} from "./contract.js";

export type HostProfile = ConsentHostAuthorityEntry["profile"];

/** Every host interaction, so the shipped Linux implementation is the only real source and
 * tests can supply simulated hosts. */
export type HostIo = Readonly<{
  /** Reads a regular file (never through a symlink). Throws when absent. */
  readFile(path: string): Buffer;
  /** Regular-file names in a directory; `undefined` when the directory does not exist.
   * Throws on any non-regular entry (symlink, device, subdirectory). */
  listRegularFiles(path: string): readonly string[] | undefined;
  /** Runs an absolute-path executable with a fixed minimal environment and no shell. */
  exec(
    file: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<{ stdout: string; exitCode: number }>;
  wallMs(): number;
  monotonicNs(): bigint;
}>;

export const readBootId = (io: HostIo) => {
  const id = io.readFile(LINUX_PATHS.bootId).toString("utf8").trim();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
    refuse("HOST_BOOT_UNAVAILABLE", "boot id unreadable");
  return id;
};

export type HostMeasurement = Readonly<{
  bootId: string;
  hostId: string;
  configuration: HostConfigurationV1;
  configurationHash: string;
  chronycSha256: string;
  chronydSha256: string;
  timesyncd: string;
}>;

/**
 * Measures the Linux host for the profile's clock interface. Read-only. The values that go
 * into the signed release record (hostId, configurationHash, chrony hashes, version output) are
 * produced here, and every later attestation re-measures and requires equality.
 */
export async function measureHost(
  io: HostIo,
  profile: Pick<HostProfile, "chronycPath" | "chronycSocketPath" | "referenceIds" | "maxAcquireMs">,
  policy: unknown,
): Promise<HostMeasurement> {
  const bootId = readBootId(io);
  const machineId = io.readFile(LINUX_PATHS.machineId).toString("utf8").trim();
  if (!/^[a-f0-9]{32}$/.test(machineId)) refuse("HOST_ID_UNAVAILABLE", "machine id unreadable");
  const kernelRelease = io.readFile(LINUX_PATHS.kernelRelease).toString("utf8").trim();
  if (!/^[\x21-\x7e]{1,256}$/.test(kernelRelease))
    refuse("HOST_KERNEL_UNAVAILABLE", "kernel release unreadable");
  let chronycSha256 = "";
  let chronydSha256 = "";
  try {
    chronycSha256 = sha256Hex(io.readFile(profile.chronycPath));
    chronydSha256 = sha256Hex(io.readFile(LINUX_PATHS.chronyd));
  } catch {
    // systemd-timesyncd hosts have no chronyc/chronyd: they cannot be a qualified clock.
    refuse("CLOCK_SOURCE_NOT_INSTALLED", "chronyc/chronyd not present at the approved paths");
  }
  const configurationFiles: string[] = [LINUX_PATHS.chronyConfiguration];
  for (const directory of LINUX_PATHS.chronyConfigurationDirectories)
    for (const name of io.listRegularFiles(directory) ?? [])
      configurationFiles.push(`${directory}/${name}`);
  let chronyConfiguration: { path: string; sha256: string }[] = [];
  try {
    chronyConfiguration = configurationFiles.map((path) => ({
      path,
      sha256: sha256Hex(io.readFile(path)),
    }));
  } catch {
    refuse("CLOCK_CONFIGURATION_UNAVAILABLE", "chrony configuration unreadable");
  }
  let versionOutput = "";
  try {
    const result = await io.exec(profile.chronycPath, ["--version"], profile.maxAcquireMs);
    if (result.exitCode !== 0) throw Error();
    versionOutput = result.stdout.trim();
  } catch {
    refuse("CLOCK_SOURCE_UNAVAILABLE", "chronyc --version failed");
  }
  // Two time daemons disciplining one clock invalidate the chrony bound.
  let timesyncd = "";
  try {
    timesyncd = (
      await io.exec(LINUX_PATHS.systemctl, ["is-active", "systemd-timesyncd.service"], 5000)
    ).stdout.trim();
  } catch {
    refuse("HOST_SERVICE_STATE_UNAVAILABLE", "systemctl unavailable");
  }
  if (timesyncd === "active" || timesyncd === "activating" || timesyncd === "reloading")
    refuse("CLOCK_SOURCE_CONFLICT", "systemd-timesyncd is active alongside chrony");
  const configuration: HostConfigurationV1 = Object.freeze({
    contract: HOST_CONFIGURATION_CONTRACT,
    machineId,
    kernelRelease,
    chronyc: Object.freeze({
      path: profile.chronycPath,
      sha256: chronycSha256,
      socketPath: profile.chronycSocketPath,
      versionOutput,
    }),
    chronyd: Object.freeze({ path: LINUX_PATHS.chronyd, sha256: chronydSha256 }),
    chronyConfiguration: Object.freeze(chronyConfiguration),
    referenceIds: Object.freeze([...profile.referenceIds]),
    clockPolicySha256: clockPolicyFingerprint(policy),
  });
  return Object.freeze({
    bootId,
    hostId: machineId,
    configuration,
    configurationHash: hostConfigurationHash(configuration),
    chronycSha256,
    chronydSha256,
    timesyncd,
  });
}

/** The qualified CURRENT registry entry must describe exactly the measured host. */
export function assertHostMatchesEntry(
  measured: HostMeasurement,
  entry: Pick<ConsentHostAuthorityEntry, "profile" | "chronycSha256" | "chronydSha256">,
) {
  const p = entry.profile;
  if (p.approvedBootId !== measured.bootId)
    refuse("HOST_BOOT_NOT_QUALIFIED", "running boot is not the qualified boot");
  if (p.hostId !== measured.hostId) refuse("HOST_ID_MISMATCH", "machine id differs");
  if (p.configurationHash !== measured.configurationHash)
    refuse("HOST_CONFIGURATION_MISMATCH", "measured configurationHash differs");
  if (
    entry.chronycSha256 !== measured.chronycSha256 ||
    entry.chronydSha256 !== measured.chronydSha256
  )
    refuse("CLOCK_BINARY_MISMATCH", "chrony binaries differ from the qualified hashes");
  if (p.chronycVersionOutput !== measured.configuration.chronyc.versionOutput)
    refuse("CLOCK_VERSION_MISMATCH", "chronyc version output differs");
}

/** Same acceptance rules as the API's `parseQualifiedChronyTracking` (host-clock.ts), which
 * the tool must not import because that module wires the shipped authority at load. Parity is
 * enforced by tests. */
export function parseChronyTracking(output: string, p: HostProfile, wallMs: number) {
  const f = output
    .trim()
    .split(",")
    .map((v) => v.trim());
  const numeric = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  if (
    f.length !== 14 ||
    !p.referenceIds.includes(f[0] ?? "") ||
    f[0] === "7F7F0101" ||
    f[13] !== "Normal" ||
    numeric.some((n) => !f[n] || !Number.isFinite(Number(f[n]))) ||
    !Number.isInteger(Number(f[2])) ||
    Number(f[2]) < 1 ||
    Number(f[2]) > 15 ||
    Number(f[9]) < 0 ||
    Number(f[9]) > p.maxDriftPpm
  )
    return refuse("CLOCK_NOT_SYNCHRONISED", "chrony source/format/synchronisation unavailable");
  const referenceTimeMs = Number(f[3]) * 1000;
  if (wallMs < referenceTimeMs || wallMs - referenceTimeMs > p.maxSampleAgeMs)
    return refuse("CLOCK_SAMPLE_STALE", "chrony reference sample is stale");
  const bound = chronyClockBound(
    {
      systemClockMs: wallMs,
      leapStatus: "Normal",
      systemTimeOffsetSeconds: Number(f[4]),
      rootDelaySeconds: Number(f[10]),
      rootDispersionSeconds: Number(f[11]),
    },
    p.maxErrorMs,
  );
  if (bound.kind !== "BOUND")
    return refuse("CLOCK_ERROR_TOO_LARGE", "chrony uncertainty exceeds the approved bound");
  return { referenceId: f[0] as string, referenceTimeMs, bound };
}

export type ClockEvidence = Readonly<{
  version: 1;
  source: "chrony-tracking-v1";
  bootId: string;
  wallBeforeMs: number;
  wallAfterMs: number;
  acquiredMs: number;
  versionOutput: string;
  tracking: string;
  referenceId: string;
  referenceTimeMs: number;
  errorMs: number;
  paddingMs: number;
  earliestMs: number;
  latestMs: number;
}>;

/**
 * Trusted-time evidence through the approved chrony interface, with the same acquisition rules
 * as the API's `observeConsentHost`: same boot before and after, bounded monotonic acquisition,
 * pinned version output, approved reference ids, sample age, drift and error limits, and drift
 * padding. Ordinary "synchronized" status is never accepted on its own.
 */
export async function collectClockEvidence(io: HostIo, p: HostProfile): Promise<ClockEvidence> {
  const bootBefore = readBootId(io);
  if (bootBefore !== p.approvedBootId)
    refuse("HOST_BOOT_NOT_QUALIFIED", "running boot is not the qualified boot");
  const monoBefore = io.monotonicNs();
  const wallBeforeMs = io.wallMs();
  let version: { stdout: string; exitCode: number };
  let tracking: { stdout: string; exitCode: number };
  try {
    version = await io.exec(p.chronycPath, ["--version"], p.maxAcquireMs);
    tracking = await io.exec(
      p.chronycPath,
      ["-h", p.chronycSocketPath, "-n", "-c", "tracking"],
      p.maxAcquireMs,
    );
  } catch {
    return refuse("CLOCK_SOURCE_UNAVAILABLE", "chronyc did not answer within maxAcquireMs");
  }
  const wallAfterMs = io.wallMs();
  const monoAfter = io.monotonicNs();
  const bootAfter = readBootId(io);
  const acquiredMs = Number(monoAfter - monoBefore) / 1e6;
  if (
    version.exitCode !== 0 ||
    tracking.exitCode !== 0 ||
    bootAfter !== bootBefore ||
    version.stdout.trim() !== p.chronycVersionOutput ||
    !(acquiredMs >= 0) ||
    acquiredMs > p.maxAcquireMs
  )
    refuse("CLOCK_ACQUISITION_FAILED", "discontinuity, version or acquisition failure");
  const { referenceId, referenceTimeMs, bound } = parseChronyTracking(
    tracking.stdout,
    p,
    wallAfterMs,
  );
  const paddingMs = Math.ceil(acquiredMs * (1 + p.maxDriftPpm / 1e6));
  if (
    Math.abs(wallAfterMs - wallBeforeMs - acquiredMs) > bound.errorMs + paddingMs ||
    bound.errorMs + paddingMs > p.maxErrorMs
  )
    refuse("CLOCK_STEP_DETECTED", "clock step or unbounded acquisition");
  return Object.freeze({
    version: 1,
    source: "chrony-tracking-v1",
    bootId: bootAfter,
    wallBeforeMs,
    wallAfterMs,
    acquiredMs,
    versionOutput: version.stdout.trim(),
    tracking: tracking.stdout.trim(),
    referenceId,
    referenceTimeMs,
    errorMs: bound.errorMs,
    paddingMs,
    earliestMs: bound.earliestMs - paddingMs,
    latestMs: bound.latestMs + paddingMs,
  });
}
