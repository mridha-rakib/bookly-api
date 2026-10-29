import {
  assessConsentCommitDeadline,
  type ConsentCommitDeadlineResult,
  type TrustedTimeInterval,
} from "../package-consent-commit-deadline.js";
import type { ChronyBoundResult } from "./chrony-bound.js";
import type { QuorumResult } from "./roughtime-quorum.js";
import { roughtimeHash } from "./roughtime-wire.js";

/**
 * P1B — free dual time authority (candidate for Owner decision D7): Roughtime quorum AND the
 * local chrony bound. The combined interval is the ENVELOPE of both (earliest of the lower
 * bounds, latest of the upper bounds), so a commit is certified only if BOTH sources put it
 * before the deadline, and issuance is anchored at the earlier of both lower bounds.
 *
 * Connected to the P1A verifier, whose shipped registry is EMPTY: every shipped result is
 * UNRESOLVED("TIME_AUTHORITY_NOT_APPROVED"). This module does not persist, authorize or
 * activate anything.
 */

export const DUAL_AUTHORITY_ID = "free-dual-authority-v1";

export type DualAuthorityOutcome =
  | { kind: "INTERVAL"; interval: TrustedTimeInterval }
  | { kind: "UNAVAILABLE"; roughtime: string; chrony: string };

/**
 * ISSUANCE: both measured just BEFORE the quote is created; the lower bound is the earlier of
 * the two (only `earliestMs` is relied on). COMMIT: both measured AFTER the commit was
 * majority-observed; the upper bound is the later of the two (only `latestMs` is relied on).
 */
export const combineDualAuthority = (
  roughtime: QuorumResult | undefined,
  chrony: ChronyBoundResult | undefined,
  phase: "ISSUANCE" | "COMMIT",
): DualAuthorityOutcome => {
  if (roughtime?.kind !== "QUORUM" || chrony?.kind !== "BOUND")
    return {
      kind: "UNAVAILABLE",
      roughtime: roughtime ? (roughtime.kind === "QUORUM" ? "OK" : roughtime.reason) : "MISSING",
      chrony: chrony ? (chrony.kind === "BOUND" ? "OK" : chrony.reason) : "MISSING",
    };
  if (phase === "ISSUANCE") {
    const earliestMs = Math.min(roughtime.lowerBoundMs, chrony.earliestMs);
    return {
      kind: "INTERVAL",
      interval: {
        authorityId: DUAL_AUTHORITY_ID,
        earliestMs,
        latestMs: Math.max(earliestMs, roughtime.upperBoundMs, chrony.latestMs),
      },
    };
  }
  const latestMs = Math.max(roughtime.upperBoundMs, chrony.latestMs);
  return {
    kind: "INTERVAL",
    interval: {
      authorityId: DUAL_AUTHORITY_ID,
      earliestMs: Math.min(latestMs, roughtime.lowerBoundMs, chrony.earliestMs),
      latestMs,
    },
  };
};

/**
 * Evaluates the strict 30-minute rule with dual-authority evidence:
 *  - issuance: measured BEFORE the quote was created (its lower bound anchors the window);
 *  - commit: measured AFTER the acceptance commit was majority-observed, with a nonce bound to
 *    that observation (its upper bound bounds the commit).
 * `approvedAuthorities` defaults to the shipped empty registry.
 */
export const assessCommitWithDualAuthority = (
  input: {
    retainedIssuedAtMs: number;
    retainedExpiresAtMs: number;
    issuance: { roughtime?: QuorumResult; chrony?: ChronyBoundResult };
    commit: { roughtime?: QuorumResult; chrony?: ChronyBoundResult };
  },
  approvedAuthorities?: readonly string[],
): ConsentCommitDeadlineResult => {
  const { issuance: i, commit: c } = input;
  const issuance = combineDualAuthority(i.roughtime, i.chrony, "ISSUANCE");
  const commit = combineDualAuthority(c.roughtime, c.chrony, "COMMIT");
  return assessConsentCommitDeadline(
    {
      retainedIssuedAtMs: input.retainedIssuedAtMs,
      retainedExpiresAtMs: input.retainedExpiresAtMs,
      ...(issuance.kind === "INTERVAL" ? { issuanceAttestation: issuance.interval } : {}),
      ...(commit.kind === "INTERVAL" ? { postCommitObservation: commit.interval } : {}),
    },
    ...(approvedAuthorities ? [approvedAuthorities] : []),
  );
};

const WITNESS_DIGEST_DOMAIN = Buffer.from("bookly consent commit witness v1\0", "latin1");

/**
 * Canonical 32-byte digest of the majority-observed committed consent (identifiers and hashes
 * only — no names, emails or amounts). Its exact field set is part of the schema proposal and
 * needs approval before use.
 */
export const consentCommitWitnessDigest = (fields: Readonly<Record<string, string>>): Buffer => {
  const keys = Object.keys(fields).sort();
  if (keys.length === 0) throw new Error("witness fields required");
  const canonical = JSON.stringify(keys.map((key) => [key, fields[key]]));
  return roughtimeHash(WITNESS_DIGEST_DOMAIN, Buffer.from(canonical, "utf8"));
};
