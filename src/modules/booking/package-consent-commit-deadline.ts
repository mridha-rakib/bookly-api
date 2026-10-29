/**
 * P1A — strict 30-minute consent-COMMIT deadline verifier (P3-B1c, Option A).
 *
 * Owner rule (verbatim lifetime approval + approved Option A): the authoritative acceptance
 * COMMIT must happen strictly before `originalQuote.issuedAt + 30 minutes`. A request, a
 * validation time, an application-clock `acceptedAt`, a transaction start or a later
 * acknowledgement is NOT the event.
 *
 * This module only decides whether SUPPLIED, ALREADY-VERIFIED trusted-time evidence proves that
 * rule. It does not obtain time, verify signatures, write data or authorize anything:
 *  - No time authority is approved (Owner decision D7 pending; paid TSA excluded by the
 *    zero-cost mandate), so the shipped registry below is EMPTY and every shipped result is
 *    UNRESOLVED.
 *  - It is not wired to purchase or activation. `verifyPackageBatchActivation` stays
 *    unconditional and fails closed.
 * The result can only ever be CERTIFIED or UNRESOLVED: evidence observed after a commit bounds
 * the commit from above, so it can prove "before the deadline" but never "late".
 */

/** Owner-approved lifetime. Any other configured value is not approved for activation. */
export const PACKAGE_CONSENT_STRICT_LIFETIME_MS = 30 * 60 * 1000;

/**
 * Approved common time authorities (D7). Empty until the Owner approves one; nothing in this
 * repository may add to it without that decision.
 */
export const APPROVED_CONSENT_TIME_AUTHORITIES: readonly string[] = Object.freeze([]);

/**
 * A trusted interval that is guaranteed (by the authority adapter that produced it, after
 * verifying the authority's signature and pinned keys) to contain the true UTC instant of the
 * observed event. Integer milliseconds, inclusive bounds.
 */
export type TrustedTimeInterval = {
  authorityId: string;
  earliestMs: number;
  latestMs: number;
};

export type ConsentCommitDeadlineInput = {
  /** The retained original quote's `issuedAt` / `expiresAt` (application clock, v1). */
  retainedIssuedAtMs: number;
  retainedExpiresAtMs: number;
  /** Trusted attestation of the original issuance event (D3). */
  issuanceAttestation?: TrustedTimeInterval | undefined;
  /**
   * Trusted observation made strictly AFTER the acceptance commit was durably observed
   * (C → M → W → O ordering is the caller's obligation). Its upper bound bounds the commit.
   */
  postCommitObservation?: TrustedTimeInterval | undefined;
};

export type ConsentCommitDeadlineUnresolvedReason =
  | "INVALID_INPUT"
  | "LIFETIME_NOT_OWNER_APPROVED"
  | "ISSUANCE_NOT_ATTESTED"
  | "NO_COMMIT_EVIDENCE"
  | "TIME_AUTHORITY_NOT_APPROVED"
  | "COMMIT_NOT_PROVEN_BEFORE_DEADLINE";

export type ConsentCommitDeadlineResult =
  | { kind: "CERTIFIED"; deadlineMs: number; commitLatestMs: number }
  | { kind: "UNRESOLVED"; reason: ConsentCommitDeadlineUnresolvedReason };

const isInstant = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const validInterval = (interval: TrustedTimeInterval): boolean =>
  typeof interval.authorityId === "string" &&
  interval.authorityId.length > 0 &&
  isInstant(interval.earliestMs) &&
  isInstant(interval.latestMs) &&
  interval.earliestMs <= interval.latestMs;

const unresolved = (
  reason: ConsentCommitDeadlineUnresolvedReason,
): ConsentCommitDeadlineResult => ({ kind: "UNRESOLVED", reason });

/**
 * CERTIFIED only when every premise holds:
 *  1. the retained quote window is exactly the Owner-approved 30 minutes;
 *  2. issuance is attested by an approved authority. The deadline uses the EARLIER of the
 *     retained `issuedAt` and the attested earliest bound, so it is never later than
 *     (true issuance + 30 min) under any D3 reading;
 *  3. a post-commit observation from an approved authority has `latestMs < deadline`
 *     (strict; equality or uncertainty is never enough).
 * `approvedAuthorities` defaults to the shipped (empty) registry. Engineering tests may pass a
 * synthetic registry to exercise the arithmetic; that is not an approval.
 */
export const assessConsentCommitDeadline = (
  input: ConsentCommitDeadlineInput,
  approvedAuthorities: readonly string[] = APPROVED_CONSENT_TIME_AUTHORITIES,
): ConsentCommitDeadlineResult => {
  const { retainedIssuedAtMs, retainedExpiresAtMs } = input;
  if (!isInstant(retainedIssuedAtMs) || !isInstant(retainedExpiresAtMs))
    return unresolved("INVALID_INPUT");
  if (retainedExpiresAtMs - retainedIssuedAtMs !== PACKAGE_CONSENT_STRICT_LIFETIME_MS)
    return unresolved("LIFETIME_NOT_OWNER_APPROVED");

  const issuance = input.issuanceAttestation;
  if (!issuance) return unresolved("ISSUANCE_NOT_ATTESTED");
  if (!validInterval(issuance)) return unresolved("INVALID_INPUT");
  if (!approvedAuthorities.includes(issuance.authorityId))
    return unresolved("TIME_AUTHORITY_NOT_APPROVED");

  const observation = input.postCommitObservation;
  if (!observation) return unresolved("NO_COMMIT_EVIDENCE");
  if (!validInterval(observation)) return unresolved("INVALID_INPUT");
  if (!approvedAuthorities.includes(observation.authorityId))
    return unresolved("TIME_AUTHORITY_NOT_APPROVED");

  const anchorMs = Math.min(retainedIssuedAtMs, issuance.earliestMs);
  const deadlineMs = anchorMs + PACKAGE_CONSENT_STRICT_LIFETIME_MS;
  if (!Number.isSafeInteger(deadlineMs)) return unresolved("INVALID_INPUT");
  if (!(observation.latestMs < deadlineMs)) return unresolved("COMMIT_NOT_PROVEN_BEFORE_DEADLINE");
  return { kind: "CERTIFIED", deadlineMs, commitLatestMs: observation.latestMs };
};
