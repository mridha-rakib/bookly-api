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
  /** LIVE payout execution. Off unless explicitly enabled by deployment configuration. */
  liveExecutionEnabled: boolean;
};

type Restriction = { code: string; message: string };

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
  recentStripePayouts: ProviderPayout[];
  /** Recorded Business-attributed amounts not yet paid out to Businesses (informational: Bookly
   * has no approved reserve formula, so this is NOT subtracted from the Stripe balance). */
  businessAttributedUnpaid: { currency: string; amountCents: number } | null;
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

  // --- Read ---------------------------------------------------------------------------------

  public async getOverview(): Promise<CentralPayoutOverview> {
    const mode = this.deps.gateway.mode() ?? null;
    const [balance, account, recent, unpaid] = await Promise.all([
      this.provider(() => this.deps.gateway.retrieveBalance()),
      this.provider(() => this.deps.gateway.retrieveAccountPayoutState()),
      this.provider(() => this.deps.gateway.listRecentPayouts({ limit: 100 })),
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
      destinations: account.destinations.map((d) => ({ ...d, eligible: this.isEligible(d) })),
      scheduleInterval: account.scheduleInterval,
      restrictions: [
        ...this.executionRestrictions(mode, balance.livemode),
        ...this.accountRestrictions(account),
        ...(await this.inFlightRestriction()),
      ],
      recentStripePayouts: recent.slice(0, 10),
      businessAttributedUnpaid: unpaid,
    };
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
    const [balance, account] = await Promise.all([
      this.provider(() => this.deps.gateway.retrieveBalance()),
      this.provider(() => this.deps.gateway.retrieveAccountPayoutState()),
    ]);
    const blocking = [
      ...this.executionRestrictions(mode ?? null, balance.livemode),
      ...this.accountRestrictions(account),
    ];
    if (blocking[0]) throw new CentralPayoutError(blocking[0].code, blocking[0].message, 409);

    const destination = account.destinations.find((d) => d.id === input.destinationId);
    if (!destination || !this.isEligible(destination))
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
          activeSlot: "CENTRAL",
          providerIdempotencyKey: `central-payout:${String(_id)}`,
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
    const recent = await this.provider(() =>
      this.deps.gateway.listRecentPayouts({
        createdGte: new Date(op.createdAt.getTime() - 5 * 60 * 1000),
        limit: 100,
      }),
    );
    const found = recent.find((p) => p.metadata[METADATA_KEY] === String(op._id));
    if (found) return this.applyProviderPayout(op, found, "RECOVERY");
    if (Date.now() - op.createdAt.getTime() >= RESEND_WINDOW_MS) {
      return this.audit(
        op,
        this.entry(
          "REQUIRES_REVIEW",
          "RECOVERY",
          "No matching Stripe payout found and the idempotency window has passed; not resent",
        ),
      );
    }
    // Same idempotency key and identical parameters: Stripe returns the original payout if it
    // exists, so this can never create a second one.
    return this.dispatch(op, "RECOVERY");
  }

  /** Webhook entry point for payout.* events (already deduplicated by Stripe event id). */
  public async syncFromWebhook(payout: ProviderPayout, providerEventId: string): Promise<void> {
    const operationId = payout.metadata[METADATA_KEY];
    const op = await CentralPayoutOperationModel.findOne(
      operationId && Types.ObjectId.isValid(operationId)
        ? { $or: [{ providerPayoutId: payout.id }, { _id: new Types.ObjectId(operationId) }] }
        : { providerPayoutId: payout.id },
    )
      .lean<CentralPayoutOperationDocument>()
      .exec();
    // Payouts Bookly did not request (e.g. made in the Stripe Dashboard) are not tracked here.
    if (!op) return;
    await this.applyProviderPayout(op, payout, "WEBHOOK", providerEventId);
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
            $push: { audit: this.entry("PROVIDER_REJECTED", source, failure.message) },
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
      $push: { audit: entry },
    });
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

  private isEligible(d: CentralBankDestination): boolean {
    return d.defaultForCurrency && SENDABLE_DESTINATION_STATUSES.has(d.status);
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
    if (!account.payoutsEnabled)
      restrictions.push({
        code: "CENTRAL_PAYOUT_PAYOUTS_DISABLED",
        message: "Stripe reports that payouts are not enabled for this account",
      });
    if (account.scheduleInterval !== "manual")
      restrictions.push({
        code: "CENTRAL_PAYOUT_AUTOMATIC_SCHEDULE",
        message: `The Stripe account pays out automatically (${account.scheduleInterval ?? "unknown"} schedule). Manual withdrawals need a manual payout schedule; Bookly does not change this setting.`,
      });
    if (!account.destinationsReadable)
      restrictions.push({
        code: "CENTRAL_PAYOUT_DESTINATION_UNREADABLE",
        message: "Stripe did not return the account's bank accounts to this API key",
      });
    else if (!account.destinations.some((d) => this.isEligible(d)))
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
