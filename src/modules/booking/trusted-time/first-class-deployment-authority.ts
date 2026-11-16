import { isDeepStrictEqual } from "node:util";
import {
  type FirstClassAuthorityFiles,
  type IndependentObservation,
  type VerifiedFirstClassAuthority,
  verifyFirstClassDeploymentAuthority,
} from "./deployment-attestation.js";
import {
  FIRST_CLASS_AUTHORITY_DIRECTORY,
  observeRunningArtifact,
  readFirstClassAuthorityFiles,
} from "./protected-authority-files.js";

/** Files re-read on every live check: a renewed attestation (and a replaced deployment key)
 * take effect without restart. The release record and approval anchor are pinned at startup. */
const LIVE_FILES = ["deploymentPublicKeyPem", "attestation", "attestationSignature"] as const;
type LiveFiles = Pick<FirstClassAuthorityFiles, (typeof LIVE_FILES)[number]>;

export type FirstClassAuthorityIo = Readonly<{
  readFiles: () => FirstClassAuthorityFiles;
  readLiveFiles: () => LiveFiles;
  observe: () => IndependentObservation;
  now: () => number;
}>;

const fresh = (verified: VerifiedFirstClassAuthority, nowMs: number) =>
  Number.isSafeInteger(nowMs) &&
  nowMs >= verified.attestation.earliestMs &&
  nowMs < verified.attestation.expiresAtMs;

/**
 * Process-local view of the independent deployment authority.
 *
 * Startup: all six protected inputs plus the API's own observation must verify and be fresh,
 * otherwise the process holds no authority until restart (fail closed). The verified release
 * record digest, host composition and observation are then pinned for the process lifetime.
 *
 * Live (`readLive`): re-reads the attestation and deployment key, re-verifies the whole chain
 * against the pinned observation and requires: same release record and host composition,
 * fresh validity window, and a sequence never lower than the highest one accepted (with
 * identical content on equal sequence). Any failure returns `undefined` for that call.
 * Rollback across restarts is bounded by expiry and boot binding; a stale attestation can be
 * replayed only by an actor who can already write the root-owned authority directory.
 */
export function createFirstClassDeploymentAuthority(io: FirstClassAuthorityIo) {
  let pinned:
    | Readonly<{
        files: FirstClassAuthorityFiles;
        observed: IndependentObservation;
        verified: VerifiedFirstClassAuthority;
      }>
    | undefined;
  try {
    const files = io.readFiles();
    const observed = io.observe();
    const verified = verifyFirstClassDeploymentAuthority(files, observed);
    if (fresh(verified, io.now())) pinned = Object.freeze({ files, observed, verified });
  } catch {
    pinned = undefined;
  }
  let highest = pinned?.verified.attestation;
  let cache: { live: LiveFiles; verified: VerifiedFirstClassAuthority } | undefined;

  const readLive = (): VerifiedFirstClassAuthority | undefined => {
    if (!pinned || !highest) return undefined;
    try {
      const live = io.readLiveFiles();
      const verified =
        cache && LIVE_FILES.every((name) => cache?.live[name].equals(live[name]))
          ? cache.verified
          : verifyFirstClassDeploymentAuthority({ ...pinned.files, ...live }, pinned.observed);
      cache = { live, verified };
      const { attestation } = verified;
      if (
        verified.recordSha256 !== pinned.verified.recordSha256 ||
        !isDeepStrictEqual(verified.release, pinned.verified.release) ||
        !isDeepStrictEqual(verified.host, pinned.verified.host) ||
        attestation.sequence < highest.sequence ||
        (attestation.sequence === highest.sequence && attestation.sha256 !== highest.sha256) ||
        !fresh(verified, io.now())
      )
        return undefined;
      highest = attestation;
      return verified;
    } catch {
      return undefined;
    }
  };

  return Object.freeze({
    /** Host composition authenticated at startup; `undefined` when startup verification failed. */
    hostConfiguration: pinned?.verified.host,
    readLive,
  });
}

const shippedIo: FirstClassAuthorityIo = Object.freeze({
  readFiles: () =>
    readFirstClassAuthorityFiles(FIRST_CLASS_AUTHORITY_DIRECTORY) as FirstClassAuthorityFiles,
  readLiveFiles: () =>
    readFirstClassAuthorityFiles(FIRST_CLASS_AUTHORITY_DIRECTORY, LIVE_FILES) as LiveFiles,
  observe: observeRunningArtifact,
  now: () => Date.now(),
});

const shipped = createFirstClassDeploymentAuthority(shippedIo);

/** The shipped, fixed-location authority. On a host without the provisioned handoff (every
 * non-Linux host, development, CI) startup fails and both values deny. */
export const pinnedFirstClassHostConfiguration = shipped.hostConfiguration;
export const readLiveFirstClassAuthority = shipped.readLive;
