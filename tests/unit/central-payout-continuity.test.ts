import type { Request, Response } from "express";
import { Types } from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireRoles } from "../../src/modules/auth/auth.middleware.js";
import { CentralPayoutService } from "../../src/modules/central-payout/central-payout.service.js";
import type {
  CentralPayoutGateway,
  ProviderPayout,
} from "../../src/modules/central-payout/central-payout.types.js";
import {
  type CentralPayoutOperationDocument,
  CentralPayoutOperationModel,
} from "../../src/modules/central-payout/central-payout-operation.model.js";

// FG03B-1/2 — webhook payouts are also recorded as non-monetary observations (covered against a real
// database in central-payout-database.integration.test.ts). These DB-less unit tests stub that
// write so they keep asserting only the withdrawal-operation behaviour.
const observed = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("../../src/modules/central-payout/payout-reconciliation.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/modules/central-payout/payout-reconciliation.js")
  >()),
  observeWebhookPayout: async (...args: unknown[]) => {
    observed.calls.push(args);
    return "OBSERVED";
  },
  // FG03B-2 — linkage promotion after a confirmed payout id is a DB write; stubbed here too.
  promoteObservationLinkage: async () => {},
}));

afterEach(() => {
  vi.restoreAllMocks();
  observed.calls.length = 0;
});

function fixture(mode: "TEST" | "LIVE" = "TEST") {
  const op = {
    _id: new Types.ObjectId(),
    mode,
    state: "UNKNOWN",
    amountCents: 1000,
    currency: "eur",
    destinationId: "ba_central",
    providerIdempotencyKey: "original-key",
    createdAt: new Date(),
    dispatchCount: 1,
    audit: [],
  } as unknown as CentralPayoutOperationDocument;
  const payout: ProviderPayout = {
    id: "po_original",
    amountCents: 1000,
    currency: "eur",
    destinationId: "ba_central",
    status: "pending",
    livemode: mode === "LIVE",
    automatic: false,
    arrivalDate: null,
    created: new Date(),
    failureCode: null,
    failureMessage: null,
    metadata: { booklyCentralPayoutOperationId: String(op._id) },
  };
  vi.spyOn(CentralPayoutOperationModel, "findById").mockReturnValue({
    lean: () => ({ exec: async () => op }),
  } as never);
  vi.spyOn(CentralPayoutOperationModel, "findOne").mockReturnValue({
    lean: () => ({ exec: async () => op }),
  } as never);
  const updates = vi.spyOn(CentralPayoutOperationModel, "findOneAndUpdate").mockImplementation(
    (_filter, change) =>
      ({
        lean: () => ({
          exec: async () => {
            const delta = change as { $set?: object; $push?: { audit: unknown } };
            Object.assign(op, delta.$set);
            if (delta.$push?.audit) op.audit.push(delta.$push.audit as never);
            return op;
          },
        }),
      }) as never,
  );
  vi.spyOn(CentralPayoutOperationModel, "updateOne").mockReturnValue({
    exec: async () => ({ modifiedCount: 1 }),
  } as never);
  const create = vi.fn(async () => payout);
  const list = vi.fn(async () => [payout]);
  const service = new CentralPayoutService({
    gateway: {
      mode: () => mode,
      createPayout: create,
      listRecentPayouts: list,
      retrievePayout: async () => payout,
    } as unknown as CentralPayoutGateway,
    policy: { liveExecutionEnabled: mode === "LIVE" },
    verifyStepUp: vi.fn(),
  });
  return { op, payout, updates, create, list, service };
}

describe("Central withdrawal continuity", () => {
  it.each(["invalid", "future"])("does not resend when operation age is %s", async (kind) => {
    const f = fixture();
    f.op.createdAt = new Date(kind === "invalid" ? Number.NaN : Date.now() + 60_000);
    f.list.mockResolvedValue([]);
    await f.service.refresh(String(f.op._id));
    expect(f.list).toHaveBeenCalledExactlyOnceWith({ limit: 100 });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.op.state).toBe("UNKNOWN");
    expect(f.op.audit.at(-1)?.kind).toBe("REQUIRES_REVIEW");
  });

  it("requires review rather than resending when the clock cannot establish operation age", async () => {
    const f = fixture();
    f.list.mockResolvedValue([]);
    vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    await f.service.refresh(String(f.op._id));
    expect(f.create).not.toHaveBeenCalled();
    expect(f.op.state).toBe("UNKNOWN");
    expect(f.op.audit.at(-1)?.kind).toBe("REQUIRES_REVIEW");
  });

  it("still reconciles matching provider evidence when local operation age is invalid", async () => {
    const f = fixture();
    f.op.createdAt = new Date(Number.NaN);
    expect((await f.service.refresh(String(f.op._id))).providerPayoutId).toBe("po_original");
    expect(f.create).not.toHaveBeenCalled();
  });

  it("refreshes a provider-failed operation without dispatching another payout", async () => {
    const f = fixture();
    f.op.state = "SUBMITTED";
    f.op.providerStatus = "failed";
    f.op.providerPayoutId = f.payout.id;
    f.payout.status = "failed";
    await f.service.refresh(String(f.op._id));
    await f.service.refresh(String(f.op._id));
    expect(f.op.providerStatus).toBe("failed");
    expect(f.create).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
  });

  it("reconciles existing LIVE evidence while new execution remains denied", async () => {
    const f = fixture("LIVE");
    expect((await f.service.refresh(String(f.op._id))).providerPayoutId).toBe("po_original");
    expect(f.create).not.toHaveBeenCalled();
  });

  it("never resends an uncertain LIVE payout while reserve authority is denied", async () => {
    const f = fixture("LIVE");
    f.list.mockResolvedValue([]);
    await f.service.refresh(String(f.op._id));
    expect(f.create).not.toHaveBeenCalled();
    expect(f.op.state).toBe("UNKNOWN");
    expect(f.op.audit.at(-1)?.kind).toBe("BLOCKED");
  });

  it("accepts provider-confirmed paid-to-failed transitions without another payout", async () => {
    const f = fixture();
    f.op.state = "SUBMITTED";
    f.op.providerStatus = "paid";
    f.op.providerPayoutId = f.payout.id;
    f.payout.status = "failed";
    await f.service.syncFromWebhook(f.payout, "evt_failed");
    expect(f.op.providerStatus).toBe("failed");
    expect(f.create).not.toHaveBeenCalled();
  });
  it("recovers the original payout after a lost response without sending another", async () => {
    const f = fixture();
    expect((await f.service.refresh(String(f.op._id))).providerPayoutId).toBe("po_original");
    expect(f.create).not.toHaveBeenCalled();
  });

  it("retries only with the original Stripe idempotency key and destination", async () => {
    const f = fixture();
    f.list.mockResolvedValue([]);
    await f.service.refresh(String(f.op._id));
    expect(f.create).toHaveBeenCalledExactlyOnceWith({
      amountCents: 1000,
      currency: "eur",
      destinationId: "ba_central",
      idempotencyKey: "original-key",
      metadata: f.payout.metadata,
    });
  });

  it.each(["destination", "automatic"])(
    "rejects a mismatched %s payout without marking it submitted",
    async (kind) => {
      const f = fixture();
      if (kind === "destination") f.payout.destinationId = "ba_unrelated";
      else f.payout.automatic = true;
      await f.service.syncFromWebhook(f.payout, "evt_payout");
      expect(f.op.state).toBe("UNKNOWN");
      expect(f.op.audit.at(-1)?.kind).toBe("MISMATCH");
      expect(f.op.providerPayoutId).toBeUndefined();
    },
  );

  it("ignores an older pending webhook after a paid payout", async () => {
    const f = fixture();
    f.op.state = "SUBMITTED";
    f.op.providerStatus = "paid";
    f.op.providerPayoutId = "po_original";
    await f.service.syncFromWebhook(f.payout, "evt_old");
    expect(f.op.providerStatus).toBe("paid");
    expect(f.updates).not.toHaveBeenCalled();
  });

  it("preserves a paid webhook when a concurrent pending write wins first", async () => {
    const f = fixture();
    f.payout.status = "paid";
    f.updates.mockImplementationOnce(
      () =>
        ({
          lean: () => ({
            exec: async () => {
              f.op.state = "SUBMITTED";
              f.op.providerStatus = "pending";
              f.op.providerPayoutId = "po_original";
              return null;
            },
          }),
        }) as never,
    );
    await f.service.syncFromWebhook(f.payout, "evt_paid");
    expect(f.op.providerStatus).toBe("paid");
    expect(f.updates).toHaveBeenCalledTimes(2);
    expect(f.create).not.toHaveBeenCalled();
  });

  it.each(["BUSINESS_OWNER", "CUSTOMER", "SUPER_ADMIN"] as const)(
    "preserves the Super Admin gate for %s",
    (role) => {
      const next = vi.fn();
      requireRoles(["SUPER_ADMIN"])({ auth: { role } } as Request, {} as Response, next);
      if (role === "SUPER_ADMIN") expect(next).toHaveBeenCalledExactlyOnceWith();
      else expect(next.mock.calls[0]?.[0]).toMatchObject({ statusCode: 403 });
    },
  );
});
