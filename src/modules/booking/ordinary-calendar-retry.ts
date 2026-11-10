/**
 * P2.2.9 — retry policy for the ordinary Booking Calendar consumer.
 *
 * - Exponential backoff from the row's durable consecutive-failure count (`retryableFailures`,
 *   reset only by a confirmed observation), with bounded ±20% jitter so many rows that failed
 *   together do not retry in lock-step.
 * - Provider guidance wins: a Retry-After longer than the computed delay is honoured (up to
 *   24 h); a shorter one never makes us retry sooner than our own backoff.
 * - An uncertain outcome (request may have reached Google) starts from a longer base, because
 *   it is only ever re-READ, never re-sent blindly.
 * - After `maxConsecutiveFailures`, the row stops retrying and becomes an Owner-visible
 *   "recovery required" incident (RETRY_LIMIT_REACHED) instead of retrying forever.
 */
export const ORDINARY_CALENDAR_RETRY_POLICY = {
  retryableBaseMs: 60_000,
  uncertainBaseMs: 15 * 60_000,
  maxDelayMs: 6 * 60 * 60_000,
  maxRetryAfterMs: 24 * 60 * 60_000,
  jitterRatio: 0.2,
  maxConsecutiveFailures: 10,
} as const;

export type OrdinaryCalendarRetryKind = "RETRYABLE" | "UNCERTAIN";

export function ordinaryCalendarRetryDelayMs(input: {
  /** Consecutive failures already recorded, before this one. */
  previousFailures: number;
  kind: OrdinaryCalendarRetryKind;
  retryAfterMs?: number | undefined;
  /** Injectable for deterministic tests; returns [0, 1). */
  random?: () => number;
}): number {
  const policy = ORDINARY_CALENDAR_RETRY_POLICY;
  const failures = Math.max(0, Math.min(Math.floor(input.previousFailures) || 0, 30));
  const base = input.kind === "UNCERTAIN" ? policy.uncertainBaseMs : policy.retryableBaseMs;
  const exponential = Math.min(base * 2 ** failures, policy.maxDelayMs);
  const unit = Math.min(Math.max((input.random ?? Math.random)(), 0), 1);
  const jittered = Math.round(exponential * (1 + policy.jitterRatio * (2 * unit - 1)));
  const bounded = Math.min(Math.max(jittered, 1_000), policy.maxDelayMs);
  const guidance =
    input.retryAfterMs && Number.isFinite(input.retryAfterMs) && input.retryAfterMs > 0
      ? Math.min(input.retryAfterMs, policy.maxRetryAfterMs)
      : 0;
  return Math.max(bounded, guidance);
}

/** True when the failure being recorded now would be the last one allowed. */
export const ordinaryCalendarRetryExhausted = (previousFailures: number): boolean =>
  (Math.floor(previousFailures) || 0) + 1 >= ORDINARY_CALENDAR_RETRY_POLICY.maxConsecutiveFailures;

export const ORDINARY_CALENDAR_RETRY_LIMIT_REASON = "RETRY_LIMIT_REACHED";
