import { describe, expect, it, vi } from "vitest";
import {
  assertPayoutEvidenceLaunch,
  DEFAULT_PAYOUT_EVIDENCE_INTERVAL_MS,
  MAX_CALLS_PER_PASS,
  type PayoutEvidenceSyncResult,
  runPayoutEvidencePass,
} from "../../src/scripts/payout-evidence-runtime.js";

/** FG03B-3 — the optional payout-evidence refresh worker is off unless explicitly enabled. */
const base = {
  BOOKLY_PAYOUT_EVIDENCE_WORKER_ENABLED: "true",
  CENTRAL_PAYOUT_HISTORY_SYNC_ENABLED: "true",
  MONGODB_URI: "mongodb://isolated-test",
  STRIPE_SECRET_KEY: "provider-key-present",
};
const result = (over: Partial<PayoutEvidenceSyncResult>): PayoutEvidenceSyncResult => ({
  outcome: "COMPLETED",
  pagesThisCall: 1,
  observedThisCall: 100,
  error: null,
  ...over,
});

describe("payout evidence worker launch", () => {
  it("refuses to start unless both the worker and the approved history read are enabled", () => {
    expect(() => assertPayoutEvidenceLaunch({}, [])).toThrow("explicit worker enablement");
    expect(() =>
      assertPayoutEvidenceLaunch({ ...base, CENTRAL_PAYOUT_HISTORY_SYNC_ENABLED: "false" }, []),
    ).toThrow("history read to be enabled");
    expect(() => assertPayoutEvidenceLaunch({ ...base, STRIPE_SECRET_KEY: "" }, [])).toThrow(
      "database and provider configuration",
    );
    expect(() => assertPayoutEvidenceLaunch(base, ["--loop"])).toThrow("--once");
  });

  it("bounds the refresh interval and defaults inside the 24h freshness target", () => {
    expect(assertPayoutEvidenceLaunch(base, ["--once"]).intervalMs).toBe(
      DEFAULT_PAYOUT_EVIDENCE_INTERVAL_MS,
    );
    for (const bad of ["60000", String(25 * 60 * 60 * 1000), "abc"])
      expect(() =>
        assertPayoutEvidenceLaunch({ ...base, BOOKLY_PAYOUT_EVIDENCE_INTERVAL_MS: bad }, []),
      ).toThrow("between 15 minutes and 24 hours");
  });
});

describe("payout evidence pass", () => {
  it("continues across paused calls until Stripe's last page, within a bounded call budget", async () => {
    const sync = vi
      .fn<() => Promise<PayoutEvidenceSyncResult>>()
      .mockResolvedValueOnce(result({ outcome: "PAUSED_AT_PAGE_LIMIT", pagesThisCall: 10 }))
      .mockResolvedValueOnce(result({ pagesThisCall: 3 }));
    expect(await runPayoutEvidencePass(sync)).toMatchObject({
      result: "COMPLETED",
      calls: 2,
      pages: 13,
    });

    const endless = vi.fn(async () =>
      result({ outcome: "PAUSED_AT_PAGE_LIMIT", pagesThisCall: 10 }),
    );
    expect(await runPayoutEvidencePass(endless)).toMatchObject({
      result: "INCOMPLETE",
      calls: MAX_CALLS_PER_PASS,
    });
    expect(endless).toHaveBeenCalledTimes(MAX_CALLS_PER_PASS);
  });

  it("never reports a provider error, lost lease or exception as success", async () => {
    expect(
      await runPayoutEvidencePass(async () =>
        result({ outcome: "PROVIDER_ERROR", error: "Rate limited by Stripe" }),
      ),
    ).toMatchObject({ result: "INCOMPLETE", error: "Rate limited by Stripe" });
    expect(
      await runPayoutEvidencePass(async () => result({ outcome: "LEASE_LOST" })),
    ).toMatchObject({ result: "INCOMPLETE" });
    expect(
      await runPayoutEvidencePass(async () => {
        throw new Error("socket hang up");
      }),
    ).toMatchObject({ result: "FAILED", error: "socket hang up" });
    // An operator read already holding the lease is left alone.
    expect(
      await runPayoutEvidencePass(async () => {
        throw Object.assign(new Error("busy"), {
          details: [{ code: "CENTRAL_PAYOUT_HISTORY_SYNC_IN_PROGRESS" }],
        });
      }),
    ).toMatchObject({ result: "SKIPPED_RUN_IN_PROGRESS", calls: 0 });
  });
});
