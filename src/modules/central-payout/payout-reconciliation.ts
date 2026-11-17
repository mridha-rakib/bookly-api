import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { logger } from "../../config/logger.js";
import type {
  CentralPayoutGateway,
  CentralStripeMode,
  ProviderPayout,
} from "./central-payout.types.js";
import {
  type CentralPayoutOperationDocument,
  CentralPayoutOperationModel,
} from "./central-payout-operation.model.js";
import {
  type HistoryCoverageState,
  type PayoutLinkage,
  type PayoutObservationSource,
  type StripePayoutHistoryCoverageDocument,
  StripePayoutHistoryCoverageModel,
  StripePayoutObservationModel,
} from "./stripe-payout-observation.model.js";

/**
 * FG03B-1 — external Stripe payout evidence and reconciliation readiness.
 *
 * Everything here is NON-MONETARY: it records what Stripe reported and how it links to Bookly
 * withdrawal operations. It never creates a payout, never creates or changes a withdrawal
 * operation, never touches booking/Business ledgers, and never grants withdrawal authority.
 */

export const PAYOUT_METADATA_KEY = "booklyCentralPayoutOperationId";

/** Same lifecycle order as withdrawal operations: a later-or-equal rank may replace the current
 * status (paid → failed is allowed); an older out-of-order event never regresses it. */
const STATUS_RANK: Record<string, number> = {
  pending: 0,
  in_transit: 1,
  paid: 2,
  failed: 3,
  canceled: 3,
};
const rankOf = (status: string) => STATUS_RANK[status] ?? -1;
const IN_FLIGHT_STATUSES = ["pending", "in_transit"];

const modeOf = (payout: ProviderPayout): CentralStripeMode => (payout.livemode ? "LIVE" : "TEST");

export type LinkageResult = {
  linkage: PayoutLinkage;
  operationId: Types.ObjectId | null;
  claimedOperationId: Types.ObjectId | null;
};

/**
 * Batch linkage classification (one query per kind, never N+1). VERIFIED_BOOKLY requires an
 * operation that records this exact payout id in the same mode. Metadata naming an existing,
 * same-mode operation that has recorded NO payout id yet is UNRESOLVED; any other metadata is
 * ignored. Everything else is NOT_VERIFIED.
 */
export async function classifyPayoutLinkage(
  payouts: ProviderPayout[],
): Promise<Map<string, LinkageResult>> {
  const result = new Map<string, LinkageResult>();
  if (payouts.length === 0) return result;
  const linked = await CentralPayoutOperationModel.find(
    { providerPayoutId: { $in: payouts.map((p) => p.id) } },
    { _id: 1, providerPayoutId: 1, mode: 1 },
  )
    .lean<Pick<CentralPayoutOperationDocument, "_id" | "providerPayoutId" | "mode">[]>()
    .exec();
  const byPayoutId = new Map(linked.map((op) => [op.providerPayoutId, op]));
  const claimedIds = payouts
    .map((p) => p.metadata?.[PAYOUT_METADATA_KEY])
    .filter((id): id is string => typeof id === "string" && Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  const claimed = claimedIds.length
    ? await CentralPayoutOperationModel.find(
        { _id: { $in: claimedIds } },
        { _id: 1, providerPayoutId: 1, mode: 1 },
      )
        .lean<Pick<CentralPayoutOperationDocument, "_id" | "providerPayoutId" | "mode">[]>()
        .exec()
    : [];
  const claimedById = new Map(claimed.map((op) => [String(op._id), op]));

  for (const payout of payouts) {
    const op = byPayoutId.get(payout.id);
    if (op && op.mode === modeOf(payout)) {
      result.set(payout.id, {
        linkage: "VERIFIED_BOOKLY",
        operationId: op._id,
        claimedOperationId: null,
      });
      continue;
    }
    const claim = claimedById.get(String(payout.metadata?.[PAYOUT_METADATA_KEY] ?? ""));
    if (!op && claim && claim.mode === modeOf(payout) && !claim.providerPayoutId) {
      result.set(payout.id, {
        linkage: "UNRESOLVED",
        operationId: null,
        claimedOperationId: claim._id,
      });
      continue;
    }
    result.set(payout.id, { linkage: "NOT_VERIFIED", operationId: null, claimedOperationId: null });
  }
  return result;
}

/**
 * Idempotent upsert of one Stripe payout observation, safe under duplicate and reordered
 * deliveries: identity fields are written once; status only moves forward by rank; linkage is
 * recomputed from current Bookly operations on every observation.
 */
export async function observeProviderPayout(
  payout: ProviderPayout,
  source: PayoutObservationSource,
  providerEventId?: string,
  knownLinkage?: LinkageResult,
): Promise<void> {
  const mode = modeOf(payout);
  const now = new Date();
  const linkage = knownLinkage ?? (await classifyPayoutLinkage([payout])).get(payout.id);
  if (!linkage) return;
  const key = { mode, providerPayoutId: payout.id };
  const rank = rankOf(payout.status);

  try {
    await StripePayoutObservationModel.updateOne(
      key,
      {
        $setOnInsert: {
          ...key,
          amountCents: payout.amountCents,
          currency: payout.currency,
          automatic: payout.automatic,
          providerCreatedAt: payout.created,
          ...(payout.destinationId ? { destinationId: payout.destinationId } : {}),
          status: payout.status,
          statusRank: rank,
          ...(payout.arrivalDate ? { arrivalDate: payout.arrivalDate } : {}),
          ...(payout.failureCode ? { failureCode: payout.failureCode } : {}),
          linkage: linkage.linkage,
          firstObservedVia: source,
          lastObservedVia: source,
          firstObservedAt: now,
          lastObservedAt: now,
          ...(providerEventId ? { lastProviderEventId: providerEventId } : {}),
        },
      },
      { upsert: true },
    ).exec();
  } catch (error) {
    // A concurrent first observation won the insert; the updates below still apply.
    if ((error as { code?: number }).code !== 11000) throw error;
  }

  // Status: only an equal-or-later lifecycle rank replaces the stored one.
  await StripePayoutObservationModel.updateOne(
    { ...key, statusRank: { $lte: rank } },
    {
      $set: {
        status: payout.status,
        statusRank: rank,
        lastObservedVia: source,
        lastObservedAt: now,
        ...(providerEventId ? { lastProviderEventId: providerEventId } : {}),
        ...(payout.arrivalDate ? { arrivalDate: payout.arrivalDate } : {}),
        ...(payout.failureCode ? { failureCode: payout.failureCode } : {}),
      },
    },
  ).exec();

  // Linkage reflects current Bookly operations (a payout may become verified later). A verified
  // link is never downgraded: it rests on an operation's recorded payout id, which is permanent.
  const linkSet: Record<string, unknown> = { linkage: linkage.linkage };
  const linkUnset: Record<string, 1> = {};
  if (linkage.operationId) {
    linkSet["operationId"] = linkage.operationId;
    linkUnset["claimedOperationId"] = 1;
  } else if (linkage.claimedOperationId) {
    linkSet["claimedOperationId"] = linkage.claimedOperationId;
    linkUnset["operationId"] = 1;
  } else {
    linkUnset["operationId"] = 1;
    linkUnset["claimedOperationId"] = 1;
  }
  await StripePayoutObservationModel.updateOne(
    linkage.linkage === "VERIFIED_BOOKLY" ? key : { ...key, linkage: { $ne: "VERIFIED_BOOKLY" } },
    { $set: linkSet, $unset: linkUnset },
  ).exec();
}

// --- Bounded, resumable provider history sync ------------------------------------------------

const PAGE_SIZE = 100;
const DEFAULT_PAGES = 5;
export const MAX_PAGES_PER_RUN = 10;
const LEASE_MS = 2 * 60 * 1000;
/** Re-scan window before the previous completion point (upserts are idempotent, so overlap is
 * free); protects against clock skew between this server and Stripe's `created` timestamps. */
const RESCAN_OVERLAP_MS = 24 * 60 * 60 * 1000;

export type HistorySyncOutcome =
  | "COMPLETED"
  | "PAUSED_AT_PAGE_LIMIT"
  | "PROVIDER_ERROR"
  | "LEASE_LOST";

export type HistorySyncResult = {
  mode: CentralStripeMode;
  outcome: HistorySyncOutcome;
  state: HistoryCoverageState;
  pagesThisCall: number;
  observedThisCall: number;
  completeAsOf: Date | null;
  error: string | null;
};

export class PayoutHistorySyncError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

const audit = (kind: string, actorUserId: string | undefined, detail?: string) => ({
  at: new Date(),
  kind,
  ...(actorUserId && Types.ObjectId.isValid(actorUserId)
    ? { actorUserId: new Types.ObjectId(actorUserId) }
    : {}),
  ...(detail ? { detail: detail.slice(0, 500) } : {}),
});

export async function syncProviderPayoutHistory(
  gateway: CentralPayoutGateway,
  actorUserId: string,
  options: { maxPages?: number } = {},
): Promise<HistorySyncResult> {
  const mode = gateway.mode();
  if (!mode)
    throw new PayoutHistorySyncError(
      "CENTRAL_PAYOUT_STRIPE_NOT_CONFIGURED",
      "Stripe is not configured with a recognised TEST or LIVE secret key",
      409,
    );
  const account = await gateway.retrieveAccountPayoutState();
  if (!account.accountId)
    throw new PayoutHistorySyncError(
      "CENTRAL_PAYOUT_ACCOUNT_UNIDENTIFIED",
      "Stripe did not return the platform account identity; history coverage cannot be scoped",
      409,
    );
  const maxPages = Math.min(Math.max(options.maxPages ?? DEFAULT_PAGES, 1), MAX_PAGES_PER_RUN);

  await StripePayoutHistoryCoverageModel.updateOne(
    { mode },
    { $setOnInsert: { mode, state: "NEVER_RUN", audit: [] } },
    { upsert: true },
  )
    .exec()
    .catch((error: { code?: number }) => {
      if (error.code !== 11000) throw error;
    });

  const leaseId = randomUUID();
  const now = new Date();
  const leased = await StripePayoutHistoryCoverageModel.findOneAndUpdate(
    {
      mode,
      $or: [{ leaseId: { $exists: false } }, { leaseExpiresAt: { $lt: now } }],
    },
    { $set: { leaseId, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) } },
    { new: true },
  )
    .lean<StripePayoutHistoryCoverageDocument>()
    .exec();
  if (!leased)
    throw new PayoutHistorySyncError(
      "CENTRAL_PAYOUT_HISTORY_SYNC_IN_PROGRESS",
      "Another payout history sync is running. Try again shortly.",
      409,
    );

  const held = { mode, leaseId };
  let coverage = leased;
  // Coverage belongs to one Stripe account; a different account starts again from nothing.
  if (coverage.accountId && coverage.accountId !== account.accountId) {
    await StripePayoutHistoryCoverageModel.updateOne(held, {
      $set: { state: "NEVER_RUN", accountId: account.accountId },
      $unset: { completeAsOf: 1, lastCompletedAt: 1, run: 1, lastError: 1 },
      $push: { audit: { $each: [audit("ACCOUNT_CHANGED", actorUserId)], $slice: -50 } },
    }).exec();
    coverage = { ...coverage, state: "NEVER_RUN", completeAsOf: undefined, run: undefined };
  } else if (!coverage.accountId) {
    await StripePayoutHistoryCoverageModel.updateOne(held, {
      $set: { accountId: account.accountId },
    }).exec();
  }

  const run = coverage.run ?? {
    startedAt: new Date(),
    ...(coverage.completeAsOf
      ? { createdGte: new Date(coverage.completeAsOf.getTime() - RESCAN_OVERLAP_MS) }
      : {}),
    pages: 0,
    observed: 0,
  };
  if (!coverage.run)
    await StripePayoutHistoryCoverageModel.updateOne(held, {
      $set: { state: "IN_PROGRESS", run, lastRunAt: new Date() },
      $push: { audit: { $each: [audit("RUN_STARTED", actorUserId)], $slice: -50 } },
    }).exec();

  let pagesThisCall = 0;
  let observedThisCall = 0;
  let cursor = run.cursor;
  const finish = async (
    outcome: HistorySyncOutcome,
    update: Record<string, unknown>,
    error: string | null,
  ): Promise<HistorySyncResult> => {
    const written = await StripePayoutHistoryCoverageModel.findOneAndUpdate(
      held,
      {
        ...update,
        $unset: { leaseId: 1, leaseExpiresAt: 1, ...((update["$unset"] as object) ?? {}) },
        $push: {
          audit: {
            $each: [
              audit(
                `RUN_${outcome}`,
                actorUserId,
                `${pagesThisCall} page(s), ${observedThisCall} payout(s)${error ? `; ${error}` : ""}`,
              ),
            ],
            $slice: -50,
          },
        },
      },
      { new: true },
    )
      .lean<StripePayoutHistoryCoverageDocument>()
      .exec();
    return {
      mode,
      outcome: written ? outcome : "LEASE_LOST",
      state: written?.state ?? "IN_PROGRESS",
      pagesThisCall,
      observedThisCall,
      completeAsOf: written?.completeAsOf ?? null,
      error,
    };
  };

  while (pagesThisCall < maxPages) {
    let page: { payouts: ProviderPayout[]; hasMore: boolean };
    try {
      page = await gateway.listPayoutsPage({
        limit: PAGE_SIZE,
        startingAfter: cursor,
        createdGte: run.createdGte,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stripe request failed";
      logger.warn({ event: "CENTRAL_PAYOUT_HISTORY_SYNC_PROVIDER_ERROR", mode }, message);
      // Pages already observed stay durable; the run resumes from the same cursor later.
      return finish("PROVIDER_ERROR", { $set: { lastError: message.slice(0, 500) } }, message);
    }
    if (page.payouts.some((p) => modeOf(p) !== mode))
      return finish(
        "PROVIDER_ERROR",
        { $set: { lastError: "Stripe returned payouts for a different mode" } },
        "Stripe returned payouts for a different mode",
      );
    if (page.payouts.length === 0 && page.hasMore)
      return finish(
        "PROVIDER_ERROR",
        { $set: { lastError: "Stripe returned an empty page that claims more results" } },
        "Stripe returned an empty page that claims more results",
      );

    const linkage = await classifyPayoutLinkage(page.payouts);
    for (const payout of page.payouts)
      await observeProviderPayout(payout, "HISTORY_SYNC", undefined, linkage.get(payout.id));
    pagesThisCall += 1;
    observedThisCall += page.payouts.length;
    cursor = page.payouts.at(-1)?.id ?? cursor;

    if (!page.hasMore)
      return finish(
        "COMPLETED",
        {
          $set: {
            state: "COMPLETE",
            completeAsOf: run.startedAt,
            lastCompletedAt: new Date(),
          },
          $unset: { run: 1, lastError: 1 },
        },
        null,
      );

    // Durable checkpoint, only while still holding the lease.
    const saved = await StripePayoutHistoryCoverageModel.updateOne(held, {
      $set: {
        "run.cursor": cursor,
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      },
      $inc: { "run.pages": 1, "run.observed": page.payouts.length },
    }).exec();
    if (saved.matchedCount === 0)
      return {
        mode,
        outcome: "LEASE_LOST",
        state: "IN_PROGRESS",
        pagesThisCall,
        observedThisCall,
        completeAsOf: null,
        error: "Sync lease expired; another run may continue from the saved checkpoint",
      };
  }
  return finish("PAUSED_AT_PAGE_LIMIT", { $unset: { lastError: 1 } }, null);
}

// --- Read-only reconciliation readiness --------------------------------------------------------

export type ReconciliationBlocker = { code: string; message: string };

/**
 * A read-only evidence status for future withdrawal-eligibility checks. `evidenceComplete: true`
 * only means Bookly holds complete, fully linked payout evidence up to `completeAsOf`; it is NOT
 * permission to withdraw and grants no authority. Any blocker means evidence is incomplete.
 */
export type ReconciliationReadiness = {
  mode: CentralStripeMode | null;
  evidenceComplete: boolean;
  reviewNeeded: boolean;
  coverage: {
    state: HistoryCoverageState;
    completeAsOf: Date | null;
    lastCompletedAt: Date | null;
    lastRunAt: Date | null;
    runInProgress: { pages: number; observed: number } | null;
    lastError: string | null;
    /** null when the current Stripe account identity could not be read. */
    accountMatches: boolean | null;
  };
  observations: {
    total: number;
    verifiedBookly: number;
    notVerified: number;
    unresolved: number;
    inFlight: number;
  };
  unresolvedWithdrawalOperations: number;
  syncEnabled: boolean;
  blockers: ReconciliationBlocker[];
};

export async function readReconciliationReadiness(input: {
  mode: CentralStripeMode | null;
  currentAccountId: string | undefined;
  syncEnabled: boolean;
}): Promise<ReconciliationReadiness> {
  const { mode } = input;
  const blockers: ReconciliationBlocker[] = [];
  if (!mode) {
    return {
      mode: null,
      evidenceComplete: false,
      reviewNeeded: false,
      coverage: {
        state: "NEVER_RUN",
        completeAsOf: null,
        lastCompletedAt: null,
        lastRunAt: null,
        runInProgress: null,
        lastError: null,
        accountMatches: null,
      },
      observations: { total: 0, verifiedBookly: 0, notVerified: 0, unresolved: 0, inFlight: 0 },
      unresolvedWithdrawalOperations: 0,
      syncEnabled: input.syncEnabled,
      blockers: [
        {
          code: "STRIPE_NOT_CONFIGURED",
          message: "Stripe is not configured; no payout evidence can be read.",
        },
      ],
    };
  }
  const [coverage, total, verifiedBookly, notVerified, unresolved, inFlight, unresolvedOps] =
    await Promise.all([
      StripePayoutHistoryCoverageModel.findOne({ mode })
        .lean<StripePayoutHistoryCoverageDocument>()
        .exec(),
      StripePayoutObservationModel.countDocuments({ mode }).exec(),
      StripePayoutObservationModel.countDocuments({ mode, linkage: "VERIFIED_BOOKLY" }).exec(),
      StripePayoutObservationModel.countDocuments({ mode, linkage: "NOT_VERIFIED" }).exec(),
      StripePayoutObservationModel.countDocuments({ mode, linkage: "UNRESOLVED" }).exec(),
      StripePayoutObservationModel.countDocuments({
        mode,
        status: { $in: IN_FLIGHT_STATUSES },
      }).exec(),
      CentralPayoutOperationModel.countDocuments({
        mode,
        state: { $in: ["PREPARED", "UNKNOWN"] },
      }).exec(),
    ]);

  const state: HistoryCoverageState = coverage?.state ?? "NEVER_RUN";
  const accountMatches =
    input.currentAccountId && coverage?.accountId
      ? coverage.accountId === input.currentAccountId
      : null;

  if (state === "NEVER_RUN")
    blockers.push({
      code: "HISTORY_NEVER_SYNCED",
      message: "Stripe payout history has never been fully read; older payouts may be missing.",
    });
  if (state === "IN_PROGRESS")
    blockers.push({
      code: "HISTORY_INCOMPLETE",
      message: "A payout history read has started but has not reached Stripe's last page.",
    });
  if (coverage?.lastError)
    blockers.push({
      code: "HISTORY_SYNC_FAILED",
      message: `The last history read stopped: ${coverage.lastError}`,
    });
  if (accountMatches === false)
    blockers.push({
      code: "PROVIDER_ACCOUNT_CHANGED",
      message: "The connected Stripe account differs from the one the history was read from.",
    });
  if (state === "COMPLETE" && accountMatches === null)
    blockers.push({
      code: "PROVIDER_ACCOUNT_UNVERIFIED",
      message: "The current Stripe account identity could not be confirmed against the history.",
    });
  if (notVerified > 0)
    blockers.push({
      code: "UNVERIFIED_PAYOUTS_PRESENT",
      message: `${notVerified} Stripe payout(s) are not linked to a Bookly withdrawal. This is not a finding that they were unauthorized.`,
    });
  if (unresolved > 0)
    blockers.push({
      code: "UNRESOLVED_LINKAGE_PRESENT",
      message: `${unresolved} Stripe payout(s) name a Bookly withdrawal that has not confirmed them yet.`,
    });
  if (unresolvedOps > 0)
    blockers.push({
      code: "WITHDRAWALS_AWAITING_CONFIRMATION",
      message: `${unresolvedOps} Bookly withdrawal(s) are still awaiting Stripe confirmation.`,
    });
  if (inFlight > 0)
    blockers.push({
      code: "PAYOUTS_IN_FLIGHT",
      message: `${inFlight} observed payout(s) are still pending or in transit at Stripe.`,
    });

  return {
    mode,
    evidenceComplete: blockers.length === 0,
    reviewNeeded: notVerified > 0 || unresolved > 0 || unresolvedOps > 0,
    coverage: {
      state,
      completeAsOf: coverage?.completeAsOf ?? null,
      lastCompletedAt: coverage?.lastCompletedAt ?? null,
      lastRunAt: coverage?.lastRunAt ?? null,
      runInProgress: coverage?.run
        ? { pages: coverage.run.pages, observed: coverage.run.observed }
        : null,
      lastError: coverage?.lastError ?? null,
      accountMatches,
    },
    observations: { total, verifiedBookly, notVerified, unresolved, inFlight },
    unresolvedWithdrawalOperations: unresolvedOps,
    syncEnabled: input.syncEnabled,
    blockers,
  };
}
