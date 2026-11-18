import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CentralPayoutProviderError,
  STRIPE_TEST_DEFAULT_DESTINATION,
} from "../../src/modules/central-payout/central-payout.types.js";
import { StripeCentralPayoutGateway } from "../../src/modules/central-payout/stripe-central-payout-gateway.js";

/**
 * Stripe TEST keys cannot list the platform's bank accounts ("Only live keys can access this
 * method"). The adapter classifies only that exact refusal, only for a TEST key, and only then
 * lets Stripe choose the TEST default destination by omitting `destination`.
 */
const mockEnv = vi.hoisted(() => ({ STRIPE_SECRET_KEY: "sk_test_unit" as string | undefined }));
vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));
const stripe = vi.hoisted(() => ({
  accounts: { retrieveCurrent: vi.fn(), listExternalAccounts: vi.fn() },
  payouts: { create: vi.fn() },
}));
vi.mock("../../src/modules/payment/stripe-client.js", () => ({ getStripeClient: () => stripe }));

const RESTRICTION = Object.assign(new Error("Only live keys can access this method."), {
  type: "StripeInvalidRequestError",
});
const account = {
  id: "acct_platform",
  payouts_enabled: true,
  settings: { payouts: { schedule: { interval: "manual" } } },
};
const stripePayout = {
  id: "po_test_1",
  amount: 1000,
  currency: "eur",
  status: "pending",
  arrival_date: 1_900_000_000,
  created: 1_800_000_000,
  destination: "ba_stripechosen",
  failure_code: null,
  failure_message: null,
  livemode: false,
  automatic: false,
  metadata: { booklyCentralPayoutOperationId: "op1" },
};
const payoutInput = (destinationId: string) => ({
  amountCents: 1000,
  currency: "eur",
  destinationId,
  idempotencyKey: "central-payout:op1",
  metadata: { booklyCentralPayoutOperationId: "op1" },
});

beforeEach(() => {
  mockEnv.STRIPE_SECRET_KEY = "sk_test_unit";
  stripe.accounts.retrieveCurrent.mockResolvedValue(account);
  stripe.payouts.create.mockResolvedValue(stripePayout);
});
afterEach(() => vi.clearAllMocks());

it("a TEST key with Stripe's exact bank-list restriction is TEST_MODE_RESTRICTED, with no invented bank", async () => {
  stripe.accounts.listExternalAccounts.mockRejectedValue(RESTRICTION);
  const state = await new StripeCentralPayoutGateway().retrieveAccountPayoutState();
  expect(state).toMatchObject({
    accountId: "acct_platform",
    destinationsReadable: false,
    destinationsComplete: false,
    destinationReadIssue: "TEST_MODE_RESTRICTED",
    destinations: [],
  });
  // Also without the trailing period.
  stripe.accounts.listExternalAccounts.mockRejectedValue(
    new Error("Only live keys can access this method"),
  );
  expect(
    (await new StripeCentralPayoutGateway().retrieveAccountPayoutState()).destinationReadIssue,
  ).toBe("TEST_MODE_RESTRICTED");
});

it("the same message with a LIVE key, or any other TEST failure, is never TEST_MODE_RESTRICTED", async () => {
  mockEnv.STRIPE_SECRET_KEY = "sk_live_unit";
  stripe.accounts.listExternalAccounts.mockRejectedValue(RESTRICTION);
  expect(
    (await new StripeCentralPayoutGateway().retrieveAccountPayoutState()).destinationReadIssue,
  ).toBe("PROVIDER");
  mockEnv.STRIPE_SECRET_KEY = "rk_live_unit";
  expect(
    (await new StripeCentralPayoutGateway().retrieveAccountPayoutState()).destinationReadIssue,
  ).toBe("PROVIDER");

  mockEnv.STRIPE_SECRET_KEY = "sk_test_unit";
  for (const [error, issue] of [
    [new Error("Only live keys can access this method. Also something else"), "PROVIDER"],
    [new Error("An error occurred with our connection to Stripe."), "PROVIDER"],
    [
      Object.assign(new Error("permission denied"), { type: "StripePermissionError" }),
      "PERMISSIONS",
    ],
  ] as const) {
    stripe.accounts.listExternalAccounts.mockRejectedValue(error);
    expect(
      (await new StripeCentralPayoutGateway().retrieveAccountPayoutState()).destinationReadIssue,
    ).toBe(issue);
  }
});

it("the TEST default omits `destination` with a TEST key; a verified bank still passes its id", async () => {
  const gateway = new StripeCentralPayoutGateway();
  const payout = await gateway.createPayout(payoutInput(STRIPE_TEST_DEFAULT_DESTINATION));
  const [params, options] = stripe.payouts.create.mock.calls[0] ?? [];
  expect(params).toEqual({
    amount: 1000,
    currency: "eur",
    metadata: { booklyCentralPayoutOperationId: "op1" },
  });
  expect(params).not.toHaveProperty("destination");
  expect(options).toEqual({ idempotencyKey: "central-payout:op1" });
  expect(payout).toMatchObject({
    id: "po_test_1",
    destinationId: "ba_stripechosen",
    livemode: false,
  });

  await gateway.createPayout(payoutInput("ba_verified"));
  expect(stripe.payouts.create.mock.calls[1]?.[0]).toMatchObject({ destination: "ba_verified" });
});

it("the TEST default marker never reaches Stripe with a LIVE or missing key", async () => {
  for (const key of ["sk_live_unit", "rk_live_unit", undefined]) {
    mockEnv.STRIPE_SECRET_KEY = key;
    const error = await new StripeCentralPayoutGateway()
      .createPayout(payoutInput(STRIPE_TEST_DEFAULT_DESTINATION))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CentralPayoutProviderError);
    expect(error).toMatchObject({ definitive: true });
  }
  expect(stripe.payouts.create).not.toHaveBeenCalled();
});

it("Stripe's refusal of a TEST default payout is surfaced as Stripe's definitive message", async () => {
  stripe.payouts.create.mockRejectedValue(
    Object.assign(new Error("You do not have a default external account in eur."), {
      type: "StripeInvalidRequestError",
      code: "parameter_missing",
    }),
  );
  await expect(
    new StripeCentralPayoutGateway().createPayout(payoutInput(STRIPE_TEST_DEFAULT_DESTINATION)),
  ).rejects.toMatchObject({
    message: "You do not have a default external account in eur.",
    definitive: true,
    code: "parameter_missing",
  });
  // A network loss is still an unknown outcome (reconciled, never re-created).
  stripe.payouts.create.mockRejectedValue(
    Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" }),
  );
  await expect(
    new StripeCentralPayoutGateway().createPayout(payoutInput(STRIPE_TEST_DEFAULT_DESTINATION)),
  ).rejects.toMatchObject({ definitive: false });
});
