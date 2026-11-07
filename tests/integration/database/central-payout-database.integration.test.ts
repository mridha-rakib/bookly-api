import { randomUUID } from "node:crypto";
import express from "express";
import { Types } from "mongoose";
import type Stripe from "stripe";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "../../../src/common/middleware/error-handler.js";
import { TokenService } from "../../../src/modules/auth/token.service.js";
import { BookingFinancialTransactionModel } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.model.js";
import { BookingFinancialTransactionRepository } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.repository.js";
import { BookingFinancialTransactionService } from "../../../src/modules/booking-financial-transaction/booking-financial-transaction.service.js";
import { CentralPayoutService } from "../../../src/modules/central-payout/central-payout.service.js";
import {
  type CentralAccountPayoutState,
  type CentralBalance,
  type CentralPayoutGateway,
  CentralPayoutProviderError,
  type CentralStripeMode,
  type ProviderPayout,
} from "../../../src/modules/central-payout/central-payout.types.js";
import { CentralPayoutOperationModel } from "../../../src/modules/central-payout/central-payout-operation.model.js";
import type { PaymentGateway } from "../../../src/modules/payment/payment.types.js";
import { RefundOperationModel } from "../../../src/modules/payment/refund-operation.model.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StripeWebhookService } from "../../../src/modules/stripe-webhook/stripe-webhook.service.js";
import { StripeWebhookEventRepository } from "../../../src/modules/stripe-webhook/stripe-webhook-event.repository.js";
import { createSuperAdminRoute } from "../../../src/modules/super-admin/super-admin.route.js";
import { UserRepository } from "../../../src/modules/user/user.repository.js";
import type { UserRole } from "../../../src/modules/user/user.types.js";
import { issueTestAccessToken } from "../../helpers/access-token.js";
import {
  clearIsolatedDatabase,
  connectIsolatedDatabase,
  stopIsolatedReplicaSet,
} from "./mongo-replset-helper.js";

const BANK = "ba_fake_central";

/** Deterministic Stripe stand-in. Honours idempotency keys like Stripe does. */
class FakeCentralPayoutGateway implements CentralPayoutGateway {
  public modeValue: CentralStripeMode | undefined = "TEST";
  public balance: CentralBalance = {
    livemode: false,
    available: [{ currency: "eur", amountCents: 50_000 }],
    pending: [{ currency: "eur", amountCents: 1_000 }],
  };
  public account: CentralAccountPayoutState = {
    payoutsEnabled: true,
    scheduleInterval: "manual",
    destinationsReadable: true,
    destinations: [
      {
        id: BANK,
        bankName: "Test Bank",
        last4: "6789",
        currency: "eur",
        country: "CY",
        status: "verified",
        defaultForCurrency: true,
      },
    ],
  };
  public readonly createCalls: string[] = [];
  public readonly payouts = new Map<string, ProviderPayout>();
  /** "lost" = Stripe creates the payout but the response never arrives. */
  public nextCreate: "ok" | "lost" | "network" | "rejected" = "ok";

  public mode() {
    return this.modeValue;
  }
  public async retrieveBalance() {
    return this.balance;
  }
  public async retrieveAccountPayoutState() {
    return this.account;
  }
  public async createPayout(input: {
    amountCents: number;
    currency: string;
    destinationId: string;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }) {
    this.createCalls.push(input.idempotencyKey);
    const outcome = this.nextCreate;
    this.nextCreate = "ok";
    if (outcome === "network") throw new CentralPayoutProviderError("socket hang up", false);
    if (outcome === "rejected")
      throw new CentralPayoutProviderError("Insufficient funds", true, "balance_insufficient");
    const existing = this.payouts.get(input.idempotencyKey);
    const payout = existing ?? {
      id: `po_fake_${this.payouts.size + 1}`,
      amountCents: input.amountCents,
      currency: input.currency,
      status: "pending",
      arrivalDate: new Date("2030-01-03T00:00:00.000Z"),
      created: new Date(),
      destinationId: input.destinationId,
      failureCode: null,
      failureMessage: null,
      livemode: this.modeValue === "LIVE",
      automatic: false,
      metadata: input.metadata,
    };
    this.payouts.set(input.idempotencyKey, payout);
    if (outcome === "lost") throw new CentralPayoutProviderError("Request timed out", false);
    return payout;
  }
  public async retrievePayout(id: string) {
    const payout = [...this.payouts.values()].find((p) => p.id === id);
    if (!payout) throw new CentralPayoutProviderError("No such payout", true);
    return payout;
  }
  public async listRecentPayouts() {
    return [...this.payouts.values()];
  }
}

describe("P0.6 Super Admin central Stripe withdrawals", () => {
  let gateway: FakeCentralPayoutGateway;
  let service: CentralPayoutService;
  let liveEnabled: boolean;
  const admin = new Types.ObjectId();

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);
  beforeEach(async () => {
    await clearIsolatedDatabase();
    await CentralPayoutOperationModel.syncIndexes();
    gateway = new FakeCentralPayoutGateway();
    liveEnabled = false;
    service = new CentralPayoutService({
      gateway,
      policy: {
        get liveExecutionEnabled() {
          return liveEnabled;
        },
      },
      verifyStepUp: async (_userId, password) => {
        if (password !== "correct-password") throw new Error("INVALID_CURRENT_PASSWORD");
        return { email: "admin@example.com" };
      },
    });
  });
  afterAll(async () => {
    await stopIsolatedReplicaSet();
  });

  const submit = (overrides: Partial<Parameters<CentralPayoutService["initiate"]>[1]> = {}) =>
    service.initiate(String(admin), {
      requestId: randomUUID(),
      amountCents: 20_000,
      currency: "eur",
      destinationId: BANK,
      currentPassword: "correct-password",
      ...overrides,
    });

  // 1-3 — server-side role gate on the real Super Admin router (no Stripe call is reached).
  it("only an authenticated Super Admin reaches central balance and withdrawal routes", async () => {
    const users = new UserRepository();
    const tokens = new TokenService(new SessionRepository());
    const app = express();
    app.use(express.json());
    app.use("/super-admin", createSuperAdminRoute());
    app.use(createErrorHandler({ isProduction: true }));
    const tokenFor = async (role: UserRole) => {
      const user = await users.create({
        normalizedEmail: `${role.toLowerCase()}-${new Types.ObjectId()}@example.com`,
        passwordHash: "hash",
        role,
        status: "ACTIVE",
      });
      return issueTestAccessToken(tokens, { userId: user._id, role });
    };
    const body = {
      requestId: randomUUID(),
      amountCents: 100,
      currency: "eur",
      destinationId: BANK,
      currentPassword: "x",
    };

    await request(app).get("/super-admin/finance/withdrawals/overview").expect(401);
    for (const role of ["BUSINESS_OWNER", "STAFF", "CUSTOMER"] as const) {
      const token = await tokenFor(role);
      await request(app)
        .get("/super-admin/finance/withdrawals/overview")
        .set("Authorization", `Bearer ${token}`)
        .expect(403);
      await request(app)
        .post("/super-admin/finance/withdrawals")
        .set("Authorization", `Bearer ${token}`)
        .send(body)
        .expect(403);
    }
    const superToken = await tokenFor("SUPER_ADMIN");
    await request(app)
      .get("/super-admin/finance/withdrawals")
      .set("Authorization", `Bearer ${superToken}`)
      .expect(200);
    // Unknown fields (e.g. a client-chosen destination account number) are rejected.
    await request(app)
      .post("/super-admin/finance/withdrawals")
      .set("Authorization", `Bearer ${superToken}`)
      .send({ ...body, iban: "CY00000000000000000000000000" })
      .expect(400);
    expect(await CentralPayoutOperationModel.countDocuments()).toBe(0);
  });

  it("4/5 validates step-up, balance, currency and destination before anything is sent", async () => {
    await expect(submit({ currentPassword: "wrong" })).rejects.toThrow("INVALID_CURRENT_PASSWORD");
    await expect(submit({ amountCents: 50_001 })).rejects.toMatchObject({ statusCode: 422 });
    await expect(submit({ currency: "usd" })).rejects.toMatchObject({ statusCode: 422 });
    await expect(submit({ destinationId: "ba_someone_else" })).rejects.toMatchObject({
      statusCode: 422,
    });
    gateway.account = { ...gateway.account, scheduleInterval: "daily" };
    await expect(submit()).rejects.toMatchObject({ statusCode: 409 });
    expect(gateway.createCalls).toHaveLength(0);
    expect(await CentralPayoutOperationModel.countDocuments()).toBe(0);
  });

  it("12 LIVE execution is blocked unless enabled; TEST/LIVE data never mix", async () => {
    gateway.modeValue = "LIVE";
    gateway.balance = { ...gateway.balance, livemode: true };
    await expect(submit()).rejects.toMatchObject({ statusCode: 409 });
    gateway.balance = { ...gateway.balance, livemode: false }; // LIVE key, TEST data
    liveEnabled = true;
    await expect(submit()).rejects.toMatchObject({ statusCode: 409 });
    expect(gateway.createCalls).toHaveLength(0);
    gateway.modeValue = "TEST";
    const op = await submit();
    expect(op).toMatchObject({ mode: "TEST", state: "SUBMITTED", providerStatus: "pending" });
    const overview = await service.getOverview();
    expect(overview.restrictions).toEqual([]);
    expect(overview.balances).toEqual([
      { currency: "eur", availableCents: 50_000, pendingCents: 1_000 },
    ]);
  });

  it("6 a repeated submission returns the same operation and one Stripe payout", async () => {
    const requestId = randomUUID();
    const first = await submit({ requestId });
    const again = await submit({ requestId });
    expect(String(again._id)).toBe(String(first._id));
    expect(first).toMatchObject({
      state: "SUBMITTED",
      providerPayoutId: "po_fake_1",
      providerStatus: "pending", // Stripe "pending" is never shown as paid
      destinationLast4: "6789",
      initiatedByEmail: "admin@example.com",
    });
    expect(gateway.createCalls).toEqual([`central-payout:${String(first._id)}`]);
    await expect(submit({ requestId, amountCents: 1 })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("7 a lost response is reconciled to the original payout; no second payout, no parallel withdrawal", async () => {
    gateway.nextCreate = "lost";
    const op = await submit();
    expect(op.state).toBe("UNKNOWN");
    await expect(submit()).rejects.toMatchObject({ statusCode: 409 }); // one unresolved at a time
    const refreshed = await service.refresh(String(op._id));
    expect(refreshed).toMatchObject({ state: "SUBMITTED", providerPayoutId: "po_fake_1" });
    expect(gateway.createCalls).toHaveLength(1);
    expect(refreshed.activeSlot).toBeUndefined();

    // Network failure before Stripe saw it: recovery resends with the SAME idempotency key.
    gateway.nextCreate = "network";
    const second = await submit();
    expect(second.state).toBe("UNKNOWN");
    const resent = await service.refresh(String(second._id));
    expect(resent).toMatchObject({ state: "SUBMITTED", providerPayoutId: "po_fake_2" });
    expect(gateway.createCalls).toEqual([
      `central-payout:${String(op._id)}`,
      `central-payout:${String(second._id)}`,
      `central-payout:${String(second._id)}`,
    ]);

    gateway.nextCreate = "rejected";
    expect(await submit()).toMatchObject({
      state: "REJECTED",
      failureCode: "balance_insufficient",
    });
    expect(gateway.payouts.size).toBe(2);
  });

  it("8/9/10/11 webhook status sync is idempotent, keeps paid→failed, and never touches booking ledgers", async () => {
    const ledgerBefore = await BookingFinancialTransactionModel.countDocuments();
    const refundsBefore = await RefundOperationModel.countDocuments();
    const op = await submit();
    const payout = gateway.payouts.get(op.providerIdempotencyKey) as ProviderPayout;
    const webhook = new StripeWebhookService(
      {} as PaymentGateway,
      new StripeWebhookEventRepository(),
      new BookingFinancialTransactionService(new BookingFinancialTransactionRepository()),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );
    const event = (id: string, type: string, status: string, extra: Partial<Stripe.Payout> = {}) =>
      ({
        id,
        type,
        data: {
          object: {
            id: payout.id,
            object: "payout",
            amount: payout.amountCents,
            currency: payout.currency,
            status,
            arrival_date: Math.floor(Date.parse("2030-01-03") / 1000),
            created: Math.floor(Date.now() / 1000),
            destination: BANK,
            failure_code: null,
            failure_message: null,
            livemode: false,
            automatic: false,
            metadata: payout.metadata,
            ...extra,
          },
        },
      }) as unknown as Stripe.Event;

    expect(await webhook.process(event("evt_paid", "payout.paid", "paid"))).toBe(true);
    expect(await webhook.process(event("evt_paid", "payout.paid", "paid"))).toBe(false); // replay
    await webhook.process(event("evt_old", "payout.updated", "in_transit")); // out of order
    expect((await service.get(String(op._id))).providerStatus).toBe("paid");
    await webhook.process(
      event("evt_failed", "payout.failed", "failed", {
        failure_code: "account_closed",
        failure_message: "The bank account has been closed",
      }),
    );
    await webhook.process(event("evt_paid_late", "payout.paid", "paid")); // never back to paid
    const final = await service.get(String(op._id));
    expect(final).toMatchObject({ providerStatus: "failed", failureCode: "account_closed" });
    expect(final.audit.filter((a) => a.kind === "STATUS_CHANGED")).toHaveLength(2);
    // Payouts Bookly did not create (e.g. Stripe Dashboard) are acknowledged and ignored.
    await webhook.process({
      ...event("evt_other", "payout.paid", "paid"),
      data: {
        object: { ...event("x", "payout.paid", "paid").data.object, id: "po_other", metadata: {} },
      },
    } as unknown as Stripe.Event);
    expect(await CentralPayoutOperationModel.countDocuments()).toBe(1);
    expect(await BookingFinancialTransactionModel.countDocuments()).toBe(ledgerBefore);
    expect(await RefundOperationModel.countDocuments()).toBe(refundsBefore);
  });
});
