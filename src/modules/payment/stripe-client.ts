import Stripe from "stripe";

import { env } from "../../config/env.js";
import { PaymentError } from "./payment.errors.js";

let cachedClient: Stripe | undefined;

/**
 * Lazily constructed — never at module-import time — so the whole application can still boot
 * (and every non-payment test can still run) in this environment, which has no real Stripe TEST
 * credentials configured (confirmed by inspecting every .env/.env.example file; see env.ts's
 * own comment on STRIPE_SECRET_KEY). The error only surfaces the moment a real charge is
 * actually attempted, exactly like this codebase's existing optional-provider convention.
 */
export const getStripeClient = (): Stripe => {
  if (cachedClient) {
    return cachedClient;
  }

  if (!env.STRIPE_SECRET_KEY) {
    throw new PaymentError("PAYMENT_PROVIDER_NOT_CONFIGURED", 503);
  }

  cachedClient = new Stripe(env.STRIPE_SECRET_KEY);
  return cachedClient;
};

/** Test-only escape hatch — never called from production code. */
export const resetStripeClientForTests = (): void => {
  cachedClient = undefined;
};
