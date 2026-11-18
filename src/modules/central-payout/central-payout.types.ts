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
  defaultForCurrency: boolean | null;
};

export type CentralAccountPayoutState = {
  /** FG03B-1 — the platform account id (acct_…) when Stripe returned it; scopes history coverage. */
  accountId?: string;
  payoutsEnabled: boolean | null;
  /** Stripe `settings.payouts.schedule.interval`: manual | daily | weekly | monthly. */
  scheduleInterval: string | null;
  /** False when Stripe did not expose the account's external accounts to this key. */
  destinationsReadable: boolean;
  /** False means the returned destinations are only a partial/uncertain inventory. */
  destinationsComplete?: boolean;
  /** TEST_MODE_RESTRICTED — only with a TEST key, when Stripe refuses the bank-account list with
   * its exact "Only live keys can access this method" restriction (see STRIPE_TEST_DEFAULT_*). */
  destinationReadIssue?: "PERMISSIONS" | "PROVIDER" | "INCOMPLETE" | "TEST_MODE_RESTRICTED";
  destinations: CentralBankDestination[];
};

/**
 * TEST-only destination marker. Stripe TEST keys cannot list the platform's bank accounts, so
 * Bookly cannot name or verify one; a TEST payout created WITHOUT `destination` goes to the TEST
 * account's default external account for that currency (chosen by Stripe). This is not a bank
 * id (never `ba_…`), carries no bank details, and is refused for any LIVE key, mode or account.
 */
export const STRIPE_TEST_DEFAULT_DESTINATION = "stripe_test_default";
export const STRIPE_TEST_DEFAULT_LABEL =
  "Stripe TEST default destination — bank details unavailable in TEST mode.";
/** The exact Stripe refusal of the bank-account list for a TEST key (optional trailing period). */
export const STRIPE_TEST_BANK_LIST_RESTRICTION = /^Only live keys can access this method\.?$/;

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
  /** FG03B-2 — the platform account (acct_…) that owns the configured secret key, read from
   * Stripe itself (never from payload metadata). Throws when it cannot be established, so callers
   * fail closed. */
  platformAccountId(): Promise<string>;
  /** `destinationId` is a verified `ba_…` id, or STRIPE_TEST_DEFAULT_DESTINATION (TEST key only:
   * the adapter then omits `destination` and refuses before calling Stripe for any other key). */
  createPayout(input: {
    amountCents: number;
    currency: string;
    destinationId: string;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<ProviderPayout>;
  retrievePayout(payoutId: string): Promise<ProviderPayout>;
  listRecentPayouts(input: { createdGte?: Date; limit: number }): Promise<ProviderPayout[]>;
  /** FG03B-1 — one page of Stripe's payout list (newest first) with Stripe's own `has_more`, for
   * the bounded, resumable history sync. `startingAfter` is Stripe's cursor (a payout id). */
  listPayoutsPage(input: {
    limit: number;
    startingAfter?: string | undefined;
    createdGte?: Date | undefined;
  }): Promise<{ payouts: ProviderPayout[]; hasMore: boolean }>;
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
