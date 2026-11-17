import { Types } from "mongoose";
import { AppError } from "../../common/errors/app-error.js";
import { logger } from "../../config/logger.js";
import {
  type CentralAccountPayoutState,
  type CentralBankDestination,
  type CentralPayoutGateway,
  CentralPayoutProviderError,
  type CentralStripeMode,
  type ProviderPayout,
  type ProviderPayoutStatus,
  providerPayoutStatuses,
} from "./central-payout.types.js";
import {
  type CentralPayoutAuditEntry,
  type CentralPayoutOperationDocument,
  CentralPayoutOperationModel,
} from "./central-payout-operation.model.js";
import {
  classifyPayoutLinkage,
  coverageVerifiedAsOf,
  EVIDENCE_FRESHNESS_TARGET_MS,
  type HistorySyncResult,
  listObservedPayouts,
  type ObservedPayoutView,
  observeWebhookPayout,
  PayoutHistorySyncError,
  promoteObservationLinkage,
  type ReconciliationReadiness,
  readReconciliationReadiness,
  syncProviderPayoutHistory,
} from "./payout-reconciliation.js";
import {
  type PayoutLinkage,
  type StripePayoutHistoryCoverageDocument,
  StripePayoutHistoryCoverageModel,
  StripePayoutObservationModel,
} from "./stripe-payout-observation.model.js";
import {
  evaluateWithdrawalEligibility,
  type WithdrawalEligibility,
} from "./withdrawal-eligibility.js";

/** FG03B-2 — one page of the read-only observed-payout review, always scoped to the current
 * verified Stripe platform account. Provider evidence only: never a ledger, never a permission. */
export type ObservedPayoutPage = {
  mode: CentralStripeMode;
  /** False when the requested mode differs from the configured key's mode. */
  modeIsCurrent: boolean;
  accountVerified: true;
  items: ObservedPayoutView[];
  pagination: { page: number; limit: number; total: number };
  evidence: {
    coverageState: "NEVER_RUN" | "IN_PROGRESS" | "COMPLETE";
    completeAsOf: Date | null;
    coverageAccountMatches: boolean | null;
    /** FG03B-3 — every listed payout's status was re-read from Stripe at/after this time. */
    statusVerifiedAsOf: Date | null;
    verificationStale: boolean;
    verificationInProgress: boolean;
    lastError: string | null;
    otherAccountObservations: number;
  };
};

export class CentralPayoutError extends AppError {
  public constructor(code: string, message: string, statusCode: number) {
    super(message, statusCode, { details: [{ code, message }], expose: true });
  }
}

/** Stripe idempotency keys are retained for at least 24 hours; resending after that could create
 * a second payout, so recovery stops resending well before. */
const RESEND_WINDOW_MS = 23 * 60 * 60 * 1000;
const METADATA_KEY = "booklyCentralPayoutOperationId";
const SENDABLE_DESTINATION_STATUSES = new Set(["new", "validated", "verified"]);

/** Order of Stripe's lifecycle. A later-or-equal rank may replace the current status, so a `paid`
 * payout can still become `failed`, but a `failed` one is never turned back into `paid`. */
const STATUS_RANK: Record<ProviderPayoutStatus, number> = {
  pending: 0,
  in_transit: 1,
  paid: 2,
  failed: 3,
  canceled: 3,
};
const isProviderStatus = (value: string): value is ProviderPayoutStatus =>
  (providerPayoutStatuses as readonly string[]).includes(value);

export type CentralPayoutPolicy = {
  /** Necessary deployment flag only; the independent reserve-policy denial still applies. */
  liveExecutionEnabled: boolean;
  /** FG03B-1 — operator-triggered Stripe payout history sync. Off unless the deployment
   * explicitly enables it after provisioning is approved. Read-only towards money either way. */
  historySyncEnabled?: boolean;
};

type Restriction = { code: string; message: string };

/**
 * FG03B-0/1 — origin is BOOKLY_WITHDRAWAL only when a CentralPayoutOperation already records this
 * exact Stripe payout id in the same mode (the id is written from Stripe's own response or a
 * verified webhook). Payout metadata alone is NOT trusted as proof: metadata naming a same-mode
 * Bookly operation that has not confirmed any payout yet is LINKAGE_UNRESOLVED. Everything else
 * is NOT_VERIFIED: possibly a Dashboard or automatic payout. It is never labelled unauthorized.
 */
export type RecentStripePayoutView = {
  id: string;
  amountCents: number;
  currency: string;
  status: string;
  created: Date;
  /** Stripe's estimate only; not proof of a bank statement entry. */
  arrivalDate: Date | null;
  automatic: boolean;
  livemode: boolean;
  failureCode: string | null;
  destinationLast4: string | null;
  origin: "BOOKLY_WITHDRAWAL" | "LINKAGE_UNRESOLVED" | "NOT_VERIFIED";
  booklyOperationId: string | null;
};

const RECENT_PAYOUT_REQUEST_LIMIT = 100;
const RECENT_PAYOUTS_SHOWN = 10;

export type CentralPayoutOverview = {
  mode: CentralStripeMode | null;
  liveExecutionEnabled: boolean;
  balances: { currency: string; availableCents: number; pendingCents: number }[];
  /** Sum of Stripe payouts still pending / in transit among the most recent 100, per currency. */
  payoutsInProgress: { currency: string; amountCents: number }[];
  destinations: (CentralBankDestination & { eligible: boolean })[];
  scheduleInterval: string | null;
  /** Reasons a new withdrawal cannot be made right now (empty = permitted). */
  restrictions: Restriction[];
  /** FG03B-0 — read-only view of the most recent Stripe payouts (any origin). No metadata, no
   * bank-account ids: the destination is shown only as the masked last 4 of a known account. */
  recentStripePayouts: RecentStripePayoutView[];
  /** FG03B-0 — what the list above covers. It is a bounded recent sample, never a complete
   * payout history, so a payout absent from it proves nothing. */
  recentStripePayoutsScope: { shown: number; returnedByStripe: number; requestLimit: number };
  /** Recorded Business-attributed amounts not yet paid out to Businesses (informational: Bookly
   * has no approved reserve formula, so this is NOT subtracted from the Stripe balance). */
  businessAttributedUnpaid: { currency: string; amountCents: number } | null;
  /** FG03B-1 — read-only payout-evidence status (database reads only). Never a permission. */
  reconciliation: ReconciliationReadiness;
};

export type CentralPayoutDeps = {
  gateway: CentralPayoutGateway;
  policy: CentralPayoutPolicy;
  /** Step-up: throws unless the Super Admin's current password verifies; returns their email. */
  verifyStepUp: (userId: string, password: string | undefined) => Promise<{ email: string }>;
  businessAttributedUnpaid?: () => Promise<{ currency: string; amountCents: number } | null>;
};

export class CentralPayoutService {
  public constructor(private readonly deps: CentralPayoutDeps) {}

  /** Independent read: a balance/history outage must not imply that no bank is configured.
   * Only provider-owned masked metadata crosses this boundary; no local bank record exists. */
  public async getBankAccountSummary() {
    const mode = this.deps.gateway.mode() ?? null;
    const base = { mode, managedBy: "STRIPE" as const };
    if (!mode)
      return { ...base, state: "NOT_CONFIGURED" as const, payoutsEnabled: null, destinations: [] };
    try {
      const account = await this.deps.gateway.retrieveAccountPayoutState();
      if (!account.destinationsReadable)
        return {
          ...base,
          state: "UNAVAILABLE" as const,
          payoutsEnabled: account.payoutsEnabled,
          inventoryComplete: false,
          unavailableReason: account.destinationReadIssue ?? "INCOMPLETE",
          destinations: [],
        };
      const destinations = account.destinations.map((bank) => ({
        bankName: bank.bankName,
        last4: /^[a-z0-9]{4}$/i.test(bank.last4) ? bank.last4 : null,
        currency: bank.currency || null,
        country: bank.country || null,
        status: bank.status || null,
        defaultForCurrency: bank.defaultForCurrency,
      }));
      return {
        ...base,
        state: destinations.length
          ? ("CONFIGURED" as const)
          : account.destinationsComplete === false
            ? ("UNAVAILABLE" as const)
            : ("NO_DESTINATION" as const),
        payoutsEnabled: account.payoutsEnabled,
        inventoryComplete: account.destinationsComplete !== false,
        ...(account.destinationReadIssue
          ? { unavailableReason: account.destinationReadIssue }
          : {}),
        destinations,
      };
    } catch {
      // Do not echo provider errors: they may contain request data or credentials.
      return {
        ...base,
        state: "UNAVAILABLE" as const,
        payoutsEnabled: null,
        inventoryComplete: false,
        unavailableReason: "PROVIDER" as const,
        destinations: [],
      };
    }
  }

  // --- Read ---------------------------------------------------------------------------------

  public async getOverview(): Promise<CentralPayoutOverview> {
    const mode = this.deps.gateway.mode() ?? null;
    const [balance, account, recent, unpaid] = await Promise.all([
      this.provider(() => this.deps.gateway.retrieveBalance()),
      this.provider(() => this.deps.gateway.retrieveAccountPayoutState()),
      this.provider(() =>
        this.deps.gateway.listRecentPayouts({ limit: RECENT_PAYOUT_REQUEST_LIMIT }),
      ),
      this.deps.businessAttributedUnpaid?.() ?? Promise.resolve(null),
    ]);
    const currencies = [
      ...new Set([...balance.available, ...balance.pending].map((b) => b.currency)),
    ];
    const inProgress = new Map<string, number>();
    for (const payout of recent)
      if (payout.status === "pending" || payout.status === "in_transit")
        inProgress.set(
          payout.currency,
          (inProgress.get(payout.currency) ?? 0) + payout.amountCents,
        );
    return {
      mode,
      // CW-1 — the deployment flag; every LIVE request still needs AVAILABLE eligibility.
      liveExecutionEnabled: this.deps.policy.liveExecutionEnabled,
      balances: currencies.map((currency) => ({
        currency,
        availableCents: balance.available.find((b) => b.currency === currency)?.amountCents ?? 0,
        pendingCents: balance.pending.find((b) => b.currency === currency)?.amountCents ?? 0,
      })),
      payoutsInProgress: [...inProgress].map(([currency, amountCents]) => ({
        currency,
        amountCents,
      })),
      destinations: account.destinations.map((d) => ({
        ...d,
        eligible: this.isEligible(d, account),
      })),
      scheduleInterval: account.scheduleInterval,
      restrictions: [
        ...this.executionRestrictions(mode, balance.livemode),
        ...this.accountRestrictions(account),
        ...(await this.inFlightRestriction()),
      ],
      recentStripePayouts: await this.recentPayoutViews(
        recent.slice(0, RECENT_PAYOUTS_SHOWN),
        account.destinations,
      ),
      recentStripePayoutsScope: {
        shown: Math.min(recent.length, RECENT_PAYOUTS_SHOWN),
        returnedByStripe: recent.length,
        requestLimit: RECENT_PAYOUT_REQUEST_LIMIT,
      },
      businessAttributedUnpaid: unpaid,
      reconciliation: await readReconciliationReadiness({
        mode,
        currentAccountId: account.accountId,
        syncEnabled: this.deps.policy.historySyncEnabled === true,
      }),
    };
  }

  /** CW-1 — the authoritative, server-side withdrawal eligibility the Super Admin reviews. */
  public async getEligibility(): Promise<WithdrawalEligibility> {
    return (await this.evaluateEligibility()).eligibility;
  }

  /** Reads Stripe (balance, account) and evidence once and evaluates eligibility from them; the
   * same evaluation backs the review, the confirmation and the pre-dispatch revalidation. */
  private async evaluateEligibility(excludeOperationId?: Types.ObjectId) {
    const mode = this.deps.gateway.mode() ?? null;
    const [balance, account, outstanding] = await Promise.all([
      this.provider(() => this.deps.gateway.retrieveBalance()),
      this.provider(() => this.deps.gateway.retrieveAccountPayoutState()),
      this.deps.businessAttributedUnpaid?.() ?? Promise.resolve(null),
    ]);
    const readiness = await readReconciliationReadiness({
      mode,
      currentAccountId: account.accountId,
      syncEnabled: this.deps.policy.historySyncEnabled === true,
    });
    const eligibility = await evaluateWithdrawalEligibility({
      mode,
      accountId: account.accountId,
      balance,
      readiness,
      businessOutstanding: outstanding,
      ...(excludeOperationId ? { excludeOperationId } : {}),
    });
    return { eligibility, balance, account };
  }

  /** FG03B-0/1 — read-only. Uses the shared linkage classifier (see RecentStripePayoutView);
   * bounded indexed queries, no writes on a dashboard load. */
  private async recentPayoutViews(
    payouts: ProviderPayout[],
    destinations: CentralBankDestination[],
  ): Promise<RecentStripePayoutView[]> {
    const linkage = await classifyPayoutLinkage(payouts);
    return payouts.map((payout) => {
      const link = linkage.get(payout.id);
      const verified = link?.linkage === "VERIFIED_BOOKLY";
      return {
        id: payout.id,
        amountCents: payout.amountCents,
        currency: payout.currency,
        status: payout.status,
        created: payout.created,
        arrivalDate: payout.arrivalDate,
        automatic: payout.automatic,
        livemode: payout.livemode,
        failureCode: payout.failureCode,
        destinationLast4: destinations.find((d) => d.id === payout.destinationId)?.last4 ?? null,
        origin: verified
          ? "BOOKLY_WITHDRAWAL"
          : link?.linkage === "UNRESOLVED"
            ? "LINKAGE_UNRESOLVED"
            : "NOT_VERIFIED",
        booklyOperationId: verified && link?.operationId ? String(link.operationId) : null,
      };
    });
  }

  public async list(page: number, limit: number) {
    const [items, total] = await Promise.all([
      CentralPayoutOperationModel.find()
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean<CentralPayoutOperationDocument[]>()
        .exec(),
      CentralPayoutOperationModel.countDocuments().exec(),
    ]);
    return { items, total };
  }

  public async get(operationId: string): Promise<CentralPayoutOperationDocument> {
    if (!Types.ObjectId.isValid(operationId)) throw this.notFound();
    const op = await CentralPayoutOperationModel.findById(operationId)
      .lean<CentralPayoutOperationDocument>()
      .exec();
    if (!op) throw this.notFound();
    return op;
  }

  // --- Initiate -----------------------------------------------------------------------------

  public async initiate(
    actorUserId: string,
    input: {
      requestId: string;
      amountCents: number;
      currency: string;
      destinationId: string;
      currentPassword?: string | undefined;
      /** CW-1 — the eligibility digest the Super Admin reviewed; any change refuses the request. */
      eligibilityDigest: string;
    },
  ): Promise<CentralPayoutOperationDocument> {
    const requestKey = `${actorUserId}:${input.requestId}`;
    const replay = await CentralPayoutOperationModel.findOne({ requestKey })
      .lean<CentralPayoutOperationDocument>()
      .exec();
    if (replay) return this.assertSameRequest(replay, input);

    const actor = {
      userId: actorUserId,
      ...(await this.deps.verifyStepUp(actorUserId, input.currentPassword)),
    };

    const mode = this.deps.gateway.mode();
    const { eligibility, balance, account } = await this.evaluateEligibility();
    const blocking = [
      ...this.executionRestrictions(mode ?? null, balance.livemode),
      ...this.accountRestrictions(account),
    ];
    if (blocking[0]) throw new CentralPayoutError(blocking[0].code, blocking[0].message, 409);

    const destination = account.destinations.find((d) => d.id === input.destinationId);
    if (!destination || !this.isEligible(destination, account))
      throw new CentralPayoutError(
        "CENTRAL_PAYOUT_DESTINATION_INVALID",
        "Choose the bank account linked to Bookly's Stripe account",
        422,
      );
    if (destination.currency !== input.currency)
      throw new CentralPayoutError(
        "CENTRAL_PAYOUT_CURRENCY_MISMATCH",
        "The bank account does not receive this currency",
        422,
      );
    const available =
      balance.available.find((b) => b.currency === input.currency)?.amountCents ?? 0;
    if (input.amountCents > available)
      throw new CentralPayoutError(
        "CENTRAL_PAYOUT_INSUFFICIENT_BALANCE",
        "The amount is more than the available Stripe balance in this currency",
        422,
      );
    // CW-1 — the authoritative, server-side eligibility (never a client calculation).
    const decision = eligibility.currencies.find((c) => c.currency === input.currency);
    if (decision?.status !== "AVAILABLE")
      throw new CentralPayoutError(
        "CENTRAL_PAYOUT_ELIGIBILITY_UNAVAILABLE",
        decision?.blockers[0]?.message ??
          "No withdrawal amount can be established for this currency",
        409,
      );
    if (decision.digest !== input.eligibilityDigest)
      throw new CentralPayoutError(
        "CENTRAL_PAYOUT_ELIGIBILITY_CHANGED",
        "The financial evidence changed since you reviewed this withdrawal. Review the new eligible amount and confirm again.",
        409,
      );
    if (input.amountCents > decision.eligibleCents)
      throw new CentralPayoutError(
        "CENTRAL_PAYOUT_EXCEEDS_ELIGIBLE",
        "The amount is more than the eligible withdrawal amount",
        422,
      );

    const _id = new Types.ObjectId();
    let op: CentralPayoutOperationDocument;
    try {
      op = (
        await CentralPayoutOperationModel.create({
          _id,
          requestKey,
          initiatedByUserId: new Types.ObjectId(actor.userId),
          initiatedByEmail: actor.email,
          mode: mode as CentralStripeMode,
          amountCents: input.amountCents,
          currency: input.currency,
          destinationId: destination.id,
          destinationBankName: destination.bankName ?? undefined,
          destinationLast4: destination.last4,
          state: "PREPARED",
          // The unique slot admits one unresolved withdrawal: two requests can never both spend
          // the same eligibility.
          activeSlot: "CENTRAL",
          providerIdempotencyKey: `central-payout:${String(_id)}`,
          eligibility: {
            policyVersion: eligibility.policyVersion,
            digest: decision.digest,
            evaluatedAt: eligibility.evaluatedAt,
            eligibleCents: decision.eligibleCents,
            stripeAvailableCents: decision.stripeAvailableCents,
            ledgerHeldCents: decision.ledgerHeldCents ?? 0,
            protectedCents: decision.protected.totalCents,
          },
          audit: [this.entry("REQUESTED", "API", undefined, undefined, actor.userId)],
        })
      ).toObject();
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const raced = await CentralPayoutOperationModel.findOne({ requestKey })
        .lean<CentralPayoutOperationDocument>()
        .exec();
      if (raced) return this.assertSameRequest(raced, input);
      throw new CentralPayoutError(
        "CENTRAL_PAYOUT_IN_PROGRESS",
        "Another withdrawal is still being confirmed with Stripe. Refresh it before starting a new one.",
        409,
      );
    }
    logger.info(
      { event: "CENTRAL_PAYOUT_REQUESTED", operationId: String(op._id), mode: op.mode },
      "Central Stripe withdrawal requested",
    );
    return this.dispatch(op, "API");
  }

  // --- Recovery / sync ----------------------------------------------------------------------

  /** Resolves an unconfirmed request or refreshes a submitted payout from Stripe. Never creates a
   * payout under a new identity. */
  public async refresh(operationId: string): Promise<CentralPayoutOperationDocument> {
    const op = await this.get(operationId);
    if (op.state === "REJECTED") return op;
    if (op.state === "SUBMITTED") {
      if (!op.providerPayoutId) return op;
      const payout = await this.provider(() =>
        this.deps.gateway.retrievePayout(op.providerPayoutId as string),
      );
      return this.applyProviderPayout(op, payout, "REFRESH");
    }
    // PREPARED or UNKNOWN: first look for a payout Stripe already created for this operation.
    const createdAtMs = op.createdAt instanceof Date ? op.createdAt.getTime() : Number.NaN;
    const observedNow = Date.now();
    const since = new Date(createdAtMs - 5 * 60 * 1000);
    const recent = await this.provider(() =>
      this.deps.gateway.listRecentPayouts({
        ...(Number.isFinite(since.getTime()) &&
        Number.isFinite(observedNow) &&
        createdAtMs <= observedNow
          ? { createdGte: since }
          : {}),
        limit: 100,
      }),
    );
    const found = recent.find((p) => p.metadata[METADATA_KEY] === String(op._id));
    if (found) return this.applyProviderPayout(op, found, "RECOVERY");
    const ageMs = Date.now() - createdAtMs;
    const ageKnown = Number.isSafeInteger(ageMs) && ageMs >= 0;
    if (!ageKnown || ageMs >= RESEND_WINDOW_MS) {
      return this.audit(
        op,
        this.entry(
          "REQUIRES_REVIEW",
          "RECOVERY",
          ageKnown
            ? "No matching Stripe payout found and the idempotency window has passed; not resent"
            : "Operation age could not be established; idempotency window is unproven, not resent",
        ),
      );
    }
    // Same idempotency key and identical parameters: Stripe returns the original payout if it
    // exists, so this can never create a second one.
    return this.dispatch(op, "RECOVERY");
  }

  /** Webhook entry point for payout.* events (already deduplicated by Stripe event id).
   * `eventAccount` is the Stripe event's own `account` (set only for connected-account events). */
  public async syncFromWebhook(
    payout: ProviderPayout,
    providerEventId: string,
    eventAccount?: string | null,
  ): Promise<void> {
    const operationId = payout.metadata[METADATA_KEY];
    const op = await CentralPayoutOperationModel.findOne(
      operationId && Types.ObjectId.isValid(operationId)
        ? { $or: [{ providerPayoutId: payout.id }, { _id: new Types.ObjectId(operationId) }] }
        : { providerPayoutId: payout.id },
    )
      .lean<CentralPayoutOperationDocument>()
      .exec();
    // A Bookly operation (if any) is updated first, exactly as before, so the observation below
    // links it. Payouts Bookly did not request (e.g. Stripe Dashboard or automatic payouts) never
    // become withdrawal operations: FG03B-1 records them only as non-monetary observations.
    if (op) await this.applyProviderPayout(op, payout, "WEBHOOK", providerEventId);
    // FG03B-2 — scoped to the platform account of the configured key; throws (event retryable)
    // when that account cannot be identified, so evidence is never recorded unscoped.
    await observeWebhookPayout(this.deps.gateway, payout, providerEventId, eventAccount);
  }

  /** FG03B-2 — read-only review of observed Stripe payouts beyond the recent sample: database
   * reads only (no Stripe payout listing), scoped to the current verified platform account. */
  public async listObservedPayouts(input: {
    mode?: CentralStripeMode | undefined;
    linkage?: PayoutLinkage | undefined;
    status?: string | undefined;
    needsReview?: boolean | undefined;
    createdFrom?: Date | undefined;
    createdBefore?: Date | undefined;
    page: number;
    limit: number;
  }): Promise<ObservedPayoutPage> {
    const currentMode = this.deps.gateway.mode();
    if (!currentMode)
      throw new CentralPayoutError(
        "CENTRAL_PAYOUT_STRIPE_NOT_CONFIGURED",
        "Stripe is not configured with a recognised TEST or LIVE secret key",
        409,
      );
    let accountId: string;
    try {
      accountId = await this.deps.gateway.platformAccountId();
    } catch {
      // Fail closed: without a verified account no observation may be shown as current evidence.
      throw new CentralPayoutError(
        "CENTRAL_PAYOUT_ACCOUNT_UNIDENTIFIED",
        "The current Stripe account could not be identified, so payout evidence cannot be shown",
        409,
      );
    }
    const mode = input.mode ?? currentMode;
    const now = new Date();
    const coverage = await StripePayoutHistoryCoverageModel.findOne({ mode })
      .lean<StripePayoutHistoryCoverageDocument>()
      .exec();
    // Only a complete full read of THIS account vouches for statuses (FG03B-3).
    const statusVerifiedAsOf = coverageVerifiedAsOf(coverage, accountId);
    const [page, otherAccountObservations] = await Promise.all([
      listObservedPayouts({ ...input, accountId, mode, now, verifiedAsOf: statusVerifiedAsOf }),
      StripePayoutObservationModel.countDocuments({ mode, accountId: { $ne: accountId } }).exec(),
    ]);
    const coverageState = coverage?.state ?? "NEVER_RUN";
    return {
      mode,
      modeIsCurrent: mode === currentMode,
      accountVerified: true,
      items: page.items,
      pagination: { page: input.page, limit: input.limit, total: page.total },
      evidence: {
        coverageState,
        completeAsOf: coverage?.completeAsOf ?? null,
        coverageAccountMatches: coverage?.accountId ? coverage.accountId === accountId : null,
        statusVerifiedAsOf,
        verificationStale:
          !!statusVerifiedAsOf &&
          statusVerifiedAsOf.getTime() < now.getTime() - EVIDENCE_FRESHNESS_TARGET_MS,
        verificationInProgress: Boolean(coverage?.run),
        lastError: coverage?.lastError ?? null,
        otherAccountObservations,
      },
    };
  }

  /** FG03B-1 — operator-triggered, bounded, resumable Stripe payout history read. Super Admin
   * only (router gate), disabled unless the deployment enables it, audited on the checkpoint.
   * It only reads Stripe and writes observations/coverage: never a payout or a ledger row. */
  public async syncProviderHistory(
    actorUserId: string,
    input: { maxPages?: number | undefined; trigger?: "OPERATOR" | "WORKER" | undefined } = {},
  ): Promise<HistorySyncResult> {
    if (!this.deps.policy.historySyncEnabled)
      throw new CentralPayoutError(
        "CENTRAL_PAYOUT_HISTORY_SYNC_DISABLED",
        "Stripe payout history sync is not enabled in this deployment",
        409,
      );
    try {
      return await syncProviderPayoutHistory(this.deps.gateway, actorUserId, {
        ...(input.maxPages ? { maxPages: input.maxPages } : {}),
        ...(input.trigger ? { trigger: input.trigger } : {}),
      });
    } catch (error) {
      if (error instanceof PayoutHistorySyncError)
        throw new CentralPayoutError(error.code, error.message, error.statusCode);
      if (error instanceof CentralPayoutProviderError)
        throw new CentralPayoutError("CENTRAL_PAYOUT_PROVIDER_UNAVAILABLE", error.message, 502);
      throw error;
    }
  }

  // --- Internals ----------------------------------------------------------------------------

  private async dispatch(
    op: CentralPayoutOperationDocument,
    source: "API" | "RECOVERY",
  ): Promise<CentralPayoutOperationDocument> {
    const mode = this.deps.gateway.mode();
    const guard = this.executionRestrictions(mode ?? null, op.mode === "LIVE")[0];
    if (guard || mode !== op.mode) {
      const reason = guard?.message ?? "Stripe mode changed since the request";
      // Never sent to Stripe: close it so it cannot block later withdrawals. Once sent, only
      // Stripe evidence may resolve it.
      if (op.dispatchCount === 0)
        return this.update(
          op,
          { state: "PREPARED", dispatchCount: 0 },
          {
            $set: { state: "REJECTED", failureMessage: `Not sent: ${reason}`.slice(0, 500) },
            $unset: { activeSlot: 1 },
            $push: { audit: this.entry("BLOCKED", source, reason) },
          },
        );
      return this.audit(op, this.entry("BLOCKED", source, reason));
    }
    // CW-1 — revalidate eligibility immediately before calling Stripe (after the reservation is
    // committed, outside any database transaction). This operation itself is excluded; anything
    // else that changed since review (balance, payouts, protected refunds/disputes, evidence)
    // must still cover the immutable amount.
    let revalidated: CentralPayoutOperationDocument | null = null;
    try {
      const { eligibility } = await this.evaluateEligibility(op._id);
      const decision = eligibility.currencies.find((c) => c.currency === op.currency);
      if (decision?.status !== "AVAILABLE" || op.amountCents > decision.eligibleCents) {
        const why =
          decision?.status === "AVAILABLE"
            ? `eligible amount is now ${decision.eligibleCents}`
            : (decision?.blockers[0]?.message ?? "eligibility unavailable");
        revalidated =
          op.dispatchCount === 0
            ? await this.update(
                op,
                { state: "PREPARED", dispatchCount: 0 },
                {
                  $set: {
                    state: "REJECTED",
                    failureMessage: `Not sent: eligibility changed (${why})`.slice(0, 500),
                  },
                  $unset: { activeSlot: 1 },
                  $push: {
                    audit: {
                      $each: [
                        this.entry("BLOCKED", source, `Eligibility changed: ${why}`),
                        this.entry("RESERVATION_RELEASED", source, "Never sent to Stripe"),
                      ],
                    },
                  },
                },
              )
            : // Possibly already at Stripe: never resend against insufficient eligibility.
              await this.audit(
                op,
                this.entry(
                  "REQUIRES_REVIEW",
                  source,
                  `Not resent: eligibility no longer covers it (${why})`,
                ),
              );
      }
    } catch {
      // Provider or evidence read failed: never send blind. The operation keeps its reservation
      // and identity; Refresh retries the same operation later.
      revalidated = await this.audit(
        op,
        this.entry("BLOCKED", source, "Eligibility could not be revalidated; not sent"),
      );
    }
    if (revalidated) return revalidated;
    await CentralPayoutOperationModel.updateOne(
      { _id: op._id },
      {
        $inc: { dispatchCount: 1 },
        $set: { lastDispatchedAt: new Date() },
        $push: { audit: this.entry("DISPATCHED", source) },
      },
    ).exec();
    try {
      const payout = await this.deps.gateway.createPayout({
        amountCents: op.amountCents,
        currency: op.currency,
        destinationId: op.destinationId,
        idempotencyKey: op.providerIdempotencyKey,
        metadata: { [METADATA_KEY]: String(op._id) },
      });
      return this.applyProviderPayout(op, payout, source);
    } catch (error) {
      const failure =
        error instanceof CentralPayoutProviderError
          ? error
          : new CentralPayoutProviderError("Stripe request failed", false);
      if (failure.definitive) {
        return this.update(
          op,
          { state: { $in: ["PREPARED", "UNKNOWN"] } },
          {
            $set: {
              state: "REJECTED",
              failureCode: failure.code ?? undefined,
              failureMessage: failure.message.slice(0, 500),
            },
            $unset: { activeSlot: 1 },
            $push: {
              audit: {
                $each: [
                  this.entry("PROVIDER_REJECTED", source, failure.message),
                  this.entry("RESERVATION_RELEASED", source, "Stripe certainly created no payout"),
                ],
              },
            },
          },
        );
      }
      logger.warn(
        { event: "CENTRAL_PAYOUT_OUTCOME_UNKNOWN", operationId: String(op._id) },
        "Central withdrawal outcome not confirmed; refresh reconciles the same operation",
      );
      return this.update(
        op,
        { state: { $in: ["PREPARED", "UNKNOWN"] } },
        {
          $set: { state: "UNKNOWN" },
          $push: { audit: this.entry("OUTCOME_UNKNOWN", source, failure.message) },
        },
      );
    }
  }

  private async applyProviderPayout(
    op: CentralPayoutOperationDocument,
    payout: ProviderPayout,
    source: NonNullable<CentralPayoutAuditEntry["source"]>,
    providerEventId?: string,
    retriesRemaining = 3,
  ): Promise<CentralPayoutOperationDocument> {
    const mismatch =
      payout.amountCents !== op.amountCents ||
      payout.currency !== op.currency ||
      payout.livemode !== (op.mode === "LIVE") ||
      payout.destinationId !== op.destinationId ||
      payout.automatic ||
      (op.providerPayoutId !== undefined && op.providerPayoutId !== payout.id) ||
      (payout.metadata[METADATA_KEY] !== undefined &&
        payout.metadata[METADATA_KEY] !== String(op._id));
    if (mismatch || !isProviderStatus(payout.status)) {
      logger.error(
        { event: "CENTRAL_PAYOUT_MISMATCH", operationId: String(op._id), payoutId: payout.id },
        "Stripe payout does not match the withdrawal operation",
      );
      return this.audit(
        op,
        this.entry(
          "MISMATCH",
          source,
          `Stripe payout ${payout.id} does not match`,
          providerEventId,
        ),
      );
    }
    const status = payout.status;
    const firstConfirmation = op.state !== "SUBMITTED";
    if (
      !firstConfirmation &&
      op.providerStatus &&
      STATUS_RANK[status] < STATUS_RANK[op.providerStatus]
    )
      return op; // Out-of-order older event.
    if (!firstConfirmation && op.providerStatus === status) {
      await CentralPayoutOperationModel.updateOne(
        { _id: op._id },
        { $set: { lastSyncedAt: new Date() } },
      ).exec();
      return { ...op, lastSyncedAt: new Date() };
    }
    const filter = firstConfirmation
      ? { state: { $in: ["PREPARED", "UNKNOWN"] } }
      : { state: "SUBMITTED", providerStatus: op.providerStatus };
    const entry = firstConfirmation
      ? this.entry(
          source === "RECOVERY" ? "RECOVERED" : "PROVIDER_ACCEPTED",
          source,
          `Stripe payout ${payout.id}: ${status}`,
          providerEventId,
        )
      : this.entry("STATUS_CHANGED", source, `${op.providerStatus} → ${status}`, providerEventId);
    // CW-1 — accepted, in-transit and paid payouts stay counted as cash out of Stripe; only a
    // Stripe-reported failure or cancellation returns them to eligibility (audited). Acceptance
    // alone never releases anything.
    const released =
      (status === "failed" || status === "canceled") &&
      op.providerStatus !== "failed" &&
      op.providerStatus !== "canceled";
    const entries = released
      ? [
          entry,
          this.entry(
            "RESERVATION_RELEASED",
            source,
            `Stripe reported the payout ${status}; funds return to the Stripe balance`,
            providerEventId,
          ),
        ]
      : [entry];
    const updated = await this.update(op, filter, {
      $set: {
        state: "SUBMITTED",
        providerPayoutId: payout.id,
        providerStatus: status,
        providerCreatedAt: payout.created,
        ...(payout.arrivalDate ? { estimatedArrivalAt: payout.arrivalDate } : {}),
        ...(payout.failureCode ? { failureCode: payout.failureCode } : {}),
        ...(payout.failureMessage ? { failureMessage: payout.failureMessage.slice(0, 500) } : {}),
        lastSyncedAt: new Date(),
      },
      $unset: { activeSlot: 1 },
      $push: { audit: { $each: entries } },
    });
    // FG03B-2 — the operation now records this exact payout id: an observation written earlier
    // (e.g. a webhook that arrived while the request was unconfirmed) becomes VERIFIED_BOOKLY,
    // whichever path (response, recovery, refresh or webhook) confirmed it. Non-monetary.
    if (updated.providerPayoutId === payout.id)
      await promoteObservationLinkage(payout.id, updated.mode, updated._id);
    // A concurrent pending update can win the CAS while this request observes paid/failed.
    // Reapply the newer state before acknowledging its webhook; never lose that transition.
    if (
      updated.state === "SUBMITTED" &&
      updated.providerStatus &&
      STATUS_RANK[updated.providerStatus] < STATUS_RANK[status]
    ) {
      if (retriesRemaining <= 0)
        throw new CentralPayoutError(
          "CENTRAL_PAYOUT_STATUS_RETRY",
          "Withdrawal status changed concurrently; retry reconciliation",
          503,
        );
      return this.applyProviderPayout(
        updated,
        payout,
        source,
        providerEventId,
        retriesRemaining - 1,
      );
    }
    return updated;
  }

  /** Compare-and-set: a concurrent writer that already moved the operation wins; re-read it. */
  private async update(
    op: CentralPayoutOperationDocument,
    filter: Record<string, unknown>,
    change: Record<string, unknown>,
  ): Promise<CentralPayoutOperationDocument> {
    const updated = await CentralPayoutOperationModel.findOneAndUpdate(
      { _id: op._id, ...filter },
      change,
      {
        returnDocument: "after",
      },
    )
      .lean<CentralPayoutOperationDocument>()
      .exec();
    return updated ?? (await this.get(String(op._id)));
  }

  private async audit(
    op: CentralPayoutOperationDocument,
    entry: CentralPayoutAuditEntry,
  ): Promise<CentralPayoutOperationDocument> {
    return this.update(op, {}, { $push: { audit: entry } });
  }

  private entry(
    kind: CentralPayoutAuditEntry["kind"],
    source?: CentralPayoutAuditEntry["source"],
    detail?: string,
    providerEventId?: string,
    actorUserId?: string,
  ): CentralPayoutAuditEntry {
    return {
      at: new Date(),
      kind,
      ...(source ? { source } : {}),
      ...(detail ? { detail: detail.slice(0, 500) } : {}),
      ...(providerEventId ? { providerEventId } : {}),
      ...(actorUserId ? { actorUserId: new Types.ObjectId(actorUserId) } : {}),
    };
  }

  private assertSameRequest(
    op: CentralPayoutOperationDocument,
    input: { amountCents: number; currency: string; destinationId: string },
  ): CentralPayoutOperationDocument {
    if (
      op.amountCents !== input.amountCents ||
      op.currency !== input.currency ||
      op.destinationId !== input.destinationId
    )
      throw new CentralPayoutError(
        "CENTRAL_PAYOUT_REQUEST_REUSED",
        "This withdrawal request was already submitted with different details",
        409,
      );
    return op;
  }

  private isEligible(d: CentralBankDestination, account: CentralAccountPayoutState): boolean {
    return (
      account.destinationsReadable &&
      account.destinationsComplete !== false &&
      d.defaultForCurrency === true &&
      SENDABLE_DESTINATION_STATUSES.has(d.status) &&
      /^ba_[a-z0-9]+$/i.test(d.id) &&
      /^[a-z0-9]{4}$/i.test(d.last4) &&
      /^[a-z]{3}$/.test(d.currency) &&
      /^[A-Z]{2}$/.test(d.country) &&
      account.destinations.filter(
        (bank) => bank.currency === d.currency && bank.defaultForCurrency === true,
      ).length === 1
    );
  }

  private executionRestrictions(
    mode: CentralStripeMode | null,
    balanceLivemode: boolean,
  ): Restriction[] {
    if (!mode)
      return [
        {
          code: "CENTRAL_PAYOUT_STRIPE_NOT_CONFIGURED",
          message: "Stripe is not configured with a recognised TEST or LIVE secret key",
        },
      ];
    if (balanceLivemode !== (mode === "LIVE"))
      return [
        {
          code: "CENTRAL_PAYOUT_MODE_MISMATCH",
          message: "Stripe returned data for a different mode than the configured key",
        },
      ];
    // CW-1 — the reserve policy is implemented: every request (TEST and LIVE) must pass the
    // authoritative eligibility gate at confirmation and again immediately before dispatch.
    // LIVE additionally requires the deployment's explicit enablement, which stays off until the
    // release is separately authorized.
    if (mode === "LIVE" && !this.deps.policy.liveExecutionEnabled)
      return [
        {
          code: "CENTRAL_PAYOUT_LIVE_DISABLED",
          message: "LIVE withdrawals are disabled in this deployment",
        },
      ];
    return [];
  }

  private accountRestrictions(account: CentralAccountPayoutState): Restriction[] {
    const restrictions: Restriction[] = [];
    if (!account.accountId)
      restrictions.push({
        code: "CENTRAL_PAYOUT_ACCOUNT_UNIDENTIFIED",
        message: "The Stripe account could not be identified",
      });
    if (!account.payoutsEnabled)
      restrictions.push({
        code: "CENTRAL_PAYOUT_PAYOUTS_DISABLED",
        message:
          account.payoutsEnabled === false
            ? "Stripe reports that payouts are not enabled for this account"
            : "Stripe payout-enabled status could not be confirmed",
      });
    if (account.scheduleInterval !== "manual")
      restrictions.push({
        code: "CENTRAL_PAYOUT_AUTOMATIC_SCHEDULE",
        message:
          account.scheduleInterval === null
            ? "Stripe payout schedule could not be confirmed; manual withdrawals require a confirmed manual schedule"
            : `The Stripe account pays out automatically (${account.scheduleInterval} schedule). Manual withdrawals need a manual payout schedule; Bookly does not change this setting.`,
      });
    if (!account.destinationsReadable)
      restrictions.push({
        code: "CENTRAL_PAYOUT_DESTINATION_UNREADABLE",
        message: "Stripe did not return the account's bank accounts to this API key",
      });
    else if (account.destinationsComplete === false)
      restrictions.push({
        code: "CENTRAL_PAYOUT_DESTINATION_INCOMPLETE",
        message:
          "Stripe bank-account inventory is incomplete; no withdrawal can select a destination",
      });
    else if (!account.destinations.some((d) => this.isEligible(d, account)))
      restrictions.push({
        code: "CENTRAL_PAYOUT_DESTINATION_REQUIRED",
        message: "No usable default bank account is linked to the Stripe account",
      });
    return restrictions;
  }

  private async inFlightRestriction(): Promise<Restriction[]> {
    const active = await CentralPayoutOperationModel.exists({ activeSlot: "CENTRAL" }).exec();
    return active
      ? [
          {
            code: "CENTRAL_PAYOUT_IN_PROGRESS",
            message:
              "A previous withdrawal is still being confirmed with Stripe. Refresh it first.",
          },
        ]
      : [];
  }

  private async provider<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof AppError) throw error;
      const message =
        error instanceof CentralPayoutProviderError ? error.message : "Stripe request failed";
      throw new CentralPayoutError("CENTRAL_PAYOUT_PROVIDER_UNAVAILABLE", message, 502);
    }
  }

  private notFound(): CentralPayoutError {
    return new CentralPayoutError("CENTRAL_PAYOUT_NOT_FOUND", "Withdrawal not found", 404);
  }
}
