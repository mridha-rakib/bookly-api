import { readFileSync } from "node:fs";
import { DateTime, Settings } from "luxon";
import { Types } from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planPackageBatchMaterialization } from "../../src/modules/booking/package-batch-materialization.js";
import { hashPackageCheckoutQuote } from "../../src/modules/booking/package-checkout-binding.js";
import { packageCheckoutRetentionSchema } from "../../src/modules/booking/package-checkout-retention.js";
import {
  calculatePackageExpiryV1,
  minimumGregorianValidityDays,
} from "../../src/modules/booking/package-checkout-validity.js";

// Captured before production edits. These are synthetic old-implementation records, not consent.
const golden: {
  cases: {
    name: string;
    date: string;
    months: 6 | 12;
    zone: string;
    ok: boolean;
    iso?: string;
    local?: string;
  }[];
  records: { mode: string; input: unknown; hash: string; proof: unknown; plan?: unknown }[];
  invalidProofs: { mode: string; change: string; accepted: boolean }[];
} = JSON.parse(
  readFileSync(new URL("../fixtures/package-finite-pre-fix-golden.json", import.meta.url), "utf8"),
);
const revive = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["$oid"] === "string") return new Types.ObjectId(record["$oid"]);
    if (typeof record["$date"] === "string") return new Date(record["$date"]);
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, revive(child)]));
  }
  return value;
};
const retained = (record: (typeof golden.records)[number]) => {
  const input = revive(record.input) as { retention: unknown };
  return packageCheckoutRetentionSchema.parse(input.retention);
};
const originalLuxonNow = Settings.now;
afterEach(() => {
  vi.restoreAllMocks();
  Settings.now = originalLuxonNow;
});
describe("pre-fix canonical temporal compatibility", () => {
  it.each(golden.cases)("old accepted/rejected outcome: $name", (row) => {
    const work = () => calculatePackageExpiryV1(new Date(row.date), row.months, row.zone);
    if (!row.ok) expect(work).toThrow();
    else {
      const expiry = work();
      expect(expiry.toISOString()).toBe(row.iso);
      expect(DateTime.fromJSDate(expiry, { zone: row.zone }).toISO()).toBe(row.local);
    }
  });
  it.each(golden.records)("original immutable $mode envelope, proof and hash", (record) => {
    const retention = retained(record);
    expect(hashPackageCheckoutQuote(retention.quote.payload)).toBe(record.hash);
    expect(retention.quote.payload.validity).toEqual(revive(record.proof));
    expect(retention).toEqual((revive(record.input) as { retention: unknown }).retention);
  });
  it.each(golden.records)("original $mode retained evidence plans without rewriting", (record) => {
    const input = revive(record.input);
    const before = JSON.stringify(input);
    const plan = planPackageBatchMaterialization(input);
    expect(plan.identity.termsHash).toBe(record.hash);
    expect(plan.retainedTerms.validityDisclosure).toEqual(
      JSON.parse(JSON.stringify(revive(record.proof))),
    );
    if (record.mode === "FOREVER") expect(plan).toEqual(record.plan);
    expect(JSON.stringify(input)).toBe(before);
    expect(planPackageBatchMaterialization(input)).toEqual(plan);
  });
  it.each(golden.invalidProofs)("old rejected $mode $change remains rejected", (row) => {
    const record = golden.records.find((record) => record.mode === row.mode);
    if (!record) throw new Error("Golden record missing");
    const retention = retained(record);
    const validity = retention.quote.payload.validity;
    if (validity.mode !== "FINITE") throw new Error("Expected FINITE");
    let changed: unknown;
    switch (row.change) {
      case "missing-proof":
        changed = { ...validity, guaranteeProofRef: undefined };
        break;
      case "estimate":
        changed = {
          ...validity,
          estimatedExpiresAt: new Date(validity.estimatedExpiresAt.getTime() + 1),
        };
        break;
      case "months":
        changed = { ...validity, months: 7 };
        break;
      case "window":
        changed = { ...validity, activationNotAfterExclusive: validity.activationNotBefore };
        break;
      case "hash":
        changed = validity;
        break;
      default:
        throw new Error("Unknown original rejection");
    }
    const invalidRetention = {
      ...retention,
      quote: {
        ...retention.quote,
        termsHash: row.change === "hash" ? "0".repeat(64) : retention.quote.termsHash,
        payload: { ...retention.quote.payload, validity: changed },
      },
    };
    expect(packageCheckoutRetentionSchema.safeParse(invalidRetention).success).toBe(row.accepted);
    expect(() =>
      planPackageBatchMaterialization({
        ...(revive(record.input) as { claim: unknown }),
        retention: invalidRetention,
      }),
    ).toThrow();
  });
  it.each([false, true])(
    "no Date.now or actual imported ESM Settings.now; cache reset %s",
    (reset) => {
      const inputs = golden.records.map(retained);
      if (reset) Settings.resetCaches();
      const fail = () => {
        throw new Error("Ambient clock attempted");
      };
      const clock = vi.spyOn(Date, "now").mockImplementation(fail);
      const luxonClock = vi.fn(fail);
      Settings.now = luxonClock;
      for (const input of inputs) {
        expect(packageCheckoutRetentionSchema.parse(input)).toEqual(input);
        expect(hashPackageCheckoutQuote(input.quote.payload)).toBe(input.quote.termsHash);
      }
      expect(minimumGregorianValidityDays(6)).toBe(181);
      expect(minimumGregorianValidityDays(12)).toBe(365);
      expect(clock).not.toHaveBeenCalled();
      expect(luxonClock).not.toHaveBeenCalled();
    },
  );
});
