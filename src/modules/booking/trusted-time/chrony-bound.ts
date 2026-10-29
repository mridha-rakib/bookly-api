/**
 * P1B — local host-clock bound from chrony tracking values. Pure: the caller (a trusted-host
 * adapter, NOT implemented here) must read `chronyc tracking` and the system clock at the same
 * instant. The exact output format must be verified on the installed chrony version before
 * any adapter is written.
 *
 * chrony documentation (`chronyc tracking`): "An absolute bound on the computer's clock
 * accuracy (assuming the stratum-1 computer is correct) is given by:
 * clock_error <= |system_time_offset| + root_dispersion + (0.5 * root_delay)".
 *
 * This is SELF-ATTESTED local evidence. It is only ever used AND-combined with the Roughtime
 * quorum (dual-authority.ts), never alone.
 */

export const CHRONY_AUTHORITY_ID = "chrony-local-bound-v1";

export type ChronyTrackingSample = {
  /** Local system clock at the moment the tracking values were read (ms since epoch). */
  systemClockMs: number;
  /** chronyc "Leap status". Anything but "Normal" refuses (incl. "Not synchronised"). */
  leapStatus: string;
  systemTimeOffsetSeconds: number;
  rootDelaySeconds: number;
  rootDispersionSeconds: number;
};

export type ChronyBoundResult =
  | { kind: "BOUND"; earliestMs: number; latestMs: number; errorMs: number }
  | { kind: "UNRESOLVED"; reason: "NOT_SYNCHRONISED" | "INVALID_SAMPLE" | "ERROR_TOO_LARGE" };

export const chronyClockBound = (
  sample: ChronyTrackingSample,
  maxErrorMs: number,
): ChronyBoundResult => {
  if (sample.leapStatus !== "Normal") return { kind: "UNRESOLVED", reason: "NOT_SYNCHRONISED" };
  const finite = [
    sample.systemClockMs,
    sample.systemTimeOffsetSeconds,
    sample.rootDelaySeconds,
    sample.rootDispersionSeconds,
  ].every(Number.isFinite);
  if (
    !finite ||
    !Number.isSafeInteger(sample.systemClockMs) ||
    sample.rootDelaySeconds < 0 ||
    sample.rootDispersionSeconds < 0
  )
    return { kind: "UNRESOLVED", reason: "INVALID_SAMPLE" };
  const errorSeconds =
    Math.abs(sample.systemTimeOffsetSeconds) +
    sample.rootDispersionSeconds +
    0.5 * sample.rootDelaySeconds;
  // Normalise float noise at nanosecond precision, round UP to whole ms, then add 1 ms for the
  // clock-read granularity (which also covers the sub-ns normalisation): never narrower.
  const errorMs = Math.ceil(Math.round(errorSeconds * 1e9) / 1e6) + 1;
  if (errorMs > maxErrorMs) return { kind: "UNRESOLVED", reason: "ERROR_TOO_LARGE" };
  return {
    kind: "BOUND",
    earliestMs: sample.systemClockMs - errorMs,
    latestMs: sample.systemClockMs + errorMs,
    errorMs,
  };
};
