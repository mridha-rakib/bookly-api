/** BC-F05C LOCAL ACCEPTANCE consent authority — NON-PRODUCTION, LOW ASSURANCE.
 * Unauthenticated Windows wall clock with a declared bound. Its evidence is sealed with a
 * per-installation key that no production registry holds, so the shipped verifier rejects it. */
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashCanonicalPackageCheckoutContent as digest } from "../../src/modules/booking/package-checkout-binding.js";
import type { HostObservation } from "../../src/modules/booking/trusted-time/host-clock.js";
import type { QualifiedConsentHost } from "../../src/modules/booking/trusted-time/qualified-host.js";
import { LocalAcceptanceRefusal } from "./guards.js";

export const LOCAL_AUTHORITY_ID = "bookly-local-acceptance-NONPRODUCTION";
export const LOCAL_VERSION_OUTPUT = "bookly-local-acceptance-windows-clock-NONPRODUCTION";
export const LOCAL_REFERENCE_ID = "LOCAL-WINDOWS-CLOCK";
/** Declared, not measured: the Windows clock is not qualified. */
export const LOCAL_DECLARED_ERROR_MS = 1000;

const MARKER = Symbol.for("bookly.localAcceptance.composed");
type Composed = { host: QualifiedConsentHost };

/** Set only by dev/local-acceptance/server.ts after every startup guard passed. */
export function markLocalAcceptanceComposed(host: QualifiedConsentHost) {
  (globalThis as Record<symbol, unknown>)[MARKER] = Object.freeze({ host } satisfies Composed);
}

export function assertLocalAcceptanceComposed(): QualifiedConsentHost {
  const composed = (globalThis as Record<symbol, unknown>)[MARKER] as Composed | undefined;
  if (!composed)
    throw new LocalAcceptanceRefusal("local acceptance entry point did not compose this process");
  return composed.host;
}

type IdentityFile = { installationId: string; bootId: string; createdAt: string; label: string };

export function loadLocalAuthority(dir: string): QualifiedConsentHost {
  let identity: IdentityFile;
  let key: Buffer;
  try {
    identity = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8")) as IdentityFile;
    key = Buffer.from(readFileSync(join(dir, "authority.key"), "utf8").trim(), "hex");
  } catch {
    throw new LocalAcceptanceRefusal(
      "local authority files missing; run dev/local-acceptance/init-authority.ts",
    );
  }
  if (
    identity.label !== LOCAL_AUTHORITY_ID ||
    !/^[a-f0-9]{32}$/.test(identity.installationId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      identity.bootId,
    ) ||
    key.length < 32
  )
    throw new LocalAcceptanceRefusal("local authority identity or key is invalid");
  const policy = {
    authorityId: LOCAL_AUTHORITY_ID,
    hostId: `local-acceptance:${identity.installationId}`,
    clock: "windows-wall-clock-unauthenticated",
    declaredErrorMs: LOCAL_DECLARED_ERROR_MS,
  };
  return {
    approvedBootId: identity.bootId,
    authorityId: LOCAL_AUTHORITY_ID,
    hostId: policy.hostId,
    configurationHash: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
    chronycPath: "/local-acceptance/no-chrony",
    chronycSocketPath: "/local-acceptance/no-chrony-socket",
    chronycVersionOutput: LOCAL_VERSION_OUTPUT,
    referenceIds: [LOCAL_REFERENCE_ID],
    maxAcquireMs: 5000,
    maxSampleAgeMs: 10000,
    maxErrorMs: LOCAL_DECLARED_ERROR_MS,
    maxDriftPpm: 500,
    minRemainingMs: 1000,
    auditKey: key,
  };
}

/** Same payload/seal format the shipped verifier checks; only the clock source differs. */
export function observeLocalAcceptanceClock(
  host: QualifiedConsentHost,
  witnessHash: string,
): HostObservation {
  const now = Date.now();
  const payload = {
    version: 1 as const,
    authorityId: host.authorityId,
    hostId: host.hostId,
    configurationHash: host.configurationHash,
    bootId: host.approvedBootId,
    witnessHash,
    earliestMs: now - LOCAL_DECLARED_ERROR_MS,
    latestMs: now + LOCAL_DECLARED_ERROR_MS,
    acquiredMs: 1,
    referenceId: LOCAL_REFERENCE_ID,
    referenceTimeMs: now,
    tracking: "local acceptance: unauthenticated Windows wall clock (NON-PRODUCTION)",
    versionOutput: host.chronycVersionOutput,
  };
  const seal = createHmac("sha256", host.auditKey)
    .update("bookly:consent-host-observation:v1\0")
    .update(digest(payload))
    .digest("hex");
  return { ...payload, seal };
}
