import type { Types } from "mongoose";

import type { BookingFinancialTransactionDocument } from "../booking-financial-transaction/booking-financial-transaction.model.js";
import type { BookingFinancialTransactionService } from "../booking-financial-transaction/booking-financial-transaction.service.js";
import { disputeLossCents } from "../finance/finance-ownership.js";
import type { ExternalRefundDocument, ExternalRefundState } from "./external-refund.model.js";
import type { PaymentDisputeDocument } from "./payment-dispute.model.js";
import type {
  ExternalRefundRepository,
  PaymentDisputeRepository,
} from "./provider-reversal.repository.js";

export type ReversalLedgerRowView = {
  id: string;
  type: string;
  amountCents: number;
  balanceTransactionId?: string | undefined;
  payoutId?: string | undefined;
  createdAt: string;
};

export type DisputeView = {
  id: string;
  providerDisputeId: string;
  providerPaymentIntentId?: string | undefined;
  providerChargeId?: string | undefined;
  amountCents: number;
  currency: string;
  providerStatus: string;
  final: boolean;
  outcome?: string | undefined;
  reason?: string | undefined;
  evidenceDueAt?: string | undefined;
  fundsWithdrawnAt?: string | undefined;
  fundsReinstatedAt?: string | undefined;
  closedAt?: string | undefined;
  correlation: string;
  reconciliationRequired: boolean;
  investigationReason?: string | undefined;
  economicOwner?: string | undefined;
  sourceType?: string | undefined;
  sourceTransactionId?: string | undefined;
  businessId?: string | undefined;
  bookingId?: string | undefined;
  accounting: {
    principalWithdrawnCents: number;
    principalReinstatedCents: number;
    feeChargedCents: number;
    feeReturnedCents: number;
    /** Net loss currently borne by the economic owner from this dispute. */
    netLossCents: number;
    /** Rows already settled into a payout vs still carried forward to the next one. */
    claimedRowCount: number;
    unclaimedRowCount: number;
    rows: ReversalLedgerRowView[];
  };
  lastSyncedAt: string;
  lastSyncedVia: string;
};

export type ExternalRefundView = {
  id: string;
  providerRefundId: string;
  providerPaymentIntentId?: string | undefined;
  amountCents: number;
  currency: string;
  /** Always PROVIDER_EXTERNAL — never a Bookly RefundOperation / business-cancellation refund. */
  refundOrigin: "PROVIDER_EXTERNAL";
  state: ExternalRefundState;
  investigationReason?: string | undefined;
  economicOwner?: string | undefined;
  sourceType?: string | undefined;
  businessId?: string | undefined;
  bookingId?: string | undefined;
  ledgerTransactionId?: string | undefined;
  payoutId?: string | undefined;
  detectedVia: string;
  createdAt: string;
};

const iso = (date: Date | undefined) => date?.toISOString();
const id = (value: Types.ObjectId | undefined) => (value ? String(value) : undefined);

/**
 * P6 — read-only support / business visibility of provider-originated reversals. Super Admin
 * sees everything (incl. investigation reasons and provider ids); a Business sees only rows
 * affecting its own businessId, without internal investigation detail.
 */
export class ProviderReversalQueryService {
  public constructor(
    private readonly disputes: PaymentDisputeRepository,
    private readonly externalRefunds: ExternalRefundRepository,
    private readonly financials: Pick<
      BookingFinancialTransactionService,
      "listForBooking" | "findById"
    >,
  ) {}

  public async listDisputes(input: {
    page: number;
    limit: number;
    businessId?: string | undefined;
    economicOwner?: "BOOKLY" | "BUSINESS" | undefined;
    reconciliationOnly?: boolean | undefined;
  }): Promise<{ items: DisputeView[]; total: number }> {
    const { items, total } = await this.disputes.list(input);
    return { items: await Promise.all(items.map((item) => this.toDisputeView(item))), total };
  }

  public async getDispute(disputeId: string): Promise<DisputeView | null> {
    const dispute =
      (await this.disputes.findByProviderDisputeId(disputeId)) ??
      (/^[a-f\d]{24}$/i.test(disputeId) ? await this.disputes.findById(disputeId) : null);
    return dispute ? this.toDisputeView(dispute) : null;
  }

  public async listExternalRefunds(input: {
    page: number;
    limit: number;
    businessId?: string | undefined;
    economicOwner?: "BOOKLY" | "BUSINESS" | undefined;
    state?: ExternalRefundState | undefined;
  }): Promise<{ items: ExternalRefundView[]; total: number }> {
    const { items, total } = await this.externalRefunds.list(input);
    return {
      items: await Promise.all(items.map((item) => this.toExternalRefundView(item))),
      total,
    };
  }

  /** The Business-facing projection: no investigation internals. */
  public static forBusiness<T extends { investigationReason?: string | undefined }>(view: T): T {
    const { investigationReason: _hidden, ...rest } = view;
    return rest as T;
  }

  private async toDisputeView(dispute: PaymentDisputeDocument): Promise<DisputeView> {
    const rows: BookingFinancialTransactionDocument[] = dispute.bookingId
      ? (await this.financials.listForBooking(dispute.bookingId)).filter(
          (row) => row.metadata?.["providerDisputeId"] === dispute.providerDisputeId,
        )
      : [];
    const total = (type: string) =>
      rows.filter((row) => row.type === type).reduce((sum, row) => sum + row.amountCents, 0);
    return {
      id: String(dispute._id),
      providerDisputeId: dispute.providerDisputeId,
      providerPaymentIntentId: dispute.providerPaymentIntentId,
      providerChargeId: dispute.providerChargeId,
      amountCents: dispute.amountCents,
      currency: dispute.currency,
      providerStatus: dispute.providerStatus,
      final: dispute.final,
      outcome: dispute.outcome,
      reason: dispute.reason,
      evidenceDueAt: iso(dispute.evidenceDueAt),
      fundsWithdrawnAt: iso(dispute.fundsWithdrawnAt),
      fundsReinstatedAt: iso(dispute.fundsReinstatedAt),
      closedAt: iso(dispute.closedAt),
      correlation: dispute.correlation,
      reconciliationRequired:
        dispute.correlation !== "CORRELATED" || Boolean(dispute.investigationReason),
      investigationReason: dispute.investigationReason,
      economicOwner: dispute.economicOwner,
      sourceType: dispute.sourceType,
      sourceTransactionId: id(dispute.sourceTransactionId),
      businessId: id(dispute.businessId),
      bookingId: id(dispute.bookingId),
      accounting: {
        principalWithdrawnCents: total("DISPUTE_WITHDRAWAL"),
        principalReinstatedCents: total("DISPUTE_REINSTATEMENT"),
        feeChargedCents: total("DISPUTE_FEE"),
        feeReturnedCents: total("DISPUTE_FEE_REVERSAL"),
        netLossCents: rows.reduce(
          (sum, row) => sum + disputeLossCents(row.type, row.amountCents),
          0,
        ),
        claimedRowCount: rows.filter((row) => row.payoutId).length,
        unclaimedRowCount: rows.filter((row) => !row.payoutId).length,
        rows: rows.map((row) => ({
          id: String(row._id),
          type: row.type,
          amountCents: row.amountCents,
          balanceTransactionId: row.metadata?.["balanceTransactionId"] as string | undefined,
          payoutId: id(row.payoutId),
          createdAt: row.createdAt.toISOString(),
        })),
      },
      lastSyncedAt: dispute.lastSyncedAt.toISOString(),
      lastSyncedVia: dispute.lastSyncedVia,
    };
  }

  private async toExternalRefundView(record: ExternalRefundDocument): Promise<ExternalRefundView> {
    const ledger = record.ledgerTransactionId
      ? await this.financials.findById(record.ledgerTransactionId)
      : null;
    return {
      id: String(record._id),
      providerRefundId: record.providerRefundId,
      providerPaymentIntentId: record.providerPaymentIntentId,
      amountCents: record.amountCents,
      currency: record.currency,
      refundOrigin: "PROVIDER_EXTERNAL",
      state: record.state,
      investigationReason: record.investigationReason,
      economicOwner: record.economicOwner,
      sourceType: record.sourceType,
      businessId: id(record.businessId),
      bookingId: id(record.bookingId),
      ledgerTransactionId: id(record.ledgerTransactionId),
      payoutId: id(ledger?.payoutId),
      detectedVia: record.detectedVia,
      createdAt: record.createdAt.toISOString(),
    };
  }
}
