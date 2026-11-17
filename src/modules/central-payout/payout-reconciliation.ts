import { randomUUID } from "node:crypto";
import { type QueryFilter, Types } from "mongoose";
import { logger } from "../../config/logger.js";
import type {
  CentralBankDestination,
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
  type StripePayoutObservationDocument,
  StripePayoutObservationModel,
} from "./stripe-payout-observation.model.js";

/**
 * FG03B-1/2 — external Stripe payout evidence and reconciliation readiness.
 *
 * Everything here is NON-MONETARY: it records what Stripe reported and how it links to Bookly
 * withdrawal operations. It never creates a payout, never creates or changes a withdrawal
 * operation, never touches booking/Business ledgers, and never grants withdrawal authority.
 *
 * FG03B-2: every observation is bound to the Stripe platform account that reported it, and every
 * read is scoped to the CURRENT account; evidence freshness is explicit (see `unsettledFilter`).
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
/** Statuses Stripe never moves away from. `paid` is NOT final: Stripe can still report a paid
 * payout as failed, so it is final only once outside PAID_FAILURE_WINDOW_MS. */
const TERMINAL_STATUSES = ["failed", "canceled"];

/**
 * Engineering assumption, NOT a Stripe guarantee: a `paid` payout older than this (by Stripe's
 * arrival date, else creation) is treated as settled. Requires Stripe/accountant confirmation
 * before any financial use; changes of older paid payouts are only caught by webhooks.
 */
export const PAID_FAILURE_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;
/** An unsettled observation not re-confirmed by Stripe within this period is stale evidence. */
export const OBSERVATION_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** A completed history read older than this no longer vouches for payouts created since. */
export const HISTORY_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const modeOf = (payout: ProviderPayout): CentralStripeMode => (payout.livemode ? "LIVE" : "TEST");

type ObservationFilter = QueryFilter<StripePayoutObservationDocument>;

/** Observations whose Stripe status could still change (in flight, unknown, or recently paid). */
export const unsettledFilter = (now: Date): ObservationFilter => {
  const cutoff = new Date(now.getTime() - PAID_FAILURE_WINDOW_MS);
  return {
    $or: [
      { status: { $nin: ["paid", ...TERMINAL_STATUSES] } },
      { status: "paid", arrivalDate: { $gt: cutoff } },
      { status: "paid", arrivalDate: null, providerCreatedAt: { $gt: cutoff } },
    ],
  };
};

/** Unsettled observations Stripe has not re-confirmed recently: possibly a missed webhook. */
export const staleFilter = (now: Date): ObservationFilter => ({
  $and: [
    unsettledFilter(now),
    { lastObservedAt: { $lt: new Date(now.getTime() - OBSERVATION_STALE_AFTER_MS) } },
  ],
});

const isUnsettled = (
  o: Pick<StripePayoutObservationDocument, "status" | "arrivalDate" | "providerCreatedAt">,
  now: Date,
): boolean => {
  if (o.status !== "paid") return !TERMINAL_STATUSES.includes(o.status);
  return (o.arrivalDate ?? o.providerCreatedAt).getTime() > now.getTime() - PAID_FAILURE_WINDOW_MS;
};

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
 * FG03B-2 — a Bookly operation has just recorded this exact Stripe payout id (from Stripe's own
 * response, recovery or a verified webhook): promote the matching observation to VERIFIED_BOOKLY.
 * Together with the re-check at the end of observeProviderPayout this closes the race where the
 * observation is written while the operation is still unconfirmed. Never creates an observation.
 */
export async function promoteObservationLinkage(
  providerPayoutId: string,
  mode: CentralStripeMode,
  operationId: Types.ObjectId,
): Promise<void> {
  await StripePayoutObservationModel.updateOne(
    { mode, providerPayoutId, linkage: { $ne: "VERIFIED_BOOKLY" } },
    { $set: { linkage: "VERIFIED_BOOKLY", operationId }, $unset: { claimedOperationId: 1 } },
  ).exec();
}

export type ObservationOutcome = "OBSERVED" | "ACCOUNT_CONFLICT";

/**
 * Idempotent upsert of one Stripe payout observation for one platform account, safe under
 * duplicate and reordered deliveries: identity fields are written once; status only moves forward
 * by rank; linkage is recomputed from current Bookly operations. A payout already recorded under a
 * DIFFERENT account is never rewritten: that is reported as ACCOUNT_CONFLICT (fail closed).
 */
export async function observeProviderPayout(
  payout: ProviderPayout,
  scope: { accountId: string; destinationLast4?: string | undefined },
  source: PayoutObservationSource,
  providerEventId?: string,
  knownLinkage?: LinkageResult,
): Promise<ObservationOutcome> {
  const mode = modeOf(payout);
  const now = new Date();
  const linkage = knownLinkage ?? (await classifyPayoutLinkage([payout])).get(payout.id);
  if (!linkage) return "OBSERVED";
  const owned = { mode, providerPayoutId: payout.id, accountId: scope.accountId };
  const rank = rankOf(payout.status);

  try {
    await StripePayoutObservationModel.updateOne(
      owned,
      {
        $setOnInsert: {
          ...owned,
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
    // Either a concurrent first observation won the insert (same account: fine), or the payout is
    // already recorded under another account (unique { mode, providerPayoutId }): checked below.
    if ((error as { code?: number }).code !== 11000) throw error;
  }
  if (!(await StripePayoutObservationModel.exists(owned).exec())) {
    logger.error(
      { event: "CENTRAL_PAYOUT_OBSERVATION_ACCOUNT_CONFLICT", mode, payoutId: payout.id },
      "Stripe payout is already recorded under a different Stripe account; not rewritten",
    );
    return "ACCOUNT_CONFLICT";
  }

  // Status: only an equal-or-later lifecycle rank replaces the stored one. An equal rank still
  // refreshes lastObservedAt: Stripe has just re-confirmed the current status.
  await StripePayoutObservationModel.updateOne(
    { ...owned, statusRank: { $lte: rank } },
    {
      $set: {
        status: payout.status,
        statusRank: rank,
        lastObservedVia: source,
        lastObservedAt: now,
        ...(providerEventId ? { lastProviderEventId: providerEventId } : {}),
        ...(payout.arrivalDate ? { arrivalDate: payout.arrivalDate } : {}),
        ...(payout.failureCode ? { failureCode: payout.failureCode } : {}),
        ...(scope.destinationLast4 ? { destinationLast4: scope.destinationLast4 } : {}),
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
    linkage.linkage === "VERIFIED_BOOKLY"
      ? owned
      : { ...owned, linkage: { $ne: "VERIFIED_BOOKLY" } },
    { $set: linkSet, $unset: linkUnset },
  ).exec();

  // Re-check after writing: an operation that recorded this payout id while the linkage above was
  // being computed is picked up here (promoteObservationLinkage covers the opposite order).
  if (linkage.linkage !== "VERIFIED_BOOKLY") {
    const op = await CentralPayoutOperationModel.findOne(
      { providerPayoutId: payout.id, mode },
      { _id: 1 },
    )
      .lean<Pick<CentralPayoutOperationDocument, "_id">>()
      .exec();
    if (op) await promoteObservationLinkage(payout.id, mode, op._id);
  }
  return "OBSERVED";
}

export type WebhookObservationOutcome =
  | ObservationOutcome
  | "SKIPPED_CONNECTED_ACCOUNT"
  | "SKIPPED_MODE_MISMATCH";

/**
 * FG03B-2 — webhook observation, scoped to the platform account of the configured key. Events
 * carrying a connected `account` are not platform payouts; events from the other mode cannot be
 * attributed to a verified account. Both are skipped (logged), never guessed. If the platform
 * account cannot be read, this THROWS so the webhook event stays retryable (fail closed).
 */
export async function observeWebhookPayout(
  gateway: Pick<CentralPayoutGateway, "mode" | "platformAccountId">,
  payout: ProviderPayout,
  providerEventId: string,
  eventAccount?: string | null,
): Promise<WebhookObservationOutcome> {
  if (eventAccount) {
    logger.warn(
      { event: "CENTRAL_PAYOUT_OBSERVATION_SKIPPED", reason: "CONNECTED_ACCOUNT", providerEventId },
      "Payout event for a connected account is not platform payout evidence",
    );
    return "SKIPPED_CONNECTED_ACCOUNT";
  }
  if (gateway.mode() !== modeOf(payout)) {
    logger.warn(
      { event: "CENTRAL_PAYOUT_OBSERVATION_SKIPPED", reason: "MODE_MISMATCH", providerEventId },
      "Payout event mode differs from the configured Stripe key; account cannot be verified",
    );
    return "SKIPPED_MODE_MISMATCH";
  }
  const accountId = await gateway.platformAccountId();
  return observeProviderPayout(payout, { accountId }, "WEBHOOK", providerEventId);
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

const maskedLast4 = (destinations: CentralBankDestination[]) =>
  new Map(
    destinations
      .filter((d) => /^ba_[A-Za-z0-9]+$/.test(d.id) && /^[A-Za-z0-9]{4}$/.test(d.last4))
      .map((d) => [d.id, d.last4]),
  );

/**
 * Where a new run starts reading (Stripe `created.gte`). No completed run: everything. After a
 * completed run: from the earlier of (completion − overlap) and the creation time of the OLDEST
 * still-unsettled observation of this account, so every payout whose status may still change is
 * re-read from Stripe and a missed webhook cannot leave it stale.
 */
async function runWindowStart(
  accountId: string,
  mode: CentralStripeMode,
  completeAsOf: Date | undefined,
): Promise<Date | undefined> {
  if (!completeAsOf) return undefined;
  const overlapStart = new Date(completeAsOf.getTime() - RESCAN_OVERLAP_MS);
  const oldest = await StripePayoutObservationModel.findOne(
    { $and: [{ accountId, mode }, unsettledFilter(new Date())] },
    { providerCreatedAt: 1 },
  )
    .sort({ providerCreatedAt: 1 })
    .lean<Pick<StripePayoutObservationDocument, "providerCreatedAt">>()
    .exec();
  return oldest && oldest.providerCreatedAt < overlapStart
    ? oldest.providerCreatedAt
    : overlapStart;
}

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
  const accountId = account.accountId;
  const last4ByDestination = maskedLast4(account.destinations);
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
    { returnDocument: "after" },
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
  let pagesThisCall = 0;
  let observedThisCall = 0;
  const leaseLost = (): HistorySyncResult => ({
    mode,
    outcome: "LEASE_LOST",
    state: "IN_PROGRESS",
    pagesThisCall,
    observedThisCall,
    completeAsOf: null,
    error: "Sync lease expired; another run may continue from the saved checkpoint",
  });

  let coverage = leased;
  // Coverage belongs to one Stripe account; a different account starts again from nothing (the
  // earlier account's observations are kept, but no longer counted: reads are account-scoped).
  if (coverage.accountId && coverage.accountId !== accountId) {
    const reset = await StripePayoutHistoryCoverageModel.updateOne(held, {
      $set: { state: "NEVER_RUN", accountId },
      $unset: { completeAsOf: 1, lastCompletedAt: 1, run: 1, lastError: 1 },
      $push: {
        audit: {
          $each: [audit("ACCOUNT_CHANGED", actorUserId, `${coverage.accountId} → ${accountId}`)],
          $slice: -50,
        },
      },
    }).exec();
    if (reset.matchedCount === 0) return leaseLost();
    coverage = { ...coverage, state: "NEVER_RUN", completeAsOf: undefined, run: undefined };
  } else if (!coverage.accountId) {
    await StripePayoutHistoryCoverageModel.updateOne(held, { $set: { accountId } }).exec();
  }

  let run = coverage.run;
  if (!run) {
    const createdGte = await runWindowStart(accountId, mode, coverage.completeAsOf);
    run = {
      startedAt: new Date(),
      ...(createdGte ? { createdGte } : {}),
      pages: 0,
      observed: 0,
    };
    const started = await StripePayoutHistoryCoverageModel.updateOne(held, {
      $set: { state: "IN_PROGRESS", run, lastRunAt: new Date() },
      $push: {
        audit: {
          $each: [
            audit(
              "RUN_STARTED",
              actorUserId,
              createdGte ? `from ${createdGte.toISOString()}` : "full history",
            ),
          ],
          $slice: -50,
        },
      },
    }).exec();
    if (started.matchedCount === 0) return leaseLost();
  }

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
      { returnDocument: "after" },
    )
      .lean<StripePayoutHistoryCoverageDocument>()
      .exec();
    if (!written) return leaseLost();
    return {
      mode,
      outcome,
      state: written.state,
      pagesThisCall,
      observedThisCall,
      completeAsOf: written.completeAsOf ?? null,
      error,
    };
  };
  const providerFailure = (message: string) =>
    finish("PROVIDER_ERROR", { $set: { lastError: message.slice(0, 500) } }, message);

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
      return providerFailure(message);
    }
    if (page.payouts.some((p) => modeOf(p) !== mode))
      return providerFailure("Stripe returned payouts for a different mode");
    if (page.payouts.length === 0 && page.hasMore)
      return providerFailure("Stripe returned an empty page that claims more results");
    if (cursor && page.payouts.some((p) => p.id === cursor))
      return providerFailure("Stripe repeated an already-read page; the cursor did not advance");
    // Stripe filters by whole seconds (the gateway floors `created.gte`).
    const windowStartMs = run.createdGte
      ? Math.floor(run.createdGte.getTime() / 1000) * 1000
      : Number.NEGATIVE_INFINITY;
    if (page.payouts.some((p) => p.created.getTime() < windowStartMs))
      return providerFailure("Stripe returned payouts outside the requested date window");

    const linkage = await classifyPayoutLinkage(page.payouts);
    let conflicts = 0;
    for (const payout of page.payouts) {
      const outcome = await observeProviderPayout(
        payout,
        {
          accountId,
          ...(payout.destinationId
            ? { destinationLast4: last4ByDestination.get(payout.destinationId) }
            : {}),
        },
        "HISTORY_SYNC",
        undefined,
        linkage.get(payout.id),
      );
      if (outcome === "ACCOUNT_CONFLICT") conflicts += 1;
    }
    // Evidence that contradicts the account scope stops the run before the checkpoint moves, so
    // the conflicting page is never skipped and coverage cannot complete over it.
    if (conflicts > 0)
      return providerFailure(
        `${conflicts} payout(s) on this page are already recorded under a different Stripe account`,
      );
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
    if (saved.matchedCount === 0) return leaseLost();
  }
  return finish("PAUSED_AT_PAGE_LIMIT", { $unset: { lastError: 1 } }, null);
}

// --- Read-only reconciliation readiness --------------------------------------------------------

export type ReconciliationBlocker = { code: string; message: string };

/**
 * A read-only evidence status for future withdrawal-eligibility checks. `evidenceComplete: true`
 * only means Bookly holds complete, fully linked, fresh payout evidence for the CURRENT Stripe
 * account up to `completeAsOf`; it is NOT permission to withdraw and grants no authority. Any
 * blocker means evidence is incomplete.
 */
export type ReconciliationReadiness = {
  mode: CentralStripeMode | null;
  evidenceComplete: boolean;
  reviewNeeded: boolean;
  /** FG03B-2 — false when the current Stripe account could not be identified: nothing is counted. */
  accountVerified: boolean;
  coverage: {
    state: HistoryCoverageState;
    completeAsOf: Date | null;
    lastCompletedAt: Date | null;
    lastRunAt: Date | null;
    runInProgress: { pages: number; observed: number; windowStart: Date | null } | null;
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
    /** Status could still change (in flight or paid within the failure window). */
    unsettled: number;
    /** Unsettled and not re-confirmed by Stripe within the staleness period. */
    stale: number;
    /** Retained observations of other Stripe accounts: excluded from every count above. */
    otherAccounts: number;
  };
  freshness: {
    historyStale: boolean;
    staleAfterHours: number;
    paidFailureWindowDays: number;
  };
  unresolvedWithdrawalOperations: number;
  syncEnabled: boolean;
  blockers: ReconciliationBlocker[];
};

const FRESHNESS_POLICY = {
  staleAfterHours: OBSERVATION_STALE_AFTER_MS / 3_600_000,
  paidFailureWindowDays: PAID_FAILURE_WINDOW_MS / 86_400_000,
};
const EMPTY_COUNTS = {
  total: 0,
  verifiedBookly: 0,
  notVerified: 0,
  unresolved: 0,
  inFlight: 0,
  unsettled: 0,
  stale: 0,
  otherAccounts: 0,
};

export async function readReconciliationReadiness(input: {
  mode: CentralStripeMode | null;
  currentAccountId: string | undefined;
  syncEnabled: boolean;
  now?: Date;
}): Promise<ReconciliationReadiness> {
  const { mode } = input;
  const now = input.now ?? new Date();
  const blockers: ReconciliationBlocker[] = [];
  if (!mode) {
    return {
      mode: null,
      evidenceComplete: false,
      reviewNeeded: false,
      accountVerified: false,
      coverage: {
        state: "NEVER_RUN",
        completeAsOf: null,
        lastCompletedAt: null,
        lastRunAt: null,
        runInProgress: null,
        lastError: null,
        accountMatches: null,
      },
      observations: { ...EMPTY_COUNTS },
      freshness: { historyStale: false, ...FRESHNESS_POLICY },
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
  const accountId = input.currentAccountId;
  const count = (filter: ObservationFilter) =>
    accountId
      ? StripePayoutObservationModel.countDocuments({ $and: [{ accountId, mode }, filter] }).exec()
      : Promise.resolve(0);
  const [
    coverage,
    total,
    verifiedBookly,
    notVerified,
    unresolved,
    inFlight,
    unsettled,
    stale,
    otherAccounts,
    unresolvedOps,
  ] = await Promise.all([
    StripePayoutHistoryCoverageModel.findOne({ mode })
      .lean<StripePayoutHistoryCoverageDocument>()
      .exec(),
    count({}),
    count({ linkage: "VERIFIED_BOOKLY" }),
    count({ linkage: "NOT_VERIFIED" }),
    count({ linkage: "UNRESOLVED" }),
    count({ status: { $nin: ["paid", ...TERMINAL_STATUSES] } }),
    count(unsettledFilter(now)),
    count(staleFilter(now)),
    accountId
      ? StripePayoutObservationModel.countDocuments({ mode, accountId: { $ne: accountId } }).exec()
      : Promise.resolve(0),
    CentralPayoutOperationModel.countDocuments({
      mode,
      state: { $in: ["PREPARED", "UNKNOWN"] },
    }).exec(),
  ]);

  const state: HistoryCoverageState = coverage?.state ?? "NEVER_RUN";
  const accountMatches = accountId && coverage?.accountId ? coverage.accountId === accountId : null;
  const historyStale =
    state === "COMPLETE" &&
    !!coverage?.completeAsOf &&
    coverage.completeAsOf.getTime() < now.getTime() - HISTORY_STALE_AFTER_MS;

  if (!accountId)
    blockers.push({
      code: "PROVIDER_ACCOUNT_UNVERIFIED",
      message:
        "The current Stripe account could not be identified, so no payout evidence is counted.",
    });
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
  if (accountId && state !== "NEVER_RUN" && accountMatches === null)
    blockers.push({
      code: "PROVIDER_ACCOUNT_UNVERIFIED",
      message: "The history coverage has no recorded Stripe account to compare with.",
    });
  if (historyStale)
    blockers.push({
      code: "HISTORY_STALE",
      message:
        "The last complete history read is more than 24 hours old; payouts created since rely on webhook delivery.",
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
  if (unsettled - inFlight > 0)
    blockers.push({
      code: "PAYOUTS_WITHIN_FAILURE_WINDOW",
      message: `${unsettled - inFlight} payout(s) were paid within the last ${FRESHNESS_POLICY.paidFailureWindowDays} days; Stripe can still report a paid payout as failed.`,
    });
  if (stale > 0)
    blockers.push({
      code: "OBSERVATIONS_STALE",
      message: `${stale} unsettled payout(s) have not been re-confirmed by Stripe in the last ${FRESHNESS_POLICY.staleAfterHours} hours; a webhook may have been missed. Read the payout history again.`,
    });

  return {
    mode,
    evidenceComplete: blockers.length === 0,
    reviewNeeded: notVerified > 0 || unresolved > 0 || unresolvedOps > 0 || stale > 0,
    accountVerified: Boolean(accountId),
    coverage: {
      state,
      completeAsOf: coverage?.completeAsOf ?? null,
      lastCompletedAt: coverage?.lastCompletedAt ?? null,
      lastRunAt: coverage?.lastRunAt ?? null,
      runInProgress: coverage?.run
        ? {
            pages: coverage.run.pages,
            observed: coverage.run.observed,
            windowStart: coverage.run.createdGte ?? null,
          }
        : null,
      lastError: coverage?.lastError ?? null,
      accountMatches,
    },
    observations: {
      total,
      verifiedBookly,
      notVerified,
      unresolved,
      inFlight,
      unsettled,
      stale,
      otherAccounts,
    },
    freshness: { historyStale, ...FRESHNESS_POLICY },
    unresolvedWithdrawalOperations: unresolvedOps,
    syncEnabled: input.syncEnabled,
    blockers,
  };
}

// --- Read-only observed-payout review ----------------------------------------------------------

export type ObservedPayoutReviewReason = "NOT_VERIFIED" | "UNRESOLVED" | "STALE";

/** Masked, non-monetary review row. No metadata, no bank ids, no provider free text. */
export type ObservedPayoutView = {
  providerPayoutId: string;
  mode: CentralStripeMode;
  amountCents: number;
  currency: string;
  status: string;
  automatic: boolean;
  created: Date;
  arrivalDate: Date | null;
  failureCode: string | null;
  destinationLast4: string | null;
  linkage: PayoutLinkage;
  /** Only for VERIFIED_BOOKLY: the Bookly withdrawal that recorded this payout id. */
  booklyOperationId: string | null;
  /** Only for UNRESOLVED: the Bookly withdrawal the payout metadata names (unconfirmed). */
  namedOperationId: string | null;
  firstObservedVia: PayoutObservationSource;
  firstObservedAt: Date;
  lastObservedAt: Date;
  settlement: "SETTLED" | "UNSETTLED";
  stale: boolean;
  reviewReasons: ObservedPayoutReviewReason[];
};

export type ObservedPayoutQuery = {
  accountId: string;
  mode: CentralStripeMode;
  linkage?: PayoutLinkage | undefined;
  status?: string | undefined;
  needsReview?: boolean | undefined;
  createdFrom?: Date | undefined;
  createdBefore?: Date | undefined;
  page: number;
  limit: number;
  now?: Date;
};

export async function listObservedPayouts(
  query: ObservedPayoutQuery,
): Promise<{ items: ObservedPayoutView[]; total: number }> {
  const now = query.now ?? new Date();
  const conditions: ObservationFilter[] = [{ accountId: query.accountId, mode: query.mode }];
  if (query.linkage) conditions.push({ linkage: query.linkage });
  if (query.status) conditions.push({ status: query.status });
  if (query.createdFrom || query.createdBefore)
    conditions.push({
      providerCreatedAt: {
        ...(query.createdFrom ? { $gte: query.createdFrom } : {}),
        ...(query.createdBefore ? { $lt: query.createdBefore } : {}),
      },
    });
  if (query.needsReview)
    conditions.push({ $or: [{ linkage: { $ne: "VERIFIED_BOOKLY" } }, staleFilter(now)] });
  const filter = { $and: conditions };
  const [rows, total] = await Promise.all([
    StripePayoutObservationModel.find(filter)
      .sort({ providerCreatedAt: -1, providerPayoutId: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean<StripePayoutObservationDocument[]>()
      .exec(),
    StripePayoutObservationModel.countDocuments(filter).exec(),
  ]);
  const staleCutoff = now.getTime() - OBSERVATION_STALE_AFTER_MS;
  return {
    total,
    items: rows.map((row) => {
      const unsettled = isUnsettled(row, now);
      const stale = unsettled && row.lastObservedAt.getTime() < staleCutoff;
      const reviewReasons: ObservedPayoutReviewReason[] = [];
      if (row.linkage === "NOT_VERIFIED") reviewReasons.push("NOT_VERIFIED");
      if (row.linkage === "UNRESOLVED") reviewReasons.push("UNRESOLVED");
      if (stale) reviewReasons.push("STALE");
      return {
        providerPayoutId: row.providerPayoutId,
        mode: row.mode,
        amountCents: row.amountCents,
        currency: row.currency,
        status: row.status,
        automatic: row.automatic,
        created: row.providerCreatedAt,
        arrivalDate: row.arrivalDate ?? null,
        failureCode: row.failureCode ?? null,
        destinationLast4: row.destinationLast4 ?? null,
        linkage: row.linkage,
        booklyOperationId:
          row.linkage === "VERIFIED_BOOKLY" && row.operationId ? String(row.operationId) : null,
        namedOperationId:
          row.linkage === "UNRESOLVED" && row.claimedOperationId
            ? String(row.claimedOperationId)
            : null,
        firstObservedVia: row.firstObservedVia,
        firstObservedAt: row.firstObservedAt,
        lastObservedAt: row.lastObservedAt,
        settlement: unsettled ? "UNSETTLED" : "SETTLED",
        stale,
        reviewReasons,
      };
    }),
  };
}
