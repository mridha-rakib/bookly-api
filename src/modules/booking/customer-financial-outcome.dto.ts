import type {
  PaymentAttemptCompensationStatus,
  PaymentAttemptPersistenceStatus,
  PaymentAttemptProviderStatus,
} from "../payment/payment-attempt.model.js";
import type { RefundOperationStatus } from "../payment/refund-operation.model.js";
import type { DisputeOutcome } from "../provider-reversal/payment-dispute.model.js";

export type BoundedFinancialRead<T> = { items: T[]; hasMore: boolean };
export type CustomerFinancialOutcomeDto = {
  currency: "EUR";
  /** Time of this database snapshot read, not provider observation or bank arrival. */
  asOf: string;
  payments: BoundedFinancialRead<{
    id: string;
    providerStatus: PaymentAttemptProviderStatus;
    persistenceStatus: PaymentAttemptPersistenceStatus;
    compensationStatus: PaymentAttemptCompensationStatus;
    amountCents: number;
    providerConfirmed: boolean;
    accountingConfirmed: boolean;
    lastObservedAt?: string;
  }>;
  refunds: BoundedFinancialRead<
    | {
        origin: "BOOKLY";
        id: string;
        status: RefundOperationStatus;
        amountCents: number;
        providerCallStarted: boolean;
        providerConfirmed: boolean;
        accountingConfirmed: boolean;
        lastObservedAt?: string;
      }
    | {
        origin: "PROVIDER_EXTERNAL";
        id: string;
        state: "ACCOUNTED";
        amountCents: number;
        providerConfirmed: true;
        accountingConfirmed: true;
        providerCreatedAt?: string;
      }
  >;
  disputes: BoundedFinancialRead<{
    id: string;
    providerStatus: string;
    final: boolean;
    outcome?: DisputeOutcome;
    amountCents: number;
    lastObservedAt: string;
  }>;
};
