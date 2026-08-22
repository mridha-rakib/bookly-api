import type {
  FinancePayoutHistoryPage,
  FinanceSummary,
  FinanceTransactionPage,
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
