import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CentralPayoutService } from "../../src/modules/central-payout/central-payout.service.js";
import type { CentralPayoutGateway } from "../../src/modules/central-payout/central-payout.types.js";
import { CentralPayoutOperationModel } from "../../src/modules/central-payout/central-payout-operation.model.js";
import { StripeCentralPayoutGateway } from "../../src/modules/central-payout/stripe-central-payout-gateway.js";

const fake = vi.hoisted(() => ({
  env: { STRIPE_SECRET_KEY: "sk_test_fixture", NODE_ENV: "test", LOG_LEVEL: "silent" },
  accounts: { retrieveCurrent: vi.fn(), listExternalAccounts: vi.fn() },
}));
vi.mock("../../src/config/env.js", () => ({ env: fake.env }));
vi.mock("../../src/modules/payment/stripe-client.js", () => ({
  getStripeClient: () => ({ accounts: fake.accounts }),
}));
const bank = (id: string, currency = "eur", isDefault = true) => ({
  object: "bank_account",
  id,
  bank_name: "Fixture Bank",
  last4: "1234",
  currency,
  country: "CY",
  status: "verified",
  default_for_currency: isDefault,
});
const current = (data: unknown[], more = false) => ({
  id: "acct_platform",
  payouts_enabled: true,
  settings: { payouts: { schedule: { interval: "manual" } } },
  external_accounts: { data, has_more: more },
});
const gateway = () => new StripeCentralPayoutGateway();
const service = (adapter: StripeCentralPayoutGateway = gateway()) =>
  new CentralPayoutService({
    gateway: adapter,
    policy: { liveExecutionEnabled: true },
    verifyStepUp: async () => ({ email: "admin@example.com" }),
  });
beforeEach(() => {
  vi.resetAllMocks();
  fake.env.STRIPE_SECRET_KEY = "sk_test_fixture";
});
afterEach(() => vi.restoreAllMocks());

it("uses only the current platform account for every bank-list page and finds defaults beyond the embedded page", async () => {
  fake.accounts.retrieveCurrent.mockResolvedValue(
    current([bank("ba_secondary", "eur", false)], true),
  );
  fake.accounts.listExternalAccounts
    .mockResolvedValueOnce({ data: [bank("ba_secondary", "eur", false)], has_more: true })
    .mockResolvedValueOnce({ data: [bank("ba_eur"), bank("ba_usd", "usd")], has_more: false });
  const result = await gateway().retrieveAccountPayoutState();
  expect(fake.accounts.retrieveCurrent).toHaveBeenCalledExactlyOnceWith();
  expect(fake.accounts.listExternalAccounts.mock.calls).toEqual([
    ["acct_platform", { object: "bank_account", limit: 100 }],
    ["acct_platform", { object: "bank_account", limit: 100, starting_after: "ba_secondary" }],
  ]);
  expect(result.destinationsComplete).toBe(true);
  expect(
    result.destinations.filter((d) => d.defaultForCurrency).map((d) => [d.id, d.currency]),
  ).toEqual([
    ["ba_eur", "eur"],
    ["ba_usd", "usd"],
  ]);
});
it("ignores card destinations and recognizes a complete empty bank inventory", async () => {
  fake.accounts.retrieveCurrent.mockResolvedValue(
    current([{ object: "card", id: "card_fixture", last4: "1234" }]),
  );
  expect((await service().getBankAccountSummary()).state).toBe("NO_DESTINATION");
  expect(fake.accounts.listExternalAccounts).not.toHaveBeenCalled();
});
it("returns unknown nullable fields without leaking an invalid full account number", async () => {
  fake.accounts.retrieveCurrent.mockResolvedValue({
    ...current([
      {
        ...bank("ba_partial"),
        bank_name: null,
        last4: "FULL_ACCOUNT_SECRET",
        currency: null,
        country: null,
        status: null,
        default_for_currency: null,
      },
    ]),
    payouts_enabled: null,
  });
  const result = await service().getBankAccountSummary();
  expect(result.payoutsEnabled).toBeNull();
  expect(result.destinations[0]).toEqual({
    bankName: null,
    last4: null,
    currency: null,
    country: null,
    status: null,
    defaultForCurrency: null,
  });
  expect(JSON.stringify(result)).not.toContain("FULL_ACCOUNT");
});
it.each(["StripePermissionError", "StripeAuthenticationError"])(
  "distinguishes %s from an absent bank at account retrieval",
  async (type) => {
    fake.accounts.retrieveCurrent.mockRejectedValue({ type, message: "SECRET" });
    const result = await service().getBankAccountSummary();
    expect(result).toMatchObject({
      state: "UNAVAILABLE",
      unavailableReason: "PERMISSIONS",
      payoutsEnabled: null,
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  },
);
it("preserves known masked banks when further paging is denied but never treats the list as complete", async () => {
  fake.accounts.retrieveCurrent.mockResolvedValue(current([bank("ba_known")], true));
  fake.accounts.listExternalAccounts.mockRejectedValue({ type: "StripePermissionError" });
  expect(await service().getBankAccountSummary()).toMatchObject({
    state: "CONFIGURED",
    inventoryComplete: false,
    unavailableReason: "PERMISSIONS",
    destinations: [{ last4: "1234" }],
  });
});
it("bounds paging and does not turn a truncated list into an empty or complete bank inventory", async () => {
  fake.accounts.retrieveCurrent.mockResolvedValue(current([], true));
  for (let page = 0; page < 3; page++)
    fake.accounts.listExternalAccounts.mockResolvedValueOnce({
      data: [bank(`ba_page${page}`)],
      has_more: true,
    });
  const result = await gateway().retrieveAccountPayoutState();
  expect(fake.accounts.listExternalAccounts).toHaveBeenCalledTimes(3);
  expect(result.destinationsComplete).toBe(false);
  expect(result.destinationReadIssue).toBe("INCOMPLETE");
});
it("stops repeated cursors and malformed list responses without authorizing a destination", async () => {
  fake.accounts.retrieveCurrent.mockResolvedValue(current([], true));
  fake.accounts.listExternalAccounts.mockResolvedValue({
    data: [bank("ba_repeat")],
    has_more: true,
  });
  expect((await gateway().retrieveAccountPayoutState()).destinationsComplete).toBe(false);
  expect(fake.accounts.listExternalAccounts).toHaveBeenCalledTimes(2);
  fake.accounts.listExternalAccounts.mockResolvedValue({ data: null });
  expect((await service().getBankAccountSummary()).state).toBe("UNAVAILABLE");
});
it("reports temporary and incomplete account responses as unavailable", async () => {
  fake.accounts.retrieveCurrent.mockRejectedValue(new Error("SECRET_PROVIDER"));
  expect(await service().getBankAccountSummary()).toMatchObject({
    state: "UNAVAILABLE",
    unavailableReason: "PROVIDER",
  });
  fake.accounts.retrieveCurrent.mockResolvedValue(null);
  expect((await service().getBankAccountSummary()).state).toBe("UNAVAILABLE");
  expect(fake.accounts.listExternalAccounts).not.toHaveBeenCalled();
});
it.each([
  ["sk_test_fixture", "TEST"],
  ["rk_live_fixture", "LIVE"],
  ["", undefined],
  ["pk_live_fixture", undefined],
] as const)("recognizes credential context %s without any provider read", (key, mode) => {
  fake.env.STRIPE_SECRET_KEY = key;
  expect(gateway().mode()).toBe(mode);
  expect(fake.accounts.retrieveCurrent).not.toHaveBeenCalled();
});

it.each(["duplicates", "partial", "malformed"])(
  "rejects %s destination selection before creating any payout",
  async (kind) => {
    const banks = [bank("ba_default")];
    if (kind === "duplicates") banks.push(bank("ba_duplicate"));
    if (kind === "malformed") {
      const first = banks[0];
      if (!first) throw new Error("Missing bank fixture");
      first.last4 = "FULL_ACCOUNT_SECRET";
    }
    fake.accounts.retrieveCurrent.mockResolvedValue(current(banks, kind === "partial"));
    fake.accounts.listExternalAccounts.mockRejectedValue({ type: "StripePermissionError" });
    const adapter: CentralPayoutGateway = {
      mode: () => "TEST",
      retrieveAccountPayoutState: () => gateway().retrieveAccountPayoutState(),
      retrieveBalance: async () => ({
        livemode: false,
        available: [{ currency: "eur", amountCents: 10000 }],
        pending: [],
      }),
      createPayout: vi.fn(),
      retrievePayout: vi.fn(),
      listRecentPayouts: async () => [],
      listPayoutsPage: async () => ({ payouts: [], hasMore: false }),
    };
    vi.spyOn(CentralPayoutOperationModel, "findOne").mockReturnValue({
      lean: () => ({ exec: async () => null }),
    } as never);
    const create = vi.spyOn(CentralPayoutOperationModel, "create");
    const payouts = new CentralPayoutService({
      gateway: adapter,
      policy: { liveExecutionEnabled: false },
      verifyStepUp: async () => ({ email: "admin@example.com" }),
    });
    await expect(
      payouts.initiate("650000000000000000000001", {
        requestId: "fixture",
        amountCents: 100,
        currency: "eur",
        destinationId: "ba_default",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(create).not.toHaveBeenCalled();
    expect(adapter.createPayout).not.toHaveBeenCalled();
  },
);
