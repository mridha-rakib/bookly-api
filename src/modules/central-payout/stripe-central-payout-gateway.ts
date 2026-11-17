import type Stripe from "stripe";
import { env } from "../../config/env.js";
import { getStripeClient } from "../payment/stripe-client.js";
import {
  type CentralAccountPayoutState,
  type CentralBalance,
  type CentralBankDestination,
  type CentralPayoutGateway,
  CentralPayoutProviderError,
  type CentralStripeMode,
  type ProviderPayout,
} from "./central-payout.types.js";

/** Stripe error types that prove no object was created. Anything else is treated as unknown. */
const DEFINITIVE_ERROR_TYPES = new Set([
  "StripeInvalidRequestError",
  "StripeAuthenticationError",
  "StripePermissionError",
  "StripeRateLimitError",
  "StripeCardError",
]);
const isReadPermissionsError = (error: unknown): boolean => {
  const type = (error as { type?: unknown } | null)?.type;
  return type === "StripePermissionError" || type === "StripeAuthenticationError";
};
const BANK_STATUSES = new Set(["new", "validated", "verified", "verification_failed", "errored"]);

/** Shared with the webhook handler so both read a Stripe payout identically. */
export const toProviderPayout = (payout: Stripe.Payout): ProviderPayout => ({
  id: payout.id,
  amountCents: payout.amount,
  currency: payout.currency,
  status: payout.status,
  arrivalDate: payout.arrival_date ? new Date(payout.arrival_date * 1000) : null,
  created: new Date(payout.created * 1000),
  destinationId:
    typeof payout.destination === "string" ? payout.destination : (payout.destination?.id ?? null),
  failureCode: payout.failure_code,
  failureMessage: payout.failure_message,
  livemode: payout.livemode,
  automatic: payout.automatic,
  metadata: { ...(payout.metadata ?? {}) },
});

const toDestination = (account: Stripe.ExternalAccount): CentralBankDestination | null => {
  if (account?.object !== "bank_account") return null;
  const bank = account as Stripe.BankAccount;
  return {
    id: typeof bank.id === "string" ? bank.id : "",
    bankName:
      typeof bank.bank_name === "string" && bank.bank_name.trim() ? bank.bank_name.trim() : null,
    last4: typeof bank.last4 === "string" && /^[a-z0-9]{4}$/i.test(bank.last4) ? bank.last4 : "",
    currency:
      typeof bank.currency === "string" && /^[a-z]{3}$/.test(bank.currency) ? bank.currency : "",
    country:
      typeof bank.country === "string" && /^[A-Z]{2}$/.test(bank.country) ? bank.country : "",
    status: typeof bank.status === "string" && BANK_STATUSES.has(bank.status) ? bank.status : "",
    defaultForCurrency:
      typeof bank.default_for_currency === "boolean" ? bank.default_for_currency : null,
  };
};

/** Never forwards a raw Stripe error object; keeps only Stripe's own human-readable message. */
const providerError = (error: unknown): CentralPayoutProviderError => {
  const e = (error ?? {}) as { type?: unknown; message?: unknown; code?: unknown };
  const type = typeof e.type === "string" ? e.type : "";
  return new CentralPayoutProviderError(
    typeof e.message === "string" ? e.message : "Stripe request failed",
    DEFINITIVE_ERROR_TYPES.has(type),
    typeof e.code === "string" ? e.code : null,
  );
};

/** The one Stripe adapter for central payouts — Bookly's own (platform) account only. */
export class StripeCentralPayoutGateway implements CentralPayoutGateway {
  private get client(): Stripe {
    return getStripeClient();
  }

  public mode(): CentralStripeMode | undefined {
    const key = env.STRIPE_SECRET_KEY;
    if (!key) return undefined;
    if (/^(sk|rk)_live_/.test(key)) return "LIVE";
    if (/^(sk|rk)_test_/.test(key)) return "TEST";
    return undefined;
  }

  public async retrieveBalance(): Promise<CentralBalance> {
    try {
      const balance = await this.client.balance.retrieve();
      return {
        livemode: balance.livemode,
        available: balance.available.map((b) => ({ currency: b.currency, amountCents: b.amount })),
        pending: balance.pending.map((b) => ({ currency: b.currency, amountCents: b.amount })),
      };
    } catch (error) {
      throw providerError(error);
    }
  }

  public async retrieveAccountPayoutState(): Promise<CentralAccountPayoutState> {
    let account: Stripe.Account;
    try {
      account = await this.client.accounts.retrieveCurrent();
    } catch (error) {
      if (isReadPermissionsError(error))
        return {
          payoutsEnabled: null,
          scheduleInterval: null,
          destinationsReadable: false,
          destinationsComplete: false,
          destinationReadIssue: "PERMISSIONS",
          destinations: [],
        };
      throw providerError(error);
    }
    // Embedded accounts are a page, not the full inventory. All follow-up reads are
    // bound to the account returned by retrieveCurrent(), never an application Business ID.
    if (!account || typeof account.id !== "string" || !/^acct_[a-z0-9]+$/i.test(account.id))
      throw new CentralPayoutProviderError("Platform account response is incomplete", true);
    let external = Array.isArray(account.external_accounts?.data)
      ? account.external_accounts.data
      : undefined;
    let complete = Boolean(external && account.external_accounts?.has_more === false);
    let issue: CentralAccountPayoutState["destinationReadIssue"];
    if (!complete) {
      const pages: Stripe.ExternalAccount[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      try {
        // A hard request cap prevents an unbounded provider walk. Partial data remains
        // visible but cannot authorize default selection or a payout.
        for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
          const page = await this.client.accounts.listExternalAccounts(account.id, {
            object: "bank_account",
            limit: 100,
            ...(cursor ? { starting_after: cursor } : {}),
          });
          if (!Array.isArray(page.data)) {
            issue = "INCOMPLETE";
            break;
          }
          pages.push(...page.data);
          if (page.has_more === false) {
            complete = true;
            break;
          }
          const next = page.data.at(-1)?.id;
          if (page.has_more !== true || !next || seen.has(next)) {
            issue = "INCOMPLETE";
            break;
          }
          seen.add(next);
          cursor = next;
        }
        external = pages.length || complete ? pages : external;
        if (!complete) issue = "INCOMPLETE";
      } catch (error) {
        if (pages.length) external = pages;
        issue = isReadPermissionsError(error) ? "PERMISSIONS" : "PROVIDER";
      }
    }
    return {
      accountId: account.id,
      payoutsEnabled: typeof account.payouts_enabled === "boolean" ? account.payouts_enabled : null,
      scheduleInterval: account.settings?.payouts?.schedule?.interval ?? null,
      destinationsReadable: Boolean(external),
      destinationsComplete: complete,
      ...(issue ? { destinationReadIssue: issue } : {}),
      destinations: (external ?? [])
        .map(toDestination)
        .filter((d): d is CentralBankDestination => d !== null),
    };
  }

  public async createPayout(input: {
    amountCents: number;
    currency: string;
    destinationId: string;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<ProviderPayout> {
    try {
      const payout = await this.client.payouts.create(
        {
          amount: input.amountCents,
          currency: input.currency,
          destination: input.destinationId,
          metadata: input.metadata,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return toProviderPayout(payout);
    } catch (error) {
      throw providerError(error);
    }
  }

  public async retrievePayout(payoutId: string): Promise<ProviderPayout> {
    try {
      return toProviderPayout(await this.client.payouts.retrieve(payoutId));
    } catch (error) {
      throw providerError(error);
    }
  }

  public async listPayoutsPage(input: {
    limit: number;
    startingAfter?: string | undefined;
    createdGte?: Date | undefined;
  }): Promise<{ payouts: ProviderPayout[]; hasMore: boolean }> {
    try {
      const page = await this.client.payouts.list({
        limit: Math.min(Math.max(input.limit, 1), 100),
        ...(input.startingAfter ? { starting_after: input.startingAfter } : {}),
        ...(input.createdGte
          ? { created: { gte: Math.floor(input.createdGte.getTime() / 1000) } }
          : {}),
      });
      if (!Array.isArray(page.data) || typeof page.has_more !== "boolean")
        throw new CentralPayoutProviderError("Stripe payout list response is incomplete", false);
      return { payouts: page.data.map(toProviderPayout), hasMore: page.has_more };
    } catch (error) {
      if (error instanceof CentralPayoutProviderError) throw error;
      throw providerError(error);
    }
  }

  public async listRecentPayouts(input: {
    createdGte?: Date;
    limit: number;
  }): Promise<ProviderPayout[]> {
    try {
      const page = await this.client.payouts.list({
        limit: Math.min(Math.max(input.limit, 1), 100),
        ...(input.createdGte
          ? { created: { gte: Math.floor(input.createdGte.getTime() / 1000) } }
          : {}),
      });
      return page.data.map(toProviderPayout);
    } catch (error) {
      throw providerError(error);
    }
  }
}
