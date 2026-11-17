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
import { createCentralPayoutRouter } from "../../../src/modules/central-payout/central-payout.route.js";
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
import {
  StripePayoutHistoryCoverageModel,
  StripePayoutObservationModel,
} from "../../../src/modules/central-payout/stripe-payout-observation.model.js";
import type { PaymentGateway } from "../../../src/modules/payment/payment.types.js";
import { RefundOperationModel } from "../../../src/modules/payment/refund-operation.model.js";
import { SessionRepository } from "../../../src/modules/session/session.repository.js";
import { StripeWebhookService } from "../../../src/modules/stripe-webhook/stripe-webhook.service.js";
import { StripeWebhookEventModel } from "../../../src/modules/stripe-webhook/stripe-webhook-event.model.js";
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

const BANK = "ba_fakecentral";

/** Deterministic Stripe stand-in. Honours idempotency keys like Stripe does. */
class FakeCentralPayoutGateway implements CentralPayoutGateway {
  public modeValue: CentralStripeMode | undefined = "TEST";
  public balance: CentralBalance = {
    livemode: false,
    available: [{ currency: "eur", amountCents: 50_000 }],
    pending: [{ currency: "eur", amountCents: 1_000 }],
  };
  public account: CentralAccountPayoutState = {
    accountId: "acct_platformtest",
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
  /** FG03B-2 — the configured key's own account; `undefined` simulates an unreadable identity. */
  public platformAccountCalls = 0;
  public async platformAccountId() {
    this.platformAccountCalls += 1;
    if (!this.account.accountId)
      throw new CentralPayoutProviderError("Platform account identity is unavailable", false);
    return this.account.accountId;
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
  /** FG03B-1 — provider history, newest first, served in small pages like Stripe's cursor list. */
  public history: ProviderPayout[] = [];
  public historyPageSize = 2;
  public historyCalls: { startingAfter?: string; createdGte?: Date }[] = [];
  /** Throw a transient provider error on this (1-based) listPayoutsPage call. */
  public failHistoryCall: number | null = null;
  /** FG03B-2 — runs before each listPayoutsPage call (e.g. to simulate a competing run). */
  public onHistoryCall: ((call: number) => Promise<void>) | null = null;
  public async listPayoutsPage(input: {
    limit: number;
    startingAfter?: string | undefined;
    createdGte?: Date | undefined;
  }) {
    this.historyCalls.push({
      ...(input.startingAfter ? { startingAfter: input.startingAfter } : {}),
      ...(input.createdGte ? { createdGte: input.createdGte } : {}),
    });
    await this.onHistoryCall?.(this.historyCalls.length);
    if (this.failHistoryCall === this.historyCalls.length)
      throw new CentralPayoutProviderError("Rate limited by Stripe", false, "rate_limit");
    const eligible = this.history.filter(
      (p) => !input.createdGte || p.created.getTime() >= input.createdGte.getTime(),
    );
    const start = input.startingAfter
      ? eligible.findIndex((p) => p.id === input.startingAfter) + 1
      : 0;
    const size = Math.min(input.limit, this.historyPageSize);
    const payouts = eligible.slice(start, start + size);
    return { payouts, hasMore: start + size < eligible.length };
  }
}

const historyPayout = (n: number, over: Partial<ProviderPayout> = {}): ProviderPayout => ({
  id: `po_hist_${n}`,
  amountCents: 1000 + n,
  currency: "eur",
  status: "paid",
  arrivalDate: null,
  // Settled history by default: paid well outside the paid→failed window.
  created: new Date(Date.UTC(2025, 0, 1) - n * 60_000),
  destinationId: BANK,
  failureCode: null,
  failureMessage: null,
  livemode: false,
  automatic: true,
  metadata: {},
  ...over,
});

describe("P0.6 Super Admin central Stripe withdrawals", () => {
  let gateway: FakeCentralPayoutGateway;
  let service: CentralPayoutService;
  let liveEnabled: boolean;
  let historySyncEnabled: boolean;
  const admin = new Types.ObjectId();

  beforeAll(async () => {
    await connectIsolatedDatabase();
  }, 120_000);
  beforeEach(async () => {
    await clearIsolatedDatabase();
    await CentralPayoutOperationModel.syncIndexes();
    await StripePayoutObservationModel.syncIndexes();
    await StripePayoutHistoryCoverageModel.syncIndexes();
    gateway = new FakeCentralPayoutGateway();
    liveEnabled = false;
    historySyncEnabled = true;
    service = new CentralPayoutService({
      gateway,
      policy: {
        get liveExecutionEnabled() {
          return liveEnabled;
        },
        get historySyncEnabled() {
          return historySyncEnabled;
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

    // FG03B-1 — the history sync route: Super Admin only, bounded body, and refused while the
    // deployment flag is off (the default), before any Stripe call or checkpoint write.
    const sync = "/super-admin/finance/withdrawals/provider-history/sync";
    await request(app).post(sync).send({}).expect(401);
    for (const role of ["BUSINESS_OWNER", "STAFF", "CUSTOMER"] as const)
      await request(app)
        .post(sync)
        .set("Authorization", `Bearer ${await tokenFor(role)}`)
        .send({})
        .expect(403);
    await request(app)
      .post(sync)
      .set("Authorization", `Bearer ${superToken}`)
      .send({ maxPages: 11 })
      .expect(400);
    await request(app)
      .post(sync)
      .set("Authorization", `Bearer ${superToken}`)
      .send({ maxPages: 2, cursor: "po_x" })
      .expect(400);
    const disabled = await request(app)
      .post(sync)
      .set("Authorization", `Bearer ${superToken}`)
      .send({})
      .expect(409);
    expect(JSON.stringify(disabled.body)).toContain("CENTRAL_PAYOUT_HISTORY_SYNC_DISABLED");
    expect(await StripePayoutHistoryCoverageModel.countDocuments()).toBe(0);

    // FG03B-2 — the observed-payout review route: Super Admin only, strict bounded filters
    // (validation runs before any Stripe call or database read).
    const review = "/super-admin/finance/withdrawals/provider-payouts";
    await request(app).get(review).expect(401);
    for (const role of ["BUSINESS_OWNER", "STAFF", "CUSTOMER"] as const)
      await request(app)
        .get(review)
        .set("Authorization", `Bearer ${await tokenFor(role)}`)
        .expect(403);
    for (const bad of [
      "limit=51",
      "linkage=UNAUTHORIZED",
      "status=reversed",
      "from=2030-02-01&to=2030-01-01",
      "from=2030-13-01",
      "accountId=acct_other",
      "needsReview=yes",
    ])
      await request(app)
        .get(`${review}?${bad}`)
        .set("Authorization", `Bearer ${superToken}`)
        .expect(400);
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

  it("FG03B-0 recent Stripe payouts: origin verified only by a recorded payout id, no sensitive fields", async () => {
    const op = await submit();
    const base = {
      amountCents: 2500,
      currency: "eur",
      status: "paid",
      arrivalDate: null,
      created: new Date("2030-01-01T00:00:00.000Z"),
      destinationId: BANK,
      failureCode: null,
      failureMessage: null,
      livemode: false,
    };
    // A Dashboard/automatic payout, and one whose metadata names a Bookly operation it is not
    // linked to: neither may be labelled as Bookly's, and neither is called unauthorized.
    gateway.payouts.set("dashboard", {
      ...base,
      id: "po_dashboard",
      automatic: true,
      metadata: {},
      destinationId: "ba_unknown",
    });
    gateway.payouts.set("forged", {
      ...base,
      id: "po_forged",
      automatic: false,
      metadata: { booklyCentralPayoutOperationId: String(op._id) },
    });
    const writesBefore = await CentralPayoutOperationModel.find().lean();

    const overview = await service.getOverview();
    const byId = new Map(overview.recentStripePayouts.map((p) => [p.id, p]));
    expect(byId.get(op.providerPayoutId as string)).toMatchObject({
      origin: "BOOKLY_WITHDRAWAL",
      booklyOperationId: String(op._id),
      livemode: false,
      destinationLast4: "6789",
    });
    expect(byId.get("po_dashboard")).toMatchObject({
      origin: "NOT_VERIFIED",
      booklyOperationId: null,
      automatic: true,
      destinationLast4: null,
    });
    expect(byId.get("po_forged")).toMatchObject({
      origin: "NOT_VERIFIED",
      booklyOperationId: null,
    });
    for (const payout of overview.recentStripePayouts) {
      expect(payout).not.toHaveProperty("metadata");
      expect(payout).not.toHaveProperty("destinationId");
      expect(payout).not.toHaveProperty("failureMessage");
    }
    expect(overview.recentStripePayoutsScope).toEqual({
      shown: 3,
      returnedByStripe: 3,
      requestLimit: 100,
    });

    // The same payout id in the other mode is not a verified link.
    gateway.payouts.set(op.providerIdempotencyKey, {
      ...(gateway.payouts.get(op.providerIdempotencyKey) as ProviderPayout),
      livemode: true,
    });
    const crossMode = await service.getOverview();
    expect(crossMode.recentStripePayouts.find((p) => p.id === op.providerPayoutId)?.origin).toBe(
      "NOT_VERIFIED",
    );

    // Read-only: no operation was created or changed, no payout was requested.
    expect(await CentralPayoutOperationModel.find().lean()).toEqual(writesBefore);
    expect(gateway.createCalls).toHaveLength(1);
  });

  it("12 LIVE execution stays blocked and TEST/LIVE data never mix", async () => {
    gateway.modeValue = "LIVE";
    gateway.balance = { ...gateway.balance, livemode: true };
    await expect(submit()).rejects.toMatchObject({ statusCode: 409 });
    gateway.modeValue = "TEST"; // TEST key, LIVE data
    await expect(submit()).rejects.toMatchObject({ statusCode: 409 });
    expect(gateway.createCalls).toHaveLength(0);
    gateway.balance = { ...gateway.balance, livemode: false };
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

    // FG03B-1 — every payout webhook is durably observed; status never regresses; the Bookly one
    // is verified by its recorded payout id; the Dashboard one is observed, not turned into an op.
    const own = await StripePayoutObservationModel.findOne({ providerPayoutId: payout.id }).lean();
    expect(own).toMatchObject({
      mode: "TEST",
      linkage: "VERIFIED_BOOKLY",
      status: "failed",
      failureCode: "account_closed",
      firstObservedVia: "WEBHOOK",
      lastProviderEventId: "evt_failed",
    });
    expect(String(own?.operationId)).toBe(String(op._id));
    expect(own).not.toHaveProperty("metadata");
    expect(own).not.toHaveProperty("failureMessage");
    const other = await StripePayoutObservationModel.findOne({
      providerPayoutId: "po_other",
    }).lean();
    expect(other).toMatchObject({ linkage: "NOT_VERIFIED", status: "paid", mode: "TEST" });
    expect(other?.operationId).toBeUndefined();
    // Redelivery of an already-processed event id is a no-op; a duplicate payload under a new id
    // is idempotent (still one observation).
    await webhook.process({
      ...event("evt_other_dup", "payout.paid", "paid"),
      data: {
        object: { ...event("x", "payout.paid", "paid").data.object, id: "po_other", metadata: {} },
      },
    } as unknown as Stripe.Event);
    expect(
      await StripePayoutObservationModel.countDocuments({ providerPayoutId: "po_other" }),
    ).toBe(1);
    expect(await CentralPayoutOperationModel.countDocuments()).toBe(1);
    expect(gateway.createCalls).toHaveLength(1);
  });

  it("FG03B-1 webhook observations: unresolved linkage, forged metadata, TEST/LIVE separation", async () => {
    // A Bookly operation awaiting confirmation (lost response): metadata naming it is UNRESOLVED.
    gateway.nextCreate = "network";
    const pendingOp = await submit();
    expect(pendingOp.state).toBe("UNKNOWN");
    const named = historyPayout(1, {
      id: "po_named",
      automatic: false,
      metadata: { booklyCentralPayoutOperationId: String(pendingOp._id) },
    });
    // Different amount/destination: applyProviderPayout records a MISMATCH and does not link it.
    await service.syncFromWebhook({ ...named, amountCents: 1 }, "evt_named");
    expect(
      await StripePayoutObservationModel.findOne({ providerPayoutId: "po_named" }).lean(),
    ).toMatchObject({
      linkage: "UNRESOLVED",
    });
    // Metadata naming a non-existent operation proves nothing.
    await service.syncFromWebhook(
      historyPayout(2, {
        id: "po_forged",
        metadata: { booklyCentralPayoutOperationId: String(new Types.ObjectId()) },
      }),
      "evt_forged",
    );
    expect(
      (await StripePayoutObservationModel.findOne({ providerPayoutId: "po_forged" }).lean())
        ?.linkage,
    ).toBe("NOT_VERIFIED");
    // The same payout id reported in LIVE mode is a separate observation, never merged. FG03B-2: a
    // LIVE event reaching a TEST-keyed deployment cannot be attributed to a verified account and
    // is skipped; it is recorded only by a deployment whose key is in that mode.
    await service.syncFromWebhook(historyPayout(3, { id: "po_both" }), "evt_t");
    await service.syncFromWebhook(historyPayout(3, { id: "po_both", livemode: true }), "evt_l");
    expect(await StripePayoutObservationModel.countDocuments({ providerPayoutId: "po_both" })).toBe(
      1,
    );
    gateway.modeValue = "LIVE";
    await service.syncFromWebhook(historyPayout(3, { id: "po_both", livemode: true }), "evt_l");
    gateway.modeValue = "TEST";
    expect(await StripePayoutObservationModel.countDocuments({ providerPayoutId: "po_both" })).toBe(
      2,
    );
    expect(
      await StripePayoutObservationModel.countDocuments({ accountId: "acct_platformtest" }),
    ).toBe(4);
    // Out-of-order: a later pending event never regresses an observed paid status.
    await service.syncFromWebhook(
      historyPayout(3, { id: "po_both", status: "pending" }),
      "evt_old",
    );
    expect(
      (
        await StripePayoutObservationModel.findOne({
          providerPayoutId: "po_both",
          mode: "TEST",
        }).lean()
      )?.status,
    ).toBe("paid");
    expect(await CentralPayoutOperationModel.countDocuments()).toBe(1);
  });

  it("FG03B-1 history sync: paginated, resumable after a provider error, complete only at the last page", async () => {
    const ledgerBefore = await BookingFinancialTransactionModel.countDocuments();
    gateway.history = [1, 2, 3, 4, 5].map((n) => historyPayout(n));
    gateway.failHistoryCall = 2;

    // Page 1 observed, then Stripe fails: coverage stays IN_PROGRESS with the cursor kept.
    const first = await service.syncProviderHistory(String(admin), { maxPages: 5 });
    expect(first).toMatchObject({
      outcome: "PROVIDER_ERROR",
      state: "IN_PROGRESS",
      pagesThisCall: 1,
    });
    let coverage = await StripePayoutHistoryCoverageModel.findOne({ mode: "TEST" }).lean();
    expect(coverage).toMatchObject({
      state: "IN_PROGRESS",
      accountId: "acct_platformtest",
      lastError: "Rate limited by Stripe",
    });
    expect(coverage?.run?.cursor).toBe("po_hist_2");
    expect(coverage?.leaseId).toBeUndefined();
    let readiness = (await service.getOverview()).reconciliation;
    expect(readiness.evidenceComplete).toBe(false);
    expect(readiness.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining([
        "HISTORY_INCOMPLETE",
        "HISTORY_SYNC_FAILED",
        "UNVERIFIED_PAYOUTS_PRESENT",
      ]),
    );

    // Bounded: one page per call pauses without claiming completion.
    const paused = await service.syncProviderHistory(String(admin), { maxPages: 1 });
    expect(paused).toMatchObject({ outcome: "PAUSED_AT_PAGE_LIMIT", state: "IN_PROGRESS" });
    expect(gateway.historyCalls.at(-1)?.startingAfter).toBe("po_hist_2");

    // Resume to Stripe's last page: COMPLETE, every payout observed exactly once.
    const done = await service.syncProviderHistory(String(admin), { maxPages: 5 });
    expect(done).toMatchObject({ outcome: "COMPLETED", state: "COMPLETE" });
    expect(await StripePayoutObservationModel.countDocuments({ mode: "TEST" })).toBe(5);
    coverage = await StripePayoutHistoryCoverageModel.findOne({ mode: "TEST" }).lean();
    expect(coverage?.completeAsOf).toBeInstanceOf(Date);
    expect(coverage?.run).toBeUndefined();
    expect(coverage?.audit.map((a) => a.kind)).toEqual(
      expect.arrayContaining([
        "RUN_STARTED",
        "RUN_PROVIDER_ERROR",
        "RUN_PAUSED_AT_PAGE_LIMIT",
        "RUN_COMPLETED",
      ]),
    );
    expect(String(coverage?.audit.at(-1)?.actorUserId)).toBe(String(admin));

    // History is complete, but unverified (Dashboard/automatic) payouts still block evidence:
    // they are reported for review, never called unauthorized, never auto-assigned.
    readiness = (await service.getOverview()).reconciliation;
    expect(readiness.coverage).toMatchObject({ state: "COMPLETE", accountMatches: true });
    expect(readiness.observations).toMatchObject({ total: 5, notVerified: 5, verifiedBookly: 0 });
    expect(readiness.evidenceComplete).toBe(false);
    expect(readiness.reviewNeeded).toBe(true);
    expect(readiness.blockers.map((b) => b.code)).toEqual(["UNVERIFIED_PAYOUTS_PRESENT"]);

    // FG03B-3 — the next run is a FULL re-read (no date window, from the newest payout): older
    // payouts' statuses are re-verified, never assumed final.
    const callsBefore = gateway.historyCalls.length;
    await service.syncProviderHistory(String(admin));
    expect(gateway.historyCalls[callsBefore]).toEqual({});
    expect(gateway.historyCalls.every((c) => c.createdGte === undefined)).toBe(true);

    // No money moved: no payout created, no withdrawal operation, no ledger row.
    expect(gateway.createCalls).toHaveLength(0);
    expect(await CentralPayoutOperationModel.countDocuments()).toBe(0);
    expect(await BookingFinancialTransactionModel.countDocuments()).toBe(ledgerBefore);
  });

  it("FG03B-1 history sync is disabled by default, single-run, and resets on a different Stripe account", async () => {
    historySyncEnabled = false;
    await expect(service.syncProviderHistory(String(admin))).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(gateway.historyCalls).toHaveLength(0);
    historySyncEnabled = true;

    // A live lease blocks a parallel run without touching the checkpoint.
    await StripePayoutHistoryCoverageModel.create({
      mode: "TEST",
      state: "NEVER_RUN",
      leaseId: "other-run",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      audit: [],
    });
    await expect(service.syncProviderHistory(String(admin))).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Another payout history sync"),
    });
    expect(gateway.historyCalls).toHaveLength(0);
    // An expired lease (crashed run) is taken over.
    await StripePayoutHistoryCoverageModel.updateOne(
      { mode: "TEST" },
      { $set: { leaseExpiresAt: new Date(Date.now() - 1) } },
    );
    gateway.history = [historyPayout(1)];
    expect(await service.syncProviderHistory(String(admin))).toMatchObject({ state: "COMPLETE" });

    // A different Stripe account invalidates the earlier coverage.
    gateway.account = { ...gateway.account, accountId: "acct_otheraccount" };
    const readiness = (await service.getOverview()).reconciliation;
    expect(readiness.coverage.accountMatches).toBe(false);
    expect(readiness.blockers.map((b) => b.code)).toContain("PROVIDER_ACCOUNT_CHANGED");
    gateway.failHistoryCall = gateway.historyCalls.length + 1;
    await service.syncProviderHistory(String(admin));
    const coverage = await StripePayoutHistoryCoverageModel.findOne({ mode: "TEST" }).lean();
    expect(coverage).toMatchObject({ accountId: "acct_otheraccount", state: "IN_PROGRESS" });
    expect(coverage?.completeAsOf).toBeUndefined();
  });

  // --- FG03B-2 ---------------------------------------------------------------------------------

  const DAY = 24 * 60 * 60 * 1000;
  const daysAgo = (days: number) => new Date(Date.now() - days * DAY);
  const reviewApp = () => {
    const app = express();
    app.use("/super-admin", createCentralPayoutRouter(service));
    app.use(createErrorHandler({ isProduction: true }));
    return app;
  };
  const reviewUrl = "/super-admin/finance/withdrawals/provider-payouts";

  it("FG03B-2 account identity: observations are account-scoped, old accounts excluded, unknown identity fails closed", async () => {
    await service.syncFromWebhook(historyPayout(1, { id: "po_old_a" }), "evt_a1");
    await service.syncFromWebhook(historyPayout(2, { id: "po_old_b" }), "evt_a2");
    expect(
      await StripePayoutObservationModel.countDocuments({ accountId: "acct_platformtest" }),
    ).toBe(2);

    // The key now belongs to a different Stripe account: old evidence is kept but never counted.
    gateway.account = { ...gateway.account, accountId: "acct_newplatform" };
    await service.syncFromWebhook(historyPayout(3, { id: "po_new" }), "evt_b1");
    let readiness = (await service.getOverview()).reconciliation;
    expect(readiness.accountVerified).toBe(true);
    expect(readiness.observations).toMatchObject({ total: 1, notVerified: 1, otherAccounts: 2 });

    // A payout already recorded under the old account is never rewritten under the new one.
    await service.syncFromWebhook(
      historyPayout(1, { id: "po_old_a", status: "failed", failureCode: "account_closed" }),
      "evt_b2",
    );
    const kept = await StripePayoutObservationModel.findOne({
      providerPayoutId: "po_old_a",
    }).lean();
    expect(kept).toMatchObject({ accountId: "acct_platformtest", status: "paid" });
    expect(kept?.failureCode).toBeUndefined();

    // A history page carrying the other account's payout stops before the checkpoint moves.
    gateway.history = [historyPayout(3, { id: "po_new" }), historyPayout(1, { id: "po_old_a" })];
    gateway.historyPageSize = 1;
    const run = await service.syncProviderHistory(String(admin), { maxPages: 5 });
    expect(run).toMatchObject({ outcome: "PROVIDER_ERROR", state: "IN_PROGRESS" });
    expect(run.error).toContain("different Stripe account");
    const coverage = await StripePayoutHistoryCoverageModel.findOne({ mode: "TEST" }).lean();
    expect(coverage?.run?.cursor).toBe("po_new");

    // Review results are scoped to the current account only.
    const page = await request(reviewApp()).get(reviewUrl).expect(200);
    expect(
      page.body.data.items.map((i: { providerPayoutId: string }) => i.providerPayoutId),
    ).toEqual(["po_new"]);
    expect(page.body.data.evidence.otherAccountObservations).toBe(2);

    // Connected-account events are not platform payouts and are not recorded.
    await service.syncFromWebhook(historyPayout(4, { id: "po_connected" }), "evt_c", "acct_conn1");
    expect(
      await StripePayoutObservationModel.exists({ providerPayoutId: "po_connected" }),
    ).toBeNull();

    // Unknown account identity: the webhook throws (the event stays retryable), nothing is
    // recorded unscoped, readiness counts nothing, and the review refuses to show evidence.
    const { accountId: _dropped, ...unidentified } = gateway.account;
    gateway.account = unidentified;
    await expect(
      service.syncFromWebhook(historyPayout(5, { id: "po_unscoped" }), "evt_u"),
    ).rejects.toThrow("identity is unavailable");
    expect(
      await StripePayoutObservationModel.exists({ providerPayoutId: "po_unscoped" }),
    ).toBeNull();
    readiness = (await service.getOverview()).reconciliation;
    expect(readiness).toMatchObject({ accountVerified: false, evidenceComplete: false });
    expect(readiness.observations.total).toBe(0);
    expect(readiness.blockers.map((b) => b.code)).toContain("PROVIDER_ACCOUNT_UNVERIFIED");
    const refused = await request(reviewApp()).get(reviewUrl).expect(409);
    expect(JSON.stringify(refused.body)).toContain("CENTRAL_PAYOUT_ACCOUNT_UNIDENTIFIED");
    expect(gateway.createCalls).toHaveLength(0);
  });

  it("FG03B-3 finality: a paid payout of any age is re-verified; a late paid→failed is caught without a webhook", async () => {
    const ledgerBefore = await BookingFinancialTransactionModel.countDocuments();
    const oldPaid = historyPayout(1, {
      id: "po_old_paid",
      created: daysAgo(400),
      arrivalDate: daysAgo(398),
    });
    const inTransit = historyPayout(2, {
      id: "po_transit",
      status: "in_transit",
      created: daysAgo(5),
    });
    const failed = historyPayout(3, {
      id: "po_failed",
      status: "failed",
      failureCode: "no_account",
      created: daysAgo(30),
    });
    gateway.history = [inTransit, failed, oldPaid];
    expect(await service.syncProviderHistory(String(admin), { maxPages: 5 })).toMatchObject({
      outcome: "COMPLETED",
    });
    let readiness = (await service.getOverview()).reconciliation;
    expect(readiness.observations).toMatchObject({
      total: 3,
      inFlight: 1,
      reportedPaid: 1,
      stale: 0,
      notReconfirmed: 0,
      statusConflicts: 0,
    });
    expect(readiness.freshness.statusVerifiedAsOf).toEqual(readiness.coverage.completeAsOf);
    // Stripe's `paid` is never treated as final or bank-confirmed, whatever its age.
    expect(readiness.finality).toMatchObject({
      established: false,
      code: "BANK_SETTLEMENT_NOT_VERIFIED",
    });

    // Two days pass with no webhook. Meanwhile Stripe reports the 400-day-old paid payout as
    // failed and the in-transit one as paid (both webhooks missed).
    await StripePayoutObservationModel.updateMany({}, { $set: { lastObservedAt: daysAgo(2) } });
    await StripePayoutHistoryCoverageModel.updateOne(
      { mode: "TEST" },
      { $set: { completeAsOf: daysAgo(2) } },
    );
    readiness = (await service.getOverview()).reconciliation;
    // The ended (failed) payout is not stale; the paid and in-transit ones are.
    expect(readiness.observations.stale).toBe(2);
    expect(readiness.freshness.verificationStale).toBe(true);
    expect(readiness.evidenceComplete).toBe(false);
    expect(readiness.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(["OBSERVATIONS_STALE", "STATUS_VERIFICATION_STALE"]),
    );
    const stalePage = await request(reviewApp()).get(`${reviewUrl}?needsReview=true`).expect(200);
    const staleRow = stalePage.body.data.items.find(
      (i: { providerPayoutId: string }) => i.providerPayoutId === "po_old_paid",
    );
    expect(staleRow).toMatchObject({
      status: "paid",
      providerLifecycle: "REPORTED_PAID",
      statusVerification: "STALE",
      lastVerifiedVia: "HISTORY_SYNC",
    });
    expect(staleRow.reviewReasons).toEqual(["NOT_VERIFIED", "STALE"]);

    gateway.history = gateway.history.map((p) =>
      p.id === "po_old_paid"
        ? { ...p, status: "failed", failureCode: "account_closed" }
        : p.id === "po_transit"
          ? { ...p, status: "paid", arrivalDate: daysAgo(1) }
          : p,
    );
    const callsBefore = gateway.historyCalls.length;
    expect(await service.syncProviderHistory(String(admin), { maxPages: 5 })).toMatchObject({
      outcome: "COMPLETED",
    });
    expect(gateway.historyCalls[callsBefore]).toEqual({}); // full re-read from the newest payout
    expect(
      await StripePayoutObservationModel.findOne({ providerPayoutId: "po_old_paid" }).lean(),
    ).toMatchObject({
      status: "failed",
      failureCode: "account_closed",
      lastObservedVia: "HISTORY_SYNC",
    });
    expect(
      await StripePayoutObservationModel.findOne({ providerPayoutId: "po_transit" }).lean(),
    ).toMatchObject({ status: "paid" });

    // A delayed, out-of-order `paid` webhook for the now-failed payout never regresses it.
    await service.syncFromWebhook({ ...oldPaid, status: "paid" }, "evt_late_paid");
    expect(
      (await StripePayoutObservationModel.findOne({ providerPayoutId: "po_old_paid" }).lean())
        ?.status,
    ).toBe("failed");

    readiness = (await service.getOverview()).reconciliation;
    expect(readiness.observations).toMatchObject({ stale: 0, inFlight: 0, reportedPaid: 1 });
    expect(readiness.freshness.verificationStale).toBe(false);
    expect(readiness.blockers.map((b) => b.code)).not.toContain("STATUS_VERIFICATION_STALE");
    expect(readiness.finality.established).toBe(false);
    expect(gateway.createCalls).toHaveLength(0);
    expect(await CentralPayoutOperationModel.countDocuments()).toBe(0);
    expect(await BookingFinancialTransactionModel.countDocuments()).toBe(ledgerBefore);
  });

  it("FG03B-3 a failed payout webhook stays retryable and is recovered, never silently dropped", async () => {
    const events = new StripeWebhookEventRepository();
    const financials = new BookingFinancialTransactionService(
      new BookingFinancialTransactionRepository(),
    );
    const full = new StripeWebhookService(
      {} as PaymentGateway,
      events,
      financials,
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
    const payoutEvent = {
      id: "evt_missed_failed",
      type: "payout.failed",
      data: {
        object: {
          id: "po_missed",
          object: "payout",
          amount: 5000,
          currency: "eur",
          status: "failed",
          arrival_date: null,
          created: Math.floor(daysAgo(40).getTime() / 1000),
          destination: BANK,
          failure_code: "account_closed",
          failure_message: "closed",
          livemode: false,
          automatic: true,
          metadata: {},
        },
      },
    } as unknown as Stripe.Event;
    const due = () =>
      StripeWebhookEventModel.updateOne(
        { eventId: payoutEvent.id },
        { $set: { nextAttemptAt: new Date(Date.now() - 1) } },
      );

    // The platform account cannot be identified: the event is kept RETRYABLE, nothing recorded.
    const { accountId: _saved, ...unidentified } = gateway.account;
    const identified = gateway.account;
    gateway.account = unidentified;
    await expect(full.process(payoutEvent)).rejects.toThrow();
    expect((await events.findByEventId(payoutEvent.id))?.status).toBe("RETRYABLE");

    // A recovery processor built WITHOUT the central payout service must not mark it processed.
    gateway.account = identified;
    await due();
    const partial = new StripeWebhookService({} as PaymentGateway, events, financials);
    expect(await partial.recoverDue(5)).toMatchObject({ processed: 0, failed: 1 });
    expect((await events.findByEventId(payoutEvent.id))?.status).toBe("RETRYABLE");
    expect(await StripePayoutObservationModel.exists({ providerPayoutId: "po_missed" })).toBeNull();

    // The correctly composed recovery (as the money-recovery worker now is) applies it.
    await due();
    expect(await full.recoverDue(5)).toMatchObject({ processed: 1, failed: 0 });
    expect((await events.findByEventId(payoutEvent.id))?.status).toBe("PROCESSED");
    expect(
      await StripePayoutObservationModel.findOne({ providerPayoutId: "po_missed" }).lean(),
    ).toMatchObject({
      status: "failed",
      accountId: "acct_platformtest",
      lastProviderEventId: "evt_missed_failed",
    });
    expect(gateway.createCalls).toHaveLength(0);
  });

  it("FG03B-3 contradictory or missing provider evidence fails closed; re-verification resumes safely", async () => {
    gateway.history = [historyPayout(1, { id: "po_a" }), historyPayout(2, { id: "po_b" })];
    // A webhook recorded a payout Stripe's list will not return, and a `failed` for po_a.
    await service.syncFromWebhook(
      historyPayout(3, { id: "po_ghost", created: daysAgo(100) }),
      "evt_ghost",
    );
    await service.syncFromWebhook(
      historyPayout(1, { id: "po_a", status: "failed", failureCode: "account_closed" }),
      "evt_a_failed",
    );
    expect(await service.syncProviderHistory(String(admin), { maxPages: 5 })).toMatchObject({
      outcome: "COMPLETED",
    });
    let readiness = (await service.getOverview()).reconciliation;
    expect(readiness.observations).toMatchObject({ notReconfirmed: 1, statusConflicts: 1 });
    expect(readiness.evidenceComplete).toBe(false);
    expect(readiness.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(["PAYOUTS_NOT_RECONFIRMED", "PROVIDER_STATUS_CONFLICT"]),
    );
    // The recorded `failed` is kept (never silently regressed); the conflict is visible.
    expect(
      await StripePayoutObservationModel.findOne({ providerPayoutId: "po_a" }).lean(),
    ).toMatchObject({ status: "failed", listedStatusConflict: "paid" });
    const page = await request(reviewApp()).get(`${reviewUrl}?needsReview=true`).expect(200);
    const byId = (id: string) =>
      page.body.data.items.find((i: { providerPayoutId: string }) => i.providerPayoutId === id);
    expect(byId("po_ghost")).toMatchObject({
      statusVerification: "NOT_RECONFIRMED",
      lastListedAt: null,
    });
    expect(byId("po_a")).toMatchObject({
      statusVerification: "CONFLICT",
      listedStatusConflict: "paid",
    });
    expect(page.body.data.evidence).toMatchObject({
      coverageState: "COMPLETE",
      verificationStale: false,
    });

    // Stripe's list now agrees: the conflict clears on the next full read.
    gateway.history = gateway.history.map((p) =>
      p.id === "po_a" ? { ...p, status: "failed", failureCode: "account_closed" } : p,
    );
    await service.syncProviderHistory(String(admin), { maxPages: 5 });
    readiness = (await service.getOverview()).reconciliation;
    expect(readiness.observations.statusConflicts).toBe(0);

    // A re-verification interrupted by Stripe keeps the earlier complete read as of its time,
    // but reports the failure and blocks; resuming completes and advances the verification time.
    const previous = readiness.coverage.completeAsOf as Date;
    gateway.historyPageSize = 1;
    gateway.failHistoryCall = gateway.historyCalls.length + 2;
    const interrupted = await service.syncProviderHistory(String(admin), { maxPages: 5 });
    expect(interrupted).toMatchObject({ outcome: "PROVIDER_ERROR", state: "COMPLETE" });
    readiness = (await service.getOverview()).reconciliation;
    expect(readiness.coverage.runInProgress).toMatchObject({ pages: 1 });
    expect(readiness.blockers.map((b) => b.code)).toContain("HISTORY_SYNC_FAILED");
    expect(readiness.evidenceComplete).toBe(false);
    const resumed = await service.syncProviderHistory(String(admin), { maxPages: 5 });
    expect(resumed).toMatchObject({ outcome: "COMPLETED", state: "COMPLETE" });
    expect(gateway.historyCalls.at(-1)?.startingAfter).toBe("po_a"); // resumed at the checkpoint
    expect((resumed.completeAsOf as Date).getTime()).toBeGreaterThan(previous.getTime());
    expect(gateway.createCalls).toHaveLength(0);
  });

  it("FG03B-2/3 history coverage: concurrent runs never corrupt the checkpoint; misordered pages are refused", async () => {
    gateway.history = [1, 2, 3, 4].map((n) => historyPayout(n));
    gateway.historyPageSize = 1;
    // A competing run takes over the lease while this run is reading page 2.
    gateway.onHistoryCall = async (call) => {
      if (call === 2)
        await StripePayoutHistoryCoverageModel.updateOne(
          { mode: "TEST" },
          { $set: { leaseId: "competitor", leaseExpiresAt: new Date(Date.now() + 60_000) } },
        );
    };
    const lost = await service.syncProviderHistory(String(admin), { maxPages: 5 });
    expect(lost).toMatchObject({ outcome: "LEASE_LOST", state: "IN_PROGRESS" });
    let coverage = await StripePayoutHistoryCoverageModel.findOne({ mode: "TEST" }).lean();
    expect(coverage?.run?.cursor).toBe("po_hist_1"); // the stale run's page 2 never checkpointed
    expect(coverage?.leaseId).toBe("competitor");
    expect(coverage?.state).toBe("IN_PROGRESS");
    gateway.onHistoryCall = null;

    // Two simultaneous requests: at most one holds the lease; the result is one complete read.
    await StripePayoutHistoryCoverageModel.updateOne(
      { mode: "TEST" },
      { $unset: { leaseId: 1, leaseExpiresAt: 1 } },
    );
    const results = await Promise.allSettled([
      service.syncProviderHistory(String(admin), { maxPages: 10 }),
      service.syncProviderHistory(String(admin), { maxPages: 10 }),
    ]);
    for (const r of results)
      if (r.status === "rejected") expect(r.reason).toMatchObject({ statusCode: 409 });
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    coverage = await StripePayoutHistoryCoverageModel.findOne({ mode: "TEST" }).lean();
    expect(coverage).toMatchObject({ state: "COMPLETE" });
    expect(await StripePayoutObservationModel.countDocuments()).toBe(4);

    // A page that is not newest-first could hide skipped records: refused, never completed, and
    // the earlier complete read stays dated to its own time with the failure reported.
    const completedAt = coverage?.completeAsOf as Date;
    const newer = historyPayout(0, { id: "po_newer", created: new Date() });
    const realList = gateway.listPayoutsPage.bind(gateway);
    gateway.listPayoutsPage = async (input) => {
      const page = await realList(input);
      return { payouts: [...page.payouts, newer], hasMore: false };
    };
    const misordered = await service.syncProviderHistory(String(admin));
    expect(misordered).toMatchObject({ outcome: "PROVIDER_ERROR", state: "COMPLETE" });
    expect(misordered.error).toContain("not in newest-first order");
    coverage = await StripePayoutHistoryCoverageModel.findOne({ mode: "TEST" }).lean();
    expect(coverage?.completeAsOf).toEqual(completedAt);
    const readiness = (await service.getOverview()).reconciliation;
    expect(readiness.blockers.map((b) => b.code)).toContain("HISTORY_SYNC_FAILED");
    expect(await StripePayoutObservationModel.exists({ providerPayoutId: "po_newer" })).toBeNull();
  });

  it("FG03B-2 linkage: a payout observed while unconfirmed becomes verified when refresh confirms it", async () => {
    gateway.nextCreate = "lost";
    const op = await submit();
    expect(op.state).toBe("UNKNOWN");
    const stripePayout = gateway.payouts.get(op.providerIdempotencyKey) as ProviderPayout;
    gateway.history = [stripePayout];
    await service.syncProviderHistory(String(admin));
    expect(
      await StripePayoutObservationModel.findOne({ providerPayoutId: stripePayout.id }).lean(),
    ).toMatchObject({ linkage: "UNRESOLVED", claimedOperationId: expect.anything() });

    // Recovery (not a webhook) confirms the payout id: the observation is promoted.
    expect(await service.refresh(String(op._id))).toMatchObject({ state: "SUBMITTED" });
    const promoted = await StripePayoutObservationModel.findOne({
      providerPayoutId: stripePayout.id,
    }).lean();
    expect(promoted).toMatchObject({ linkage: "VERIFIED_BOOKLY" });
    expect(String(promoted?.operationId)).toBe(String(op._id));
    expect(promoted?.claimedOperationId).toBeUndefined();
    // A later re-read never downgrades it, and no second payout was created.
    await service.syncProviderHistory(String(admin));
    expect(
      (await StripePayoutObservationModel.findOne({ providerPayoutId: stripePayout.id }).lean())
        ?.linkage,
    ).toBe("VERIFIED_BOOKLY");
    expect(gateway.createCalls).toHaveLength(1);
    expect(await CentralPayoutOperationModel.countDocuments()).toBe(1);
  });

  it("FG03B-2 review API: filtered pagination, masked rows, explicit evidence state, no money moved", async () => {
    const ledgerBefore = await BookingFinancialTransactionModel.countDocuments();
    const verifiedOp = await submit(); // po_fake_1, verified through Stripe's own response
    const verifiedPayout = gateway.payouts.get(verifiedOp.providerIdempotencyKey) as ProviderPayout;
    gateway.history = [
      { ...verifiedPayout, created: new Date(Date.UTC(2025, 5, 1)) },
      ...[1, 2, 3, 4, 5].map((n) =>
        historyPayout(n, n === 5 ? { status: "failed", failureCode: "no_account" } : {}),
      ),
    ];
    gateway.historyPageSize = 10;
    await service.syncProviderHistory(String(admin));
    const app = reviewApp();

    const first = await request(app).get(`${reviewUrl}?linkage=NOT_VERIFIED&limit=2`).expect(200);
    expect(first.body.data).toMatchObject({
      mode: "TEST",
      modeIsCurrent: true,
      accountVerified: true,
      pagination: { page: 1, limit: 2, total: 5 },
      evidence: {
        coverageState: "COMPLETE",
        coverageAccountMatches: true,
        verificationStale: false,
      },
    });
    const ids = (body: { data: { items: { providerPayoutId: string }[] } }) =>
      body.data.items.map((i) => i.providerPayoutId);
    expect(ids(first.body)).toEqual(["po_hist_1", "po_hist_2"]); // newest first
    const third = await request(app).get(`${reviewUrl}?linkage=NOT_VERIFIED&limit=2&page=3`);
    expect(ids(third.body)).toEqual(["po_hist_5"]);

    const verified = await request(app).get(`${reviewUrl}?linkage=VERIFIED_BOOKLY`).expect(200);
    expect(verified.body.data.items).toHaveLength(1);
    expect(verified.body.data.items[0]).toMatchObject({
      providerPayoutId: verifiedPayout.id,
      booklyOperationId: String(verifiedOp._id),
      reviewReasons: [],
      destinationLast4: "6789",
    });

    const failed = await request(app).get(`${reviewUrl}?status=failed`).expect(200);
    expect(failed.body.data.items[0]).toMatchObject({
      providerPayoutId: "po_hist_5",
      failureCode: "no_account",
      providerLifecycle: "ENDED",
      statusVerification: "CURRENT",
    });
    const dated = await request(app).get(`${reviewUrl}?from=2025-06-01&to=2025-06-01`).expect(200);
    expect(ids(dated.body)).toEqual([verifiedPayout.id]);
    const review = await request(app).get(`${reviewUrl}?needsReview=true&limit=50`).expect(200);
    expect(review.body.data.pagination.total).toBe(5);
    const otherMode = await request(app).get(`${reviewUrl}?mode=LIVE`).expect(200);
    expect(otherMode.body.data).toMatchObject({ mode: "LIVE", modeIsCurrent: false, items: [] });

    // Masked, non-sensitive output only: no metadata, bank ids, account ids or provider text.
    const raw = JSON.stringify([first.body, verified.body, failed.body, review.body]);
    for (const forbidden of ["ba_", "acct_", "metadata", "failureMessage", BANK, "destinationId"])
      expect(raw).not.toContain(forbidden);

    // Reading evidence never moves money or changes operations.
    expect(gateway.createCalls).toHaveLength(1);
    expect(await CentralPayoutOperationModel.countDocuments()).toBe(1);
    expect(await BookingFinancialTransactionModel.countDocuments()).toBe(ledgerBefore);
  });
});
