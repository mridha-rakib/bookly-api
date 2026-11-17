import type { WithdrawalEligibility } from "../../src/modules/central-payout/withdrawal-eligibility.js";

/**
 * CW-1 — a fixed eligibility decision for DB-less central-payout unit tests (the real calculation
 * is covered against a database in central-payout-database.integration.test.ts).
 */
export const ELIGIBILITY_DIGEST = "a".repeat(64);

export const fixedEligibility = (
  status: "AVAILABLE" | "UNAVAILABLE",
  eligibleCents = 1_000_000,
): WithdrawalEligibility => ({
  policyVersion: "CW-1",
  mode: "TEST",
  evaluatedAt: new Date(),
  blockers: [],
  currencies: [
    {
      currency: "eur",
      status,
      eligibleCents: status === "AVAILABLE" ? eligibleCents : 0,
      stripeAvailableCents: eligibleCents,
      ledgerHeldCents: eligibleCents,
      protected: {
        refundsInProgressCents: 0,
        refundableBookingsCents: 0,
        refundablePackagesCents: 0,
        disputesCents: 0,
        totalCents: 0,
      },
      ledger: {
        stripeChargedCents: eligibleCents,
        stripeOutflowsCents: 0,
        stripePayoutsOutCents: 0,
        booklyNetRevenueCents: eligibleCents,
        businessOwnedNetCents: 0,
        businessSettledCents: 0,
        businessOutstandingCents: null,
        taxLiabilityCents: 0,
      },
      blockers:
        status === "AVAILABLE"
          ? []
          : [
              {
                code: "HISTORY_NEVER_SYNCED",
                message: "Stripe payout history has never been fully read",
              },
            ],
      digest: ELIGIBILITY_DIGEST,
    },
  ],
});
