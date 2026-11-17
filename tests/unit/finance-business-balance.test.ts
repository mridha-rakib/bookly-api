import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";
import { toBusinessFinanceBalanceDto } from "../../src/modules/finance/finance.dto.js";
import { FinanceService } from "../../src/modules/finance/finance.service.js";

/**
 * Finance Gap 01 — the Owner's all-time balance: earned (canonical ledger ownership), recorded
 * as paid (payout attestations) and outstanding (the same unclaimed net a payout would settle).
 */

type Row = {
  type: string;
  amountCents: number;
  sourceType?: string;
  payoutId?: Types.ObjectId;
};

const ownerId = new Types.ObjectId();
const business = {
  _id: new Types.ObjectId(),
  ownerUserId: ownerId,
  name: "Salon",
  address: { city: "Limassol" },
  category: "Hair",
};

/** Builds a service over an in-memory SUCCEEDED ledger and payout set. The aggregate and the
 * unclaimed read are derived from the same rows, exactly as the repository queries them. */
const build = (rows: Row[], payouts: Array<{ netPayoutCents: number; paidAt: Date }>) => {
  const buckets = new Map<
    string,
    { type: string; sourceType: string | null; totalCents: number; count: number }
  >();
  for (const row of rows) {
    const key = `${row.type}|${row.sourceType ?? ""}`;
    const bucket = buckets.get(key) ?? {
      type: row.type,
      sourceType: row.sourceType ?? null,
      totalCents: 0,
      count: 0,
    };
    bucket.totalCents += row.amountCents;
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  const aggregateAllTimeOwnedBySource = vi.fn(async () => [...buckets.values()]);
  const findUnclaimedForPayout = vi.fn(async () =>
    rows
      .filter((row) => !row.payoutId)
      .map((row) => ({
        _id: new Types.ObjectId(),
        type: row.type,
        amountCents: row.amountCents,
        metadata: row.sourceType ? { sourceType: row.sourceType } : {},
      })),
  );
  const sumPaidForBusiness = vi.fn(async () => ({
    totalCents: payouts.reduce((sum, p) => sum + p.netPayoutCents, 0),
    count: payouts.length,
    lastPaidAt: payouts.at(-1)?.paidAt,
  }));
  const service = new FinanceService(
    { findById: async () => business } as never,
    { aggregateAllTimeOwnedBySource, findUnclaimedForPayout } as never,
    {} as never,
    { sumPaidForBusiness } as never,
  );
  return { service, aggregateAllTimeOwnedBySource, sumPaidForBusiness };
};

describe("Finance Gap 01 — Business Owner balance", () => {
  it("earned = recorded as paid + outstanding, counting deposits and excluding Bookly/unknown rows", async () => {
    const payoutId = new Types.ObjectId();
    const rows: Row[] = [
      // Settled by an earlier payout: 5000 + 1500 − 200 = 6300.
      { type: "DEPOSIT", amountCents: 5000, payoutId },
      { type: "NO_SHOW_FEE", amountCents: 1500, payoutId },
      { type: "PROCESSING_FEE", amountCents: 200, sourceType: "DEPOSIT", payoutId },
      // Still unclaimed: 3000 + 800 + 400 − 3000 − 100 = 1100.
      { type: "DEPOSIT", amountCents: 3000 },
      { type: "CANCELLATION_FEE", amountCents: 800 },
      { type: "PROMO_SUBSIDY", amountCents: 400 },
      { type: "REFUND", amountCents: 3000, sourceType: "DEPOSIT" },
      { type: "PROCESSING_FEE", amountCents: 100, sourceType: "CANCELLATION_FEE" },
      // Never the Business's: Bookly's processing fee and an unattributed (UNKNOWN) refund.
      { type: "PROCESSING_FEE", amountCents: 90, sourceType: "PLATFORM_FEE" },
      { type: "REFUND", amountCents: 700 },
    ];
    const paidAt = new Date("2026-11-01T10:00:00Z");
    const { service, aggregateAllTimeOwnedBySource } = build(rows, [
      { netPayoutCents: 6300, paidAt },
    ]);

    const balance = await service.getBusinessBalance(String(ownerId), String(business._id));

    expect(aggregateAllTimeOwnedBySource).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: business._id }),
    );
    expect(balance.earned).toEqual({
      grossCents: 10_700,
      depositCents: 8000,
      feeRecoveryCents: 2300,
      promoSubsidyCents: 400,
      processingFeesCents: 300,
      refundsCents: 3000,
      disputeAdjustmentsCents: 0,
      netCents: 7400,
    });
    expect(balance.recordedPaid).toEqual({
      amountCents: 6300,
      payoutCount: 1,
      lastRecordedAt: paidAt,
    });
    expect(balance.outstanding).toEqual({
      netCents: 1100,
      payableCents: 1100,
      transactionCount: 7,
    });
    expect(balance.reconciled).toBe(true);
    expect(balance.reconciliationDifferenceCents).toBe(0);
    expect(toBusinessFinanceBalanceDto(balance).recordedPaid.lastRecordedAt).toBe(
      "2026-11-01T10:00:00.000Z",
    );
  });

  it("a deduction larger than unclaimed earnings is carried forward, never shown as owed", async () => {
    const payoutId = new Types.ObjectId();
    const { service } = build(
      [
        { type: "DEPOSIT", amountCents: 4000, payoutId },
        { type: "REFUND", amountCents: 4000, sourceType: "DEPOSIT" },
        { type: "DISPUTE_FEE", amountCents: 1500, sourceType: "DEPOSIT" },
      ],
      [{ netPayoutCents: 4000, paidAt: new Date() }],
    );
    const balance = await service.getBusinessBalance(String(ownerId), String(business._id));
    expect(balance.outstanding).toMatchObject({ netCents: -5500, payableCents: 0 });
    expect(balance.earned.netCents).toBe(-1500);
    expect(balance.reconciled).toBe(true);
  });

  it("reports a recorded-paid total that does not match the ledger instead of hiding it", async () => {
    const { service } = build(
      [{ type: "DEPOSIT", amountCents: 1000 }],
      [{ netPayoutCents: 250, paidAt: new Date() }],
    );
    const balance = await service.getBusinessBalance(String(ownerId), String(business._id));
    expect(balance.reconciled).toBe(false);
    expect(balance.reconciliationDifferenceCents).toBe(-250);
  });

  it("is Owner-only: another user gets the same 404 as every Finance read, with no ledger read", async () => {
    const { service, aggregateAllTimeOwnedBySource, sumPaidForBusiness } = build([], []);
    await expect(
      service.getBusinessBalance(String(new Types.ObjectId()), String(business._id)),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(aggregateAllTimeOwnedBySource).not.toHaveBeenCalled();
    expect(sumPaidForBusiness).not.toHaveBeenCalled();
  });
});
