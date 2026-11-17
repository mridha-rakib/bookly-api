import express from "express";
import { Types } from "mongoose";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { createErrorHandler } from "../../src/common/middleware/error-handler.js";
import { TokenService } from "../../src/modules/auth/token.service.js";
import { CentralPayoutService } from "../../src/modules/central-payout/central-payout.service.js";
import type {
  CentralPayoutGateway,
  CentralStripeMode,
} from "../../src/modules/central-payout/central-payout.types.js";
import { CentralPayoutOperationModel } from "../../src/modules/central-payout/central-payout-operation.model.js";
import { StripeCentralPayoutGateway } from "../../src/modules/central-payout/stripe-central-payout-gateway.js";
import { createSuperAdminRoute } from "../../src/modules/super-admin/super-admin.route.js";
import { UserRepository } from "../../src/modules/user/user.repository.js";
import type { UserRole } from "../../src/modules/user/user.types.js";

const stripe = vi.hoisted(() => ({
  accounts: { retrieveCurrent: vi.fn(), listExternalAccounts: vi.fn() },
}));
vi.mock("../../src/modules/payment/stripe-client.js", () => ({ getStripeClient: () => stripe }));
// CW-1 — eligibility/readiness read the database; DB-less unit tests fix the decision.
const cw = vi.hoisted(() => ({ status: "AVAILABLE" as "AVAILABLE" | "UNAVAILABLE" }));
vi.mock("../../src/modules/central-payout/withdrawal-eligibility.js", async (importOriginal) => {
  const helper = await import("../helpers/central-eligibility-mock.js");
  return {
    ...(await importOriginal<
      typeof import("../../src/modules/central-payout/withdrawal-eligibility.js")
    >()),
    evaluateWithdrawalEligibility: async () => helper.fixedEligibility(cw.status),
  };
});
vi.mock("../../src/modules/central-payout/payout-reconciliation.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/modules/central-payout/payout-reconciliation.js")
  >()),
  readReconciliationReadiness: async () => ({ blockers: [] }),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function fixture(mode: CentralStripeMode | undefined = "TEST", liveEnabled = false) {
  const bank = {
    id: "ba_platform",
    bankName: "Platform bank",
    last4: "1234",
    currency: "eur",
    country: "CY",
    status: "verified",
    defaultForCurrency: true,
  };
  const account = {
    accountId: "acct_platform",
    payoutsEnabled: true,
    scheduleInterval: "manual",
    destinationsReadable: true,
    destinations: [bank],
  };
  const gateway: CentralPayoutGateway = {
    mode: () => mode,
    retrieveBalance: vi.fn(async () => ({
      livemode: mode === "LIVE",
      available: [{ currency: "eur", amountCents: 1000 }],
      pending: [{ currency: "eur", amountCents: 5000 }],
    })),
    retrieveAccountPayoutState: vi.fn(async () => account),
    createPayout: vi.fn(),
    retrievePayout: vi.fn(),
    listRecentPayouts: vi.fn(async () => []),
    listPayoutsPage: vi.fn(async () => ({ payouts: [], hasMore: false })),
    platformAccountId: vi.fn(async () => "acct_unittest"),
  };
  return {
    bank,
    account,
    gateway,
    service: new CentralPayoutService({
      gateway,
      policy: { liveExecutionEnabled: liveEnabled },
      verifyStepUp: async () => ({ email: "admin@example.com" }),
    }),
  };
}

it("projects only masked provider fields and needs neither balance nor history to read the platform bank", async () => {
  const f = fixture();
  Object.assign(f.bank, {
    account_number: "SECRET_ACCOUNT",
    routing_number: "SECRET_ROUTING",
    iban: "SECRET_IBAN",
  });
  const result = await f.service.getBankAccountSummary();
  expect(result).toEqual({
    mode: "TEST",
    managedBy: "STRIPE",
    state: "CONFIGURED",
    payoutsEnabled: true,
    inventoryComplete: true,
    destinations: [
      {
        bankName: "Platform bank",
        last4: "1234",
        currency: "eur",
        country: "CY",
        status: "verified",
        defaultForCurrency: true,
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(f.gateway.retrieveBalance).not.toHaveBeenCalled();
  expect(f.gateway.listRecentPayouts).not.toHaveBeenCalled();
});
it("distinguishes no destination, unreadable metadata, unconfigured Stripe and provider failure", async () => {
  const f = fixture();
  f.account.destinations = [];
  expect((await f.service.getBankAccountSummary()).state).toBe("NO_DESTINATION");
  f.account.destinationsReadable = false;
  expect((await f.service.getBankAccountSummary()).state).toBe("UNAVAILABLE");
  vi.mocked(f.gateway.retrieveAccountPayoutState).mockRejectedValue(
    new Error("SECRET_PROVIDER_ERROR"),
  );
  const failed = await f.service.getBankAccountSummary();
  expect(failed.state).toBe("UNAVAILABLE");
  expect(JSON.stringify(failed)).not.toContain("SECRET");
  f.gateway.mode = () => undefined;
  expect((await f.service.getBankAccountSummary()).state).toBe("NOT_CONFIGURED");
});
it("does not expose a malformed full account identifier through last4", async () => {
  const f = fixture();
  f.bank.last4 = "CY_FULL_ACCOUNT_NUMBER";
  expect((await f.service.getBankAccountSummary()).destinations[0]?.last4).toBeNull();
});
it("Stripe adapter reads the current platform account and never returns raw external-account fields", async () => {
  stripe.accounts.retrieveCurrent.mockResolvedValue({
    id: "acct_platform",
    payouts_enabled: true,
    settings: { payouts: { schedule: { interval: "manual" } } },
    external_accounts: {
      has_more: false,
      data: [
        {
          object: "bank_account",
          id: "ba_platform",
          bank_name: "Bank",
          last4: "1234",
          currency: "eur",
          country: "CY",
          status: "verified",
          default_for_currency: true,
          account_number: "SECRET_ACCOUNT",
          routing_number: "SECRET_ROUTING",
        },
      ],
    },
  });
  const result = await new StripeCentralPayoutGateway().retrieveAccountPayoutState();
  expect(stripe.accounts.retrieveCurrent).toHaveBeenCalledExactlyOnceWith();
  expect(stripe.accounts.listExternalAccounts).not.toHaveBeenCalled();
  expect(result.destinations[0]?.id).toBe("ba_platform");
  expect(JSON.stringify(result)).not.toContain("SECRET");
});
it("Stripe permissions failure is unreadable, not an empty configured bank list", async () => {
  stripe.accounts.retrieveCurrent.mockResolvedValue({
    id: "acct_platform",
    payouts_enabled: false,
  });
  stripe.accounts.listExternalAccounts.mockRejectedValue(new Error("permission denied"));
  const result = await new StripeCentralPayoutGateway().retrieveAccountPayoutState();
  expect(result.destinationsReadable).toBe(false);
  expect(result.destinations).toEqual([]);
  expect(stripe.accounts.listExternalAccounts.mock.calls[0]?.[0]).toBe("acct_platform");
});

it("CW-1 LIVE needs the deployment flag AND available eligibility, before operation creation", async () => {
  vi.spyOn(CentralPayoutOperationModel, "findOne").mockReturnValue({
    lean: () => ({ exec: async () => null }),
  } as never);
  const create = vi.spyOn(CentralPayoutOperationModel, "create");
  const request = {
    requestId: "request",
    amountCents: 500,
    currency: "eur",
    destinationId: "ba_platform",
    currentPassword: "test",
    eligibilityDigest: "a".repeat(64),
  };
  // Flag off: refused whatever the eligibility.
  await expect(
    fixture("LIVE", false).service.initiate(String(new Types.ObjectId()), request),
  ).rejects.toMatchObject({ details: [{ code: "CENTRAL_PAYOUT_LIVE_DISABLED" }] });
  // Flag on but eligibility unavailable: still refused, with the evidence reason.
  cw.status = "UNAVAILABLE";
  try {
    const f = fixture("LIVE", true);
    await expect(f.service.initiate(String(new Types.ObjectId()), request)).rejects.toMatchObject({
      details: [{ code: "CENTRAL_PAYOUT_ELIGIBILITY_UNAVAILABLE" }],
    });
    expect(f.gateway.createPayout).not.toHaveBeenCalled();
  } finally {
    cw.status = "AVAILABLE";
  }
  // A digest that no longer matches the current evaluation is refused as stale.
  await expect(
    fixture("LIVE", true).service.initiate(String(new Types.ObjectId()), {
      ...request,
      eligibilityDigest: "b".repeat(64),
    }),
  ).rejects.toMatchObject({ details: [{ code: "CENTRAL_PAYOUT_ELIGIBILITY_CHANGED" }] });
  expect(create).not.toHaveBeenCalled();
});
it("does not treat pending provider funds as available", async () => {
  const f = fixture();
  vi.spyOn(CentralPayoutOperationModel, "findOne").mockReturnValue({
    lean: () => ({ exec: async () => null }),
  } as never);
  await expect(
    f.service.initiate(String(new Types.ObjectId()), {
      requestId: "request",
      amountCents: 2000,
      currency: "eur",
      destinationId: "ba_platform",
      eligibilityDigest: "a".repeat(64),
    }),
  ).rejects.toMatchObject({ statusCode: 422 });
  expect(f.gateway.createPayout).not.toHaveBeenCalled();
});

it.each(["SUPER_ADMIN", "BUSINESS_OWNER", "SUPERVISOR", "STAFF", "CUSTOMER", null] as const)(
  "bank endpoint enforces the real Super Admin router gate for %s",
  async (role) => {
    const id = new Types.ObjectId();
    vi.spyOn(TokenService.prototype, "verifyAccessToken").mockResolvedValue({
      sub: String(id),
      sid: "session",
      role: role as UserRole,
    } as never);
    vi.spyOn(TokenService.prototype, "isAccessTokenSessionLive").mockResolvedValue(true);
    vi.spyOn(UserRepository.prototype, "findById").mockResolvedValue({
      _id: id,
      role,
      status: "ACTIVE",
    } as never);
    const summary = vi
      .spyOn(CentralPayoutService.prototype, "getBankAccountSummary")
      .mockResolvedValue({
        mode: "TEST",
        managedBy: "STRIPE",
        state: "NO_DESTINATION",
        payoutsEnabled: false,
        inventoryComplete: true,
        destinations: [],
      });
    const app = express();
    app.use("/super-admin", createSuperAdminRoute());
    app.use(createErrorHandler());
    const call = request(app).get("/super-admin/finance/withdrawals/bank-account");
    if (role) call.set("Authorization", "Bearer test");
    const response = await call;
    expect(response.status).toBe(role === "SUPER_ADMIN" ? 200 : role ? 403 : 401);
    expect(summary).toHaveBeenCalledTimes(role === "SUPER_ADMIN" ? 1 : 0);
  },
);
