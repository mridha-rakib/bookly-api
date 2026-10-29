import { randomBytes } from "node:crypto";

import type { TrustedTimeInterval } from "../package-consent-commit-deadline.js";
import { type VerifiedRoughtimeResponse, verifyRoughtimeResponse } from "./roughtime-verify.js";
import { decodeMessage, decodePacket, required, roughtimeHash } from "./roughtime-wire.js";

/**
 * P1B — multi-server Roughtime measurement (RFC 10049 §8.2) as verifiable evidence.
 *
 * Nonce chain: the first nonce binds a caller-supplied 32-byte witness digest (e.g. of the
 * majority-observed committed consent) with fresh randomness; every later nonce is
 * H(previous response packet || rand). Every response was therefore produced after the
 * witness existed. Raw packets + rand values are the evidence and can be re-verified offline.
 *
 * Pinned keys come ONLY from the caller's pin list, never from the evidence. No pin in this
 * repository is approved for production (D7); see roughtime-servers.ts.
 */

const WITNESS_DOMAIN = Buffer.from("bookly roughtime witness v1\0", "latin1");

export const QUORUM_AUTHORITY_ID = "roughtime-quorum-v1";

export type RoughtimeServerPin = {
  serverId: string;
  /** Independent operator identity. Two servers of one operator count once. */
  operatorId: string;
  /** Raw 32-byte Ed25519 long-term public key. */
  longTermPublicKey: Buffer;
};

export type RoughtimeEvidenceEntry = {
  serverId: string;
  /** 32 random bytes used to derive this entry's nonce. */
  rand: Buffer;
  requestPacket: Buffer;
  responsePacket: Buffer;
  /** Locally measured request→response time (monotonic clock); optional diagnostics. */
  roundTripMs?: number | undefined;
};

export const freshRand = (): Buffer => randomBytes(32);

export const witnessNonce = (witnessDigest: Buffer, rand: Buffer): Buffer => {
  if (witnessDigest.length !== 32 || rand.length !== 32)
    throw new Error("witness digest and rand must be 32 bytes");
  return roughtimeHash(WITNESS_DOMAIN, witnessDigest, rand);
};

/** RFC 10049 §8.2: H(resp || rand) for every query after the first. */
export const chainedNonce = (previousResponsePacket: Buffer, rand: Buffer): Buffer => {
  if (rand.length !== 32) throw new Error("rand must be 32 bytes");
  return roughtimeHash(previousResponsePacket, rand);
};

export type QuorumUnresolvedReason =
  | "NO_EVIDENCE"
  | "UNKNOWN_SERVER"
  | "NONCE_CHAIN_BROKEN"
  | "RESPONSE_INVALID"
  | "ROUND_TRIP_TOO_LONG"
  | "SEQUENCE_ORDER_INVALID"
  | "CAUSALLY_INCONSISTENT"
  | "INSUFFICIENT_INDEPENDENT_OPERATORS";

export type QuorumResult =
  | {
      kind: "QUORUM";
      /**
       * f-tolerant LOWER bound valid for any event that happened AFTER the whole sequence was
       * received (e.g. quote issuance measured just before creating the quote).
       */
      lowerBoundMs: number;
      /**
       * f-tolerant UPPER bound valid for any event that happened BEFORE the first nonce was
       * generated (e.g. the majority-observed consent commit).
       * The sequence spans real time, so lowerBoundMs may legitimately exceed upperBoundMs;
       * each bound is only meaningful for its own direction.
       */
      upperBoundMs: number;
      operators: string[];
      observations: Array<{ serverId: string; verified: VerifiedRoughtimeResponse }>;
    }
  | { kind: "UNRESOLVED"; reason: QuorumUnresolvedReason; detail?: string };

/** Interval for the P1A verifier's `issuanceAttestation` (only `earliestMs` is relied on). */
export const issuanceIntervalOf = (
  result: Extract<QuorumResult, { kind: "QUORUM" }>,
): TrustedTimeInterval => ({
  authorityId: QUORUM_AUTHORITY_ID,
  earliestMs: result.lowerBoundMs,
  latestMs: Math.max(result.lowerBoundMs, result.upperBoundMs),
});

/** Interval for the P1A verifier's `postCommitObservation` (only `latestMs` is relied on). */
export const commitIntervalOf = (
  result: Extract<QuorumResult, { kind: "QUORUM" }>,
): TrustedTimeInterval => ({
  authorityId: QUORUM_AUTHORITY_ID,
  earliestMs: Math.min(result.lowerBoundMs, result.upperBoundMs),
  latestMs: result.upperBoundMs,
});

const unresolved = (reason: QuorumUnresolvedReason, detail?: string): QuorumResult => ({
  kind: "UNRESOLVED",
  reason,
  ...(detail ? { detail } : {}),
});

export type QuorumPolicy = {
  /** Maximum number of lying/faulty operators tolerated. */
  faultTolerance: number;
  /** RFC 10049 §8.1: at least three operational servers not run by the same parties. */
  minIndependentOperators: number;
  /** RFC 10049 §8.2: repeat the sequence twice in the same order. */
  rounds: number;
  maxRoundTripMs?: number | undefined;
};

export const DEFAULT_QUORUM_POLICY: QuorumPolicy = Object.freeze({
  faultTolerance: 1,
  minIndependentOperators: 3,
  rounds: 2,
});

/**
 * Re-verifies a complete measurement sequence from raw evidence. Pure and deterministic; it is
 * equally valid at measurement time and in a later offline audit.
 */
export const evaluateRoughtimeQuorum = (input: {
  witnessDigest: Buffer;
  evidence: readonly RoughtimeEvidenceEntry[];
  pins: readonly RoughtimeServerPin[];
  policy?: QuorumPolicy;
}): QuorumResult => {
  const policy = input.policy ?? DEFAULT_QUORUM_POLICY;
  const { evidence } = input;
  if (evidence.length === 0) return unresolved("NO_EVIDENCE");
  if (input.witnessDigest.length !== 32) return unresolved("NONCE_CHAIN_BROKEN");

  // Same server order in every round (RFC 10049 §8.2).
  if (evidence.length % policy.rounds !== 0) return unresolved("SEQUENCE_ORDER_INVALID");
  const perRound = evidence.length / policy.rounds;
  for (let i = perRound; i < evidence.length; i += 1)
    if (evidence[i]?.serverId !== evidence[i % perRound]?.serverId)
      return unresolved("SEQUENCE_ORDER_INVALID");
  if (new Set(evidence.slice(0, perRound).map((e) => e.serverId)).size !== perRound)
    return unresolved("SEQUENCE_ORDER_INVALID");

  const observations: Array<{
    serverId: string;
    operatorId: string;
    verified: VerifiedRoughtimeResponse;
  }> = [];
  for (let k = 0; k < evidence.length; k += 1) {
    const entry = evidence[k] as RoughtimeEvidenceEntry;
    const pin = input.pins.find((p) => p.serverId === entry.serverId);
    if (!pin) return unresolved("UNKNOWN_SERVER", entry.serverId);
    let sentNonce: Buffer;
    try {
      sentNonce = required(decodeMessage(decodePacket(entry.requestPacket)), "NONC");
    } catch {
      return unresolved("NONCE_CHAIN_BROKEN", entry.serverId);
    }
    const expectedNonce =
      k === 0
        ? witnessNonce(input.witnessDigest, entry.rand)
        : chainedNonce((evidence[k - 1] as RoughtimeEvidenceEntry).responsePacket, entry.rand);
    if (!sentNonce.equals(expectedNonce)) return unresolved("NONCE_CHAIN_BROKEN", entry.serverId);
    const verified = verifyRoughtimeResponse({
      requestPacket: entry.requestPacket,
      responsePacket: entry.responsePacket,
      longTermPublicKey: pin.longTermPublicKey,
    });
    if (!verified.ok) return unresolved("RESPONSE_INVALID", `${entry.serverId}:${verified.reason}`);
    if (
      policy.maxRoundTripMs !== undefined &&
      (entry.roundTripMs === undefined || entry.roundTripMs > policy.maxRoundTripMs)
    )
      return unresolved("ROUND_TRIP_TOO_LONG", entry.serverId);
    observations.push({ serverId: entry.serverId, operatorId: pin.operatorId, verified });
  }

  // Causal ordering: for every i received before j, MIDP_i−RADI_i ≤ MIDP_j+RADI_j (§8.2).
  for (let i = 0; i < observations.length; i += 1)
    for (let j = i + 1; j < observations.length; j += 1)
      if (
        (observations[i] as (typeof observations)[number]).verified.earliestMs >
        (observations[j] as (typeof observations)[number]).verified.latestMs
      )
        return unresolved("CAUSALLY_INCONSISTENT");

  // Per operator: every honest observation bounds the event, so keep the tightest safe value.
  const byOperator = new Map<string, { earliest: number; latest: number }>();
  for (const o of observations) {
    const current = byOperator.get(o.operatorId);
    byOperator.set(o.operatorId, {
      earliest: Math.max(current?.earliest ?? -Infinity, o.verified.earliestMs),
      latest: Math.min(current?.latest ?? Infinity, o.verified.latestMs),
    });
  }
  const f = policy.faultTolerance;
  if (
    byOperator.size < policy.minIndependentOperators ||
    byOperator.size < f + 1 ||
    !Number.isSafeInteger(f) ||
    f < 0
  )
    return unresolved("INSUFFICIENT_INDEPENDENT_OPERATORS");

  // Among any f+1 operators at least one is honest, so the (f+1)-th smallest upper bound is a
  // true upper bound, and the (f+1)-th largest lower bound is a true lower bound.
  const latests = [...byOperator.values()].map((v) => v.latest).sort((a, b) => a - b);
  const earliests = [...byOperator.values()].map((v) => v.earliest).sort((a, b) => b - a);
  return {
    kind: "QUORUM",
    lowerBoundMs: earliests[f] as number,
    upperBoundMs: latests[f] as number,
    operators: [...byOperator.keys()].sort(),
    observations: observations.map(({ serverId, verified }) => ({ serverId, verified })),
  };
};
