import { Types } from "mongoose";

import type { DisputeSnapshot } from "../payment/payment.types.js";
import {
  type ExternalRefundDocument,
  ExternalRefundModel,
  type ExternalRefundState,
} from "./external-refund.model.js";
import {
  type DisputeOutcome,
  type PaymentDisputeDocument,
  PaymentDisputeModel,
} from "./payment-dispute.model.js";

/** Provider statuses after which a dispute never reopens (P6 monotonicity). */
const FINAL_OUTCOME_BY_STATUS: Readonly<Record<string, DisputeOutcome>> = {
  won: "WON",
  lost: "LOST",
  prevented: "PREVENTED",
  warning_closed: "WARNING_CLOSED",
};

export const disputeOutcomeForStatus = (status: string): DisputeOutcome | undefined =>
  FINAL_OUTCOME_BY_STATUS[status];

type SyncVia = PaymentDisputeDocument["lastSyncedVia"];

export type DisputeSourceCorrelation = {
  sourceTransactionId: Types.ObjectId;
  sourceType: string;
  economicOwner: "BOOKLY" | "BUSINESS";
  bookingId: Types.ObjectId;
  businessId: Types.ObjectId;
  businessClientId: Types.ObjectId;
  customerUserId?: Types.ObjectId | undefined;
};

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === 11000;

export class PaymentDisputeRepository {
  public async findByProviderDisputeId(id: string): Promise<PaymentDisputeDocument | null> {
    return PaymentDisputeModel.findOne({ providerDisputeId: id }).exec();
  }

  /**
   * Records the provider's CURRENT view of a dispute. Identity is inserted once (unique provider
   * dispute id); afterwards only a non-final record takes a new status, so out-of-order or stale
   * deliveries can never reopen a final dispute. Money timestamps keep the earliest
   * provider-confirmed time (`$min`). Returns whether this call created the record.
   */
  public async upsertFromProvider(
    snapshot: DisputeSnapshot,
    via: SyncVia,
  ): Promise<{ dispute: PaymentDisputeDocument; isNew: boolean }> {
    const now = new Date();
    const outcome = disputeOutcomeForStatus(snapshot.status);
    let isNew = false;
    try {
      await new PaymentDisputeModel({
        providerDisputeId: snapshot.disputeId,
        providerChargeId: snapshot.chargeId,
        providerPaymentIntentId: snapshot.paymentIntentId,
        amountCents: snapshot.amountCents,
        currency: snapshot.currency,
        providerStatus: snapshot.status,
        reason: snapshot.reason,
        evidenceDueAt: snapshot.evidenceDueAt,
        providerCreatedAt: snapshot.createdAt,
        final: Boolean(outcome),
        ...(outcome ? { outcome, closedAt: now } : {}),
        correlation: "PENDING",
        lastSyncedAt: now,
        lastSyncedVia: via,
      }).save();
      isNew = true;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }

    if (!isNew) {
      await PaymentDisputeModel.updateOne(
        { providerDisputeId: snapshot.disputeId, final: false },
        {
          $set: {
            providerStatus: snapshot.status,
            ...(snapshot.reason ? { reason: snapshot.reason } : {}),
            ...(snapshot.evidenceDueAt ? { evidenceDueAt: snapshot.evidenceDueAt } : {}),
            ...(outcome ? { final: true, outcome, closedAt: now } : {}),
          },
        },
      ).exec();
      await PaymentDisputeModel.updateOne(
        { providerDisputeId: snapshot.disputeId },
        { $set: { lastSyncedAt: now, lastSyncedVia: via } },
      ).exec();
    }

    const withdrawals = snapshot.balanceTransactions.filter((bt) => bt.amountCents < 0);
    const reinstatements = snapshot.balanceTransactions.filter((bt) => bt.amountCents > 0);
    const earliest = (items: typeof withdrawals) =>
      items.length > 0
        ? new Date(Math.min(...items.map((item) => item.createdAt.getTime())))
        : undefined;
    const fundsWithdrawnAt = earliest(withdrawals);
    const fundsReinstatedAt = earliest(reinstatements);
    if (fundsWithdrawnAt || fundsReinstatedAt) {
      await PaymentDisputeModel.updateOne(
        { providerDisputeId: snapshot.disputeId },
        {
          $min: {
            ...(fundsWithdrawnAt ? { fundsWithdrawnAt } : {}),
            ...(fundsReinstatedAt ? { fundsReinstatedAt } : {}),
          },
        },
      ).exec();
    }

    const dispute = await PaymentDisputeModel.findOne({
      providerDisputeId: snapshot.disputeId,
    }).orFail();
    return { dispute, isNew };
  }

  /** Correlation identity is immutable once set: only a not-yet-correlated record takes it. */
  public async markCorrelated(
    id: Types.ObjectId,
    correlation: DisputeSourceCorrelation,
  ): Promise<PaymentDisputeDocument | null> {
    return PaymentDisputeModel.findOneAndUpdate(
      { _id: id, correlation: { $ne: "CORRELATED" } },
      { $set: { correlation: "CORRELATED", ...correlation }, $unset: { investigationReason: 1 } },
      { returnDocument: "after" },
    ).exec();
  }

  /** An uncorrelated dispute: recorded for investigation, never accounted. */
  public async markUncorrelated(id: Types.ObjectId, reason: string): Promise<void> {
    await PaymentDisputeModel.updateOne(
      { _id: id, correlation: { $ne: "CORRELATED" } },
      { $set: { correlation: "INVESTIGATION", investigationReason: reason.slice(0, 500) } },
    ).exec();
  }

  /** A correlated dispute whose provider money movement cannot be accounted safely (e.g. it
   * would exceed the provider-confirmed principal): flagged, nothing guessed. */
  public async flagReconciliation(id: Types.ObjectId, reason: string): Promise<void> {
    await PaymentDisputeModel.updateOne(
      { _id: id },
      { $set: { investigationReason: reason.slice(0, 500) } },
    ).exec();
  }

  public async findById(id: Types.ObjectId | string): Promise<PaymentDisputeDocument | null> {
    return PaymentDisputeModel.findById(id).exec();
  }

  /** Backstop candidates: open (or not yet correlated) disputes not synced recently. */
  /** Open disputes, plus uncorrelated ones still inside the lookback window (a dispute that is
   * final AND never correlated — e.g. not a Bookly charge — stops being re-read eventually). */
  public async listDueForResync(
    limit: number,
    syncedBefore: Date,
    uncorrelatedCreatedSince: Date,
  ): Promise<PaymentDisputeDocument[]> {
    return PaymentDisputeModel.find({
      lastSyncedAt: { $lte: syncedBefore },
      $or: [
        { final: false },
        {
          correlation: { $ne: "CORRELATED" },
          providerCreatedAt: { $gte: uncorrelatedCreatedSince },
        },
      ],
    })
      .sort({ lastSyncedAt: 1 })
      .limit(limit)
      .exec();
  }

  public async list(input: {
    page: number;
    limit: number;
    businessId?: Types.ObjectId | string | undefined;
    economicOwner?: "BOOKLY" | "BUSINESS" | undefined;
    reconciliationOnly?: boolean | undefined;
  }): Promise<{ items: PaymentDisputeDocument[]; total: number }> {
    const filter: Record<string, unknown> = {
      ...(input.businessId ? { businessId: new Types.ObjectId(String(input.businessId)) } : {}),
      ...(input.economicOwner ? { economicOwner: input.economicOwner } : {}),
      ...(input.reconciliationOnly
        ? {
            $or: [
              { correlation: { $ne: "CORRELATED" } },
              { investigationReason: { $exists: true } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      PaymentDisputeModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((input.page - 1) * input.limit)
        .limit(input.limit)
        .exec(),
      PaymentDisputeModel.countDocuments(filter).exec(),
    ]);
    return { items, total };
  }
}

export class ExternalRefundRepository {
  public async findByProviderRefundId(id: string): Promise<ExternalRefundDocument | null> {
    return ExternalRefundModel.findOne({ providerRefundId: id }).exec();
  }

  /** One provider refund id = one record (unique). A concurrent duplicate returns the winner. */
  public async createIfMissing(
    input: Omit<ExternalRefundDocument, "_id" | "createdAt" | "updatedAt">,
  ): Promise<{ record: ExternalRefundDocument; isNew: boolean }> {
    try {
      const record = await new ExternalRefundModel(input).save();
      return { record, isNew: true };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const record = await ExternalRefundModel.findOne({
        providerRefundId: input.providerRefundId,
      }).orFail();
      return { record, isNew: false };
    }
  }

  public async markAccounted(
    id: Types.ObjectId,
    ledgerTransactionId: Types.ObjectId,
  ): Promise<ExternalRefundDocument | null> {
    return ExternalRefundModel.findOneAndUpdate(
      { _id: id },
      {
        $set: { state: "ACCOUNTED" satisfies ExternalRefundState, ledgerTransactionId },
        $unset: { investigationReason: 1 },
      },
      { returnDocument: "after" },
    ).exec();
  }

  public async markInvestigation(id: Types.ObjectId, reason: string): Promise<void> {
    await ExternalRefundModel.updateOne(
      { _id: id, state: { $ne: "ACCOUNTED" } },
      {
        $set: {
          state: "INVESTIGATION" satisfies ExternalRefundState,
          investigationReason: reason.slice(0, 500),
        },
      },
    ).exec();
  }

  public async list(input: {
    page: number;
    limit: number;
    businessId?: Types.ObjectId | string | undefined;
    economicOwner?: "BOOKLY" | "BUSINESS" | undefined;
    state?: ExternalRefundState | undefined;
  }): Promise<{ items: ExternalRefundDocument[]; total: number }> {
    const filter: Record<string, unknown> = {
      ...(input.businessId ? { businessId: new Types.ObjectId(String(input.businessId)) } : {}),
      ...(input.economicOwner ? { economicOwner: input.economicOwner } : {}),
      ...(input.state ? { state: input.state } : {}),
    };
    const [items, total] = await Promise.all([
      ExternalRefundModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((input.page - 1) * input.limit)
        .limit(input.limit)
        .exec(),
      ExternalRefundModel.countDocuments(filter).exec(),
    ]);
    return { items, total };
  }
}
