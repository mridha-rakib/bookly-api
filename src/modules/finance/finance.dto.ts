import type { BusinessPayoutDocument } from "./business-payout.model.js";
import type {
  BusinessPayableSummary,
  FinancePayoutHistoryPage,
  FinanceSummary,
  FinanceTransactionPage,
  PendingPayoutsPage,
  PlatformFinanceSummary,
  PlatformPayoutHistoryPage,
  PlatformTransactionPage,
} from "./finance.types.js";

export type FinanceSummaryDto = {
  currency: FinanceSummary["currency"];
  period: { from: string; to: string };
  noShowFees: FinanceSummary["noShowFees"];
  lateCancellationFees: FinanceSummary["lateCancellationFees"];
  processingFees: FinanceSummary["processingFees"];
  netPayoutCents: number;
  protectedEarningsAllTimeCents: number;
};

export const toFinanceSummaryDto = (summary: FinanceSummary): FinanceSummaryDto => ({
  currency: summary.currency,
  period: { from: summary.period.from.toISOString(), to: summary.period.to.toISOString() },
  noShowFees: summary.noShowFees,
  lateCancellationFees: summary.lateCancellationFees,
  processingFees: summary.processingFees,
  netPayoutCents: summary.netPayoutCents,
  protectedEarningsAllTimeCents: summary.protectedEarningsAllTimeCents,
});

export type FinanceTransactionRowDto = {
  id: string;
  bookingId: string;
  bookingReference: string;
  customerName: string;
  customerType: FinanceTransactionPage["rows"][number]["customerType"];
  type: FinanceTransactionPage["rows"][number]["type"];
  date: string;
  amountCents: number;
  businessOwnedCents: number;
  status: FinanceTransactionPage["rows"][number]["status"];
  currency: FinanceTransactionPage["rows"][number]["currency"];
};

export const toFinanceTransactionRowDto = (
  row: FinanceTransactionPage["rows"][number],
): FinanceTransactionRowDto => ({
  id: row.id,
  bookingId: row.bookingId,
  bookingReference: row.bookingReference,
  customerName: row.customerName,
  customerType: row.customerType,
  type: row.type,
  date: row.createdAt.toISOString(),
  amountCents: row.amountCents,
  businessOwnedCents: row.businessOwnedCents,
  status: row.status,
  currency: row.currency,
});

export type FinancePayoutHistoryItemDto = {
  id: string;
  periodStart: string;
  periodEnd: string;
  grossBusinessOwnedCents: number;
  processingFeesCents: number;
  netPayoutCents: number;
  currency: FinancePayoutHistoryPage["items"][number]["currency"];
  status: FinancePayoutHistoryPage["items"][number]["status"];
  paidAt?: string | undefined;
  providerReference?: string | undefined;
};

export const toFinancePayoutHistoryItemDto = (
  item: FinancePayoutHistoryPage["items"][number],
): FinancePayoutHistoryItemDto => ({
  id: item.id,
  periodStart: item.periodStart.toISOString(),
  periodEnd: item.periodEnd.toISOString(),
  grossBusinessOwnedCents: item.grossBusinessOwnedCents,
  processingFeesCents: item.processingFeesCents,
  netPayoutCents: item.netPayoutCents,
  currency: item.currency,
  status: item.status,
  paidAt: item.paidAt?.toISOString(),
  providerReference: item.providerReference,
});

// --- Batch 8: Business payable + Super Admin platform-wide finance ----------------------------

export const toBusinessPayableDto = (summary: BusinessPayableSummary) => summary;

export const toPendingPayoutsDto = (page: PendingPayoutsPage) => ({
  items: page.items,
  totalPendingCents: page.totalPendingCents,
  businessCount: page.businessCount,
});

export const toPlatformSummaryDto = (summary: PlatformFinanceSummary) => ({
  currency: summary.currency,
  period: { from: summary.period.from.toISOString(), to: summary.period.to.toISOString() },
  bookly: summary.bookly,
  collectedForBusinesses: summary.collectedForBusinesses,
  sentToBusinesses: summary.sentToBusinesses,
  pendingPayouts: summary.pendingPayouts,
  protectedEarningsAllTimeCents: summary.protectedEarningsAllTimeCents,
});

export const toPlatformTransactionRowDto = (row: PlatformTransactionPage["rows"][number]) => ({
  id: row.id,
  businessId: row.businessId,
  businessName: row.businessName,
  bookingId: row.bookingId,
  bookingReference: row.bookingReference,
  customerName: row.customerName,
  type: row.type,
  date: row.createdAt.toISOString(),
  grossCents: row.grossCents,
  stripeFeeCents: row.stripeFeeCents,
  netCents: row.netCents,
  owner: row.owner,
  status: row.status,
  payoutId: row.payoutId,
  currency: row.currency,
});

export const toPlatformPayoutHistoryItemDto = (
  item: PlatformPayoutHistoryPage["items"][number],
) => ({
  id: item.id,
  businessId: item.businessId,
  businessName: item.businessName,
  periodStart: item.periodStart.toISOString(),
  periodEnd: item.periodEnd.toISOString(),
  grossBusinessOwnedCents: item.grossBusinessOwnedCents,
  processingFeesCents: item.processingFeesCents,
  netPayoutCents: item.netPayoutCents,
  currency: item.currency,
  status: item.status,
  paidAt: item.paidAt?.toISOString(),
  providerReference: item.providerReference,
});

export const toBusinessPayoutDto = (payout: BusinessPayoutDocument) => ({
  id: String(payout._id),
  businessId: String(payout.businessId),
  periodStart: payout.periodStart.toISOString(),
  periodEnd: payout.periodEnd.toISOString(),
  grossBusinessOwnedCents: payout.grossBusinessOwnedCents,
  processingFeesCents: payout.processingFeesCents,
  refundsCents: payout.refundsCents,
  netPayoutCents: payout.netPayoutCents,
  currency: payout.currency,
  status: payout.status,
  settledTransactionCount: payout.settledTransactionIds.length,
  providerReference: payout.providerReference,
  paidAt: payout.paidAt?.toISOString(),
  createdAt: payout.createdAt.toISOString(),
});
