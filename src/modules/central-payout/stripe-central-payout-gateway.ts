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
  if (account.object !== "bank_account") return null;
  const bank = account as Stripe.BankAccount;
  return {
    id: bank.id,
    bankName: bank.bank_name,
    last4: bank.last4,
    currency: bank.currency,
    country: bank.country,
    status: bank.status,
    defaultForCurrency: Boolean(bank.default_for_currency),
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
      throw providerError(error);
    }
    let external = account.external_accounts?.data;
    if (!external) {
      // Not every key/account type embeds external accounts; ask once more, read-only.
      try {
        external = (
          await this.client.accounts.listExternalAccounts(account.id, {
            object: "bank_account",
            limit: 20,
          })
        ).data;
      } catch {
        external = undefined;
      }
    }
    return {
      payoutsEnabled: Boolean(account.payouts_enabled),
      scheduleInterval: account.settings?.payouts?.schedule?.interval ?? null,
      destinationsReadable: Boolean(external),
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
