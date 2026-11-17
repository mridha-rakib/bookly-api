import { Types } from "mongoose";
import { describe, expect, it } from "vitest";
import { executePayoutBodySchema } from "../../src/modules/finance/finance.schema.js";
import { computePayoutSnapshotDigest } from "../../src/modules/finance/payout-snapshot.js";

/** Finance Gap 02 — the manual-transfer record is bound to the reviewed amount and entry set. */
describe("payout snapshot digest", () => {
  const a = { _id: new Types.ObjectId(), type: "DEPOSIT", amountCents: 1600 };
  const b = { _id: new Types.ObjectId(), type: "PROCESSING_FEE", amountCents: 55 };

  it("is order-independent and changes with any entry id, type or amount", () => {
    const base = computePayoutSnapshotDigest([a, b]);
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    expect(computePayoutSnapshotDigest([b, a])).toBe(base);
    expect(computePayoutSnapshotDigest([a])).not.toBe(base);
    expect(computePayoutSnapshotDigest([a, { ...b, amountCents: 56 }])).not.toBe(base);
    expect(computePayoutSnapshotDigest([a, { ...b, type: "REFUND" }])).not.toBe(base);
    expect(computePayoutSnapshotDigest([a, { ...b, _id: new Types.ObjectId() }])).not.toBe(base);
  });

  it("the record request requires the confirmed amount and snapshot; the reference stays optional", () => {
    const snapshotDigest = computePayoutSnapshotDigest([a]);
    expect(executePayoutBodySchema.safeParse({}).success).toBe(false);
    expect(executePayoutBodySchema.safeParse({ providerReference: "REF" }).success).toBe(false);
    expect(executePayoutBodySchema.safeParse({ expectedNetCents: 1600 }).success).toBe(false);
    expect(executePayoutBodySchema.safeParse({ expectedNetCents: 0, snapshotDigest }).success).toBe(
      false,
    );
    expect(
      executePayoutBodySchema.safeParse({ expectedNetCents: 16.5, snapshotDigest }).success,
    ).toBe(false);
    expect(
      executePayoutBodySchema.safeParse({ expectedNetCents: 1600, snapshotDigest: "x" }).success,
    ).toBe(false);
    expect(executePayoutBodySchema.parse({ expectedNetCents: 1600, snapshotDigest })).toEqual({
      expectedNetCents: 1600,
      snapshotDigest,
    });
    expect(
      executePayoutBodySchema.parse({
        expectedNetCents: 1600,
        snapshotDigest,
        providerReference: " BANK-1 ",
      }),
    ).toMatchObject({ providerReference: "BANK-1" });
  });
});
