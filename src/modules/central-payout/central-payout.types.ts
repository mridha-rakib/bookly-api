/**
 * P0.6 — Super Admin withdrawals from Bookly's central Stripe balance to the bank account already
 * linked to that Stripe account (Stripe Payouts API). This is NOT a Business payout (those are
 * self-attested BusinessPayout records), not a Stripe Transfer, and not a customer payment.
 * Callers depend only on this interface; StripeCentralPayoutGateway is the one Stripe adapter.
 */

export type CentralStripeMode = "TEST" | "LIVE";

/** Stripe payout lifecycle (docs: pending → in_transit → paid, or failed / canceled; a payout
 * reported `paid` can later become `failed`). */
export type ProviderPayoutStatus = "pending" | "in_transit" | "paid" | "failed" | "canceled";
export const providerPayoutStatuses = [
  "pending",
  "in_transit",
  "paid",
  "failed",
  "canceled",
] as const;

export type CentralBalanceAmount = { currency: string; amountCents: number };

export type CentralBalance = {
  livemode: boolean;
  available: CentralBalanceAmount[];
  pending: CentralBalanceAmount[];
};

/** Masked only — never an account number, IBAN or routing number. */
export type CentralBankDestination = {
  id: string;
  bankName: string | null;
  last4: string;
  currency: string;
  country: string;
  status: string;
  defaultForCurrency: boolean;
};

export type CentralAccountPayoutState = {
  payoutsEnabled: boolean;
  /** Stripe `settings.payouts.schedule.interval`: manual | daily | weekly | monthly. */
  scheduleInterval: string | null;
  /** False when Stripe did not expose the account's external accounts to this key. */
  destinationsReadable: boolean;
  destinations: CentralBankDestination[];
};

export type ProviderPayout = {
  id: string;
  amountCents: number;
  currency: string;
  status: string;
  arrivalDate: Date | null;
  created: Date;
  destinationId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  livemode: boolean;
  automatic: boolean;
  metadata: Record<string, string>;
};

export interface CentralPayoutGateway {
  /** From the configured secret key; undefined when Stripe is not configured. */
  mode(): CentralStripeMode | undefined;
  retrieveBalance(): Promise<CentralBalance>;
  retrieveAccountPayoutState(): Promise<CentralAccountPayoutState>;
  createPayout(input: {
    amountCents: number;
    currency: string;
    destinationId: string;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<ProviderPayout>;
  retrievePayout(payoutId: string): Promise<ProviderPayout>;
  listRecentPayouts(input: { createdGte?: Date; limit: number }): Promise<ProviderPayout[]>;
}

/**
 * `definitive: true` — Stripe certainly did not create a payout (validation, auth, balance,
 * rate limit). `false` — the outcome is unknown (network loss, Stripe 5xx, idempotency
 * conflict), so the operation must be reconciled, never re-created under a new identity.
 */
export class CentralPayoutProviderError extends Error {
  public constructor(
    message: string,
    public readonly definitive: boolean,
    public readonly code: string | null = null,
  ) {
    super(message);
  }
}
