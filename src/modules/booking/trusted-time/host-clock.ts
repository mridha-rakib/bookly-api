import { execFile } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { hashCanonicalPackageCheckoutContent as digest } from "../package-checkout-binding.js";
import { chronyClockBound } from "./chrony-bound.js";
import { validateConsentHostPolicy as policy, validateConsentHostBoot } from "./host-policy.js";
import {
  type QualifiedConsentHost,
  requireConsentHostVerificationProfile,
  requireQualifiedConsentHost,
} from "./qualified-host.js";

const exec = promisify(execFile);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const hostObservationSchema = z
  .object({
    version: z.literal(1),
    authorityId: z.string().min(1),
    hostId: z.string().min(1),
    configurationHash: hash,
    bootId: z.uuid(),
    witnessHash: hash,
    earliestMs: z.number().int().safe().nonnegative(),
    latestMs: z.number().int().safe(),
    acquiredMs: z.number().nonnegative(),
    referenceId: z.string(),
    referenceTimeMs: z.number().nonnegative(),
    tracking: z.string().min(1),
    versionOutput: z.string().min(1),
    seal: hash,
  })
  .strict();
export type HostObservation = z.infer<typeof hostObservationSchema>;
const seal = (payload: object, profile: QualifiedConsentHost) =>
  createHmac("sha256", profile.auditKey)
    .update("bookly:consent-host-observation:v1\0")
    .update(digest(payload))
    .digest("hex");

/** chrony 4.6 and 4.8 client.c emit reference ID AND address as separate CSV fields.
 * The deployed version/layout must be pinned and independently qualified. */
export function parseQualifiedChronyTracking(
  output: string,
  p: QualifiedConsentHost,
  wallMs: number,
) {
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
    throw Error("Consent clock source/format/synchronisation unavailable");
  const referenceTimeMs = Number(f[3]) * 1000;
  if (wallMs < referenceTimeMs || wallMs - referenceTimeMs > p.maxSampleAgeMs)
    throw Error("Stale consent clock sample");
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
  if (bound.kind !== "BOUND") throw Error("Consent clock uncertainty exceeds qualified bound");
  return { referenceId: f[0]!, referenceTimeMs, bound };
}

/** Local trusted-host evidence, not externally attested UTC. No default bounds are invented.
 * Target qualification must validate this exact chronyc CSV layout and host/source controls. */
export async function observeConsentHost(witnessHash: string): Promise<HostObservation> {
  hash.parse(witnessHash);
  const p = requireQualifiedConsentHost();
  policy(p);
  if (process.platform !== "linux") throw Error("Qualified consent host must be Linux");
  const bootBefore = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  validateConsentHostBoot(p, bootBefore, bootBefore);
  const monoBefore = process.hrtime.bigint(),
    wallBefore = Date.now();
  const version = await exec(p.chronycPath, ["--version"], {
    timeout: p.maxAcquireMs,
    maxBuffer: 16384,
  });
  const tracking = await exec(p.chronycPath, ["-h", p.chronycSocketPath, "-n", "-c", "tracking"], {
    timeout: p.maxAcquireMs,
    maxBuffer: 16384,
  });
  const wallAfter = Date.now(),
    monoAfter = process.hrtime.bigint();
  const bootAfter = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  validateConsentHostBoot(p, bootBefore, bootAfter);
  const elapsed = Number(monoAfter - monoBefore) / 1e6;
  if (
    bootBefore !== bootAfter ||
    version.stdout.trim() !== p.chronycVersionOutput ||
    elapsed > p.maxAcquireMs ||
    elapsed < 0
  )
    throw Error("Consent host discontinuity/version/acquisition failure");
  const { referenceId, referenceTimeMs, bound } = parseQualifiedChronyTracking(
    tracking.stdout,
    p,
    wallAfter,
  );
  const padding = Math.ceil(elapsed * (1 + p.maxDriftPpm / 1e6));
  if (
    Math.abs(wallAfter - wallBefore - elapsed) > bound.errorMs + padding ||
    bound.errorMs + padding > p.maxErrorMs
  )
    throw Error("Clock step or unbounded acquisition detected");
  const payload = {
    version: 1 as const,
    authorityId: p.authorityId,
    hostId: p.hostId,
    configurationHash: p.configurationHash,
    bootId: bootAfter,
    witnessHash,
    earliestMs: bound.earliestMs - padding,
    latestMs: bound.latestMs + padding,
    acquiredMs: elapsed,
    referenceId,
    referenceTimeMs,
    tracking: tracking.stdout.trim(),
    versionOutput: version.stdout.trim(),
  };
  return hostObservationSchema.parse({ ...payload, seal: seal(payload, p) });
}

export function verifyConsentHostObservation(input: unknown, witnessHash: string): HostObservation {
  const value = hostObservationSchema.parse(input),
    { seal: signature, ...payload } = value;
  const p = requireConsentHostVerificationProfile({
    authorityId: value.authorityId,
    hostId: value.hostId,
    configurationHash: value.configurationHash,
    approvedBootId: value.bootId,
  });
  policy(p);
  if (
    value.bootId !== p.approvedBootId ||
    value.witnessHash !== witnessHash ||
    value.authorityId !== p.authorityId ||
    value.hostId !== p.hostId ||
    value.configurationHash !== p.configurationHash ||
    value.versionOutput !== p.chronycVersionOutput ||
    !p.referenceIds.includes(value.referenceId) ||
    value.acquiredMs > p.maxAcquireMs ||
    value.earliestMs > value.latestMs ||
    value.latestMs - value.earliestMs > 2 * p.maxErrorMs ||
    !timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(seal(payload, p), "hex"))
  )
    throw Error("Unqualified or altered consent observation");
  return value;
}
