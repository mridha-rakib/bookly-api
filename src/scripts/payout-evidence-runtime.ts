// FG03B-3 — launch checks and one pass of the optional Stripe payout-evidence refresh worker.
// No application imports: launch intent is validated before any provider or database dependency
// is constructed, and the pass logic is testable with an injected read function.
//
// The worker only re-reads Stripe's payout list (bounded pages, resumable, leased, audited)
// through the same code path as the Super Admin "Read Stripe payout history" action. It never
// creates payouts, never touches ledgers and never grants withdrawal authority. Its interval is an
// evidence-freshness operational target, NOT a financial-finality guarantee.

export class PayoutEvidenceLaunchError extends Error {}

/** Default refresh interval: comfortably inside the 24h evidence-freshness target. */
export const DEFAULT_PAYOUT_EVIDENCE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 15 * 60 * 1000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Bounded Stripe usage per pass: at most this many calls of at most 10 pages of 100. */
export const MAX_CALLS_PER_PASS = 5;

export const assertPayoutEvidenceLaunch = (
  environment: Readonly<Record<string, string | undefined>>,
  args: readonly string[],
): { intervalMs: number } => {
  if (environment["BOOKLY_PAYOUT_EVIDENCE_WORKER_ENABLED"] !== "true")
    throw new PayoutEvidenceLaunchError(
      "Payout evidence refresh requires explicit worker enablement",
    );
  if (environment["CENTRAL_PAYOUT_HISTORY_SYNC_ENABLED"] !== "true")
    throw new PayoutEvidenceLaunchError(
      "Payout evidence refresh requires the approved Stripe payout history read to be enabled",
    );
  if (!environment["MONGODB_URI"]?.trim() || !environment["STRIPE_SECRET_KEY"]?.trim())
    throw new PayoutEvidenceLaunchError(
      "Payout evidence refresh requires explicit database and provider configuration",
    );
  if (args.length > 1 || args.some((arg) => arg !== "--once"))
    throw new PayoutEvidenceLaunchError(
      "Payout evidence refresh accepts only the optional --once argument",
    );
  const raw = environment["BOOKLY_PAYOUT_EVIDENCE_INTERVAL_MS"];
  const intervalMs =
    raw === undefined || raw === "" ? DEFAULT_PAYOUT_EVIDENCE_INTERVAL_MS : Number(raw);
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < MIN_INTERVAL_MS ||
    intervalMs > MAX_INTERVAL_MS
  )
    throw new PayoutEvidenceLaunchError(
      "BOOKLY_PAYOUT_EVIDENCE_INTERVAL_MS must be an integer between 15 minutes and 24 hours",
    );
  return { intervalMs };
};

export type PayoutEvidenceSyncResult = {
  outcome: "COMPLETED" | "PAUSED_AT_PAGE_LIMIT" | "PROVIDER_ERROR" | "LEASE_LOST";
  pagesThisCall: number;
  observedThisCall: number;
  error: string | null;
};

export type PayoutEvidencePassSummary = {
  result: "COMPLETED" | "INCOMPLETE" | "SKIPPED_RUN_IN_PROGRESS" | "FAILED";
  calls: number;
  pages: number;
  observed: number;
  error: string | null;
};

const isRunInProgress = (error: unknown): boolean =>
  JSON.stringify((error as { details?: unknown })?.details ?? "").includes(
    "CENTRAL_PAYOUT_HISTORY_SYNC_IN_PROGRESS",
  );

/**
 * One bounded refresh pass: keeps reading while Stripe has more pages, up to MAX_CALLS_PER_PASS
 * calls. Anything short of a completed full read is reported INCOMPLETE/FAILED (the checkpoint
 * keeps the position; readiness stays blocked), never as success. A run already holding the lease
 * (e.g. an operator read) is left alone.
 */
export const runPayoutEvidencePass = async (
  sync: () => Promise<PayoutEvidenceSyncResult>,
): Promise<PayoutEvidencePassSummary> => {
  const summary: PayoutEvidencePassSummary = {
    result: "INCOMPLETE",
    calls: 0,
    pages: 0,
    observed: 0,
    error: null,
  };
  while (summary.calls < MAX_CALLS_PER_PASS) {
    let result: PayoutEvidenceSyncResult;
    try {
      result = await sync();
    } catch (error) {
      if (isRunInProgress(error)) return { ...summary, result: "SKIPPED_RUN_IN_PROGRESS" };
      return {
        ...summary,
        result: "FAILED",
        error: error instanceof Error ? error.message.slice(0, 300) : "Payout evidence read failed",
      };
    }
    summary.calls += 1;
    summary.pages += result.pagesThisCall;
    summary.observed += result.observedThisCall;
    if (result.outcome === "COMPLETED") return { ...summary, result: "COMPLETED" };
    if (result.outcome !== "PAUSED_AT_PAGE_LIMIT")
      return { ...summary, result: "INCOMPLETE", error: result.error };
  }
  return summary;
};
