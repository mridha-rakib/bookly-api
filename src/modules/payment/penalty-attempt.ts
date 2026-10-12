import type {
  PaymentAttemptDocument,
  PaymentAttemptProviderStatus,
} from "./payment-attempt.model.js";

/**
 * P5 — durable customer penalty collection (late-cancellation / no-show shortfall). A penalty
 * charge reuses the existing PaymentAttempt machinery; these helpers keep its identity rules in
 * one place.
 *
 * The purposes are the existing PaymentIntent/ledger vocabulary (payment-intent-metadata.ts,
 * booking-financial-transaction.types.ts) — never a parallel enum.
 */
export const PENALTY_PURPOSES = ["CANCELLATION_FEE", "NO_SHOW_FEE"] as const;
export type PenaltyPurpose = (typeof PENALTY_PURPOSES)[number];

export const isPenaltyPurpose = (purpose: string | undefined | null): purpose is PenaltyPurpose =>
  purpose === "CANCELLATION_FEE" || purpose === "NO_SHOW_FEE";

/**
 * Reserved, server-only PaymentAttempt logical-key namespace. Checkout logical keys are the raw
 * client-supplied idempotency key, so a penalty key must live in a namespace no client key can
 * occupy: PaymentAttemptRepository refuses this prefix for every non-penalty purpose and
 * requires it for every penalty purpose.
 */
export const PENALTY_ATTEMPT_KEY_PREFIX = "penalty:";

/** Deterministic for one obligation: derived only from the server-generated ledger row id. */
export const penaltyAttemptKey = (obligationTransactionId: { toString(): string }): string =>
  `${PENALTY_ATTEMPT_KEY_PREFIX}${String(obligationTransactionId)}`;

const objectIdPattern = /^[a-f\d]{24}$/i;

/** The obligation ledger row id a penalty attempt belongs to, or undefined when malformed. */
export const parsePenaltyAttemptKey = (logicalKey: string): string | undefined => {
  if (!logicalKey.startsWith(PENALTY_ATTEMPT_KEY_PREFIX)) return undefined;
  const id = logicalKey.slice(PENALTY_ATTEMPT_KEY_PREFIX.length);
  return objectIdPattern.test(id) ? id : undefined;
};

/**
 * Off-session penalty attempts expose no client secret, so nobody can complete a
 * requires_action/requires_payment_method PaymentIntent: FAILED, CANCELED and REQUIRES_ACTION
 * are definitive collection failures (P5 Rule 2). A proven-absent attempt is FAILED too
 * (PROVIDER_NOT_CREATED).
 */
const DEFINITIVE_FAILURE_STATUSES: ReadonlySet<PaymentAttemptProviderStatus> = new Set([
  "FAILED",
  "CANCELED",
  "REQUIRES_ACTION",
]);

export const isDefinitivePenaltyFailure = (
  attempt: Pick<PaymentAttemptDocument, "providerStatus">,
): boolean => DEFINITIVE_FAILURE_STATUSES.has(attempt.providerStatus);

export const PENALTY_DEFINITIVE_FAILURE_STATUSES = [...DEFINITIVE_FAILURE_STATUSES];
