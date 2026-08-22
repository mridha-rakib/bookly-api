import { describe, expect, it } from "vitest";

import {
  buildCancellationOutcome,
  classifyCancellationTier,
} from "../../src/modules/booking/booking-cancellation-classification.js";

describe("classifyCancellationTier", () => {
  it("classifies each documented boundary correctly", () => {
    expect(classifyCancellationTier(200)).toBe("MORE_THAN_72_HOURS");
    expect(classifyCancellationTier(72)).toBe("MORE_THAN_72_HOURS");
    expect(classifyCancellationTier(71.9)).toBe("BETWEEN_24_AND_72_HOURS");
    expect(classifyCancellationTier(24)).toBe("BETWEEN_24_AND_72_HOURS");
    expect(classifyCancellationTier(23.9)).toBe("BETWEEN_12_AND_24_HOURS");
    expect(classifyCancellationTier(12)).toBe("BETWEEN_12_AND_24_HOURS");
    expect(classifyCancellationTier(11.9)).toBe("BETWEEN_2_AND_12_HOURS");
    expect(classifyCancellationTier(2)).toBe("BETWEEN_2_AND_12_HOURS");
    expect(classifyCancellationTier(1.9)).toBe("UNDER_2_HOURS");
    expect(classifyCancellationTier(0)).toBe("UNDER_2_HOURS");
    expect(classifyCancellationTier(-5)).toBe("UNDER_2_HOURS");
  });
});

describe("buildCancellationOutcome", () => {
  const now = new Date("2026-08-25T00:00:00.000Z");

  it("classifies FREE with zero fee when no policy was snapshotted (missing configuration convention)", () => {
    const outcome = buildCancellationOutcome({
      scheduledStartAt: new Date("2026-08-25T00:30:00.000Z"), // 30 min out
      now,
      policySnapshot: undefined,
      eligiblePlatformFeeBasisCents: 10_000,
      depositAlreadyPaidCents: 0,
    });

    expect(outcome.feeMode).toBe("FREE");
    expect(outcome.cancellationFeeCents).toBe(0);
    expect(outcome.refundOwedCents).toBe(0);
    expect(outcome.settlementStatus).toBe("NOT_APPLICABLE");
  });

  it("computes a PERCENTAGE fee against eligiblePlatformFeeBasisCents (never including travel fee) and marks settlement PENDING", () => {
    const outcome = buildCancellationOutcome({
      scheduledStartAt: new Date("2026-08-25T01:00:00.000Z"), // 1h out -> UNDER_2_HOURS
      now,
      policySnapshot: {
        tiers: [
          { tier: "MORE_THAN_72_HOURS", mode: "FREE" },
          { tier: "BETWEEN_24_AND_72_HOURS", mode: "FREE" },
          { tier: "BETWEEN_12_AND_24_HOURS", mode: "FREE" },
          { tier: "BETWEEN_2_AND_12_HOURS", mode: "FREE" },
          { tier: "UNDER_2_HOURS", mode: "PERCENTAGE", percentage: 50 },
        ],
        noShowPercentage: 100,
      },
      eligiblePlatformFeeBasisCents: 10_000,
      depositAlreadyPaidCents: 0,
    });

    expect(outcome.tier).toBe("UNDER_2_HOURS");
    expect(outcome.feeMode).toBe("PERCENTAGE");
    expect(outcome.feePercentage).toBe(50);
    expect(outcome.cancellationFeeCents).toBe(5000);
    expect(outcome.depositAppliedCents).toBe(0);
    expect(outcome.additionalChargeCents).toBe(5000);
    expect(outcome.settlementStatus).toBe("PENDING");
  });

  it("is deterministic and pure — never reads Date.now() internally", () => {
    const a = buildCancellationOutcome({
      scheduledStartAt: new Date("2026-08-25T10:00:00.000Z"),
      now: new Date("2026-08-20T10:00:00.000Z"),
      policySnapshot: undefined,
      eligiblePlatformFeeBasisCents: 1000,
      depositAlreadyPaidCents: 0,
    });
    const b = buildCancellationOutcome({
      scheduledStartAt: new Date("2026-08-25T10:00:00.000Z"),
      now: new Date("2026-08-20T10:00:00.000Z"),
      policySnapshot: undefined,
      eligiblePlatformFeeBasisCents: 1000,
      depositAlreadyPaidCents: 0,
    });
    expect(a.tier).toBe(b.tier);
    expect(a.classifiedAt).toEqual(b.classifiedAt);
  });

  it("nets the fee against the already-collected deposit — only the shortfall is an additional charge, never the gross fee on top", () => {
    const policySnapshot = {
      tiers: [
        { tier: "MORE_THAN_72_HOURS" as const, mode: "FREE" as const },
        { tier: "BETWEEN_24_AND_72_HOURS" as const, mode: "FREE" as const },
        { tier: "BETWEEN_12_AND_24_HOURS" as const, mode: "FREE" as const },
        { tier: "BETWEEN_2_AND_12_HOURS" as const, mode: "FREE" as const },
        { tier: "UNDER_2_HOURS" as const, mode: "PERCENTAGE" as const, percentage: 50 },
      ],
      noShowPercentage: 100,
    };

    // €80 basis, 50% fee = €40 (matches the reference no-show mock's own numbers). A €16
    // deposit already collected covers part of it — only the €24 shortfall is a new charge.
    const partiallyCovered = buildCancellationOutcome({
      scheduledStartAt: new Date("2026-08-25T00:30:00.000Z"),
      now,
      policySnapshot,
      eligiblePlatformFeeBasisCents: 8000,
      depositAlreadyPaidCents: 1600,
    });
    expect(partiallyCovered.cancellationFeeCents).toBe(4000);
    expect(partiallyCovered.depositAppliedCents).toBe(1600);
    expect(partiallyCovered.additionalChargeCents).toBe(2400);
    expect(partiallyCovered.refundOwedCents).toBe(0);
    expect(partiallyCovered.settlementStatus).toBe("PENDING");

    // A deposit that fully covers (or exceeds) the fee — nothing left to newly charge, and the
    // excess deposit is still never refunded to the customer on a customer-initiated action.
    const fullyCovered = buildCancellationOutcome({
      scheduledStartAt: new Date("2026-08-25T00:30:00.000Z"),
      now,
      policySnapshot,
      eligiblePlatformFeeBasisCents: 8000,
      depositAlreadyPaidCents: 5000,
    });
    expect(fullyCovered.cancellationFeeCents).toBe(4000);
    expect(fullyCovered.depositAppliedCents).toBe(4000);
    expect(fullyCovered.additionalChargeCents).toBe(0);
    expect(fullyCovered.refundOwedCents).toBe(0);
    expect(fullyCovered.settlementStatus).toBe("NOT_APPLICABLE");
  });

  it("never mutates its inputs", () => {
    const policySnapshot = {
      tiers: [{ tier: "MORE_THAN_72_HOURS" as const, mode: "FREE" as const }],
      noShowPercentage: 100,
    };
    const before = JSON.stringify(policySnapshot);
    buildCancellationOutcome({
      scheduledStartAt: new Date("2026-08-30T00:00:00.000Z"),
      now,
      policySnapshot,
      eligiblePlatformFeeBasisCents: 1000,
      depositAlreadyPaidCents: 0,
    });
    expect(JSON.stringify(policySnapshot)).toBe(before);
  });
});
