import {
  type BookingCancellationTier,
  type CancellationFeeMode,
  type CancellationTier,
  NORMAL_CANCELLATION_TERMS_VERSION,
} from "../business-cancellation-policy/business-cancellation-policy.model.js";
import type {
  BookingCancellationOutcome,
  BookingCancellationPolicySnapshot,
} from "./booking.model.js";

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Pure, side-effect-free cancellation classifier (Batch 3, item 22; extended Batch 4 with real
 * settlement tracking; corrected Batch 5 with deposit netting — see below) — deliberately takes
 * the Booking's own SNAPSHOTTED policy (captured at creation time, see
 * BookingCancellationPolicySnapshot's own comment) rather than looking up the live
 * BusinessCancellationPolicy: a later policy edit must never retroactively change what an
 * already-placed Booking owes on cancellation. `now` is an explicit parameter (never
 * `new Date()` read internally) so this function is deterministic and trivially unit-testable
 * across every tier boundary.
 *
 * The 5 fixed windows are universal and NOT business-configurable (confirmed Batch 4 rule) —
 * only the FEE MODE/PERCENTAGE per window is. This function's boundaries are hardcoded for
 * exactly that reason; see business-cancellation-policy.model.ts's own cancellationTiers, which
 * already enumerate the identical fixed 5 windows this function classifies against — the two
 * were already consistent before Batch 4, confirming the existing model already encoded the
 * universal-window rule correctly (see the Batch 4 final report's audit of this).
 *
 * `cancellationFeeCents` applies against `eligiblePlatformFeeBasisCents` (services + addons −
 * discount, excluding travel fee) — the same basis this codebase already uses for the platform
 * fee calculation, reused here rather than inventing a second basis (rule #5: "based on the
 * service booking value").
 *
 * Batch 5 correction: Batch 4 shipped `refundOwedCents` always 0 here with a documented
 * assumption that the classified fee never nets against the already-collected deposit. Real
 * evidence surfaced this batch (the approved customer-facing reference screenshots plus this
 * repo's own pre-existing customer/bookings mock data — see BookingCancellationOutcome's own
 * updated doc comment for the exact numbers) shows the OPPOSITE: the fee is paid FROM the
 * already-collected deposit first, and only the shortfall is ever newly charged. This function
 * now takes `depositAlreadyPaidCents` and computes that netting directly — see
 * `depositAppliedCents`/`additionalChargeCents` on the return type for the exact formulas.
 */
export const classifyCancellationTier = (hoursUntilStart: number): CancellationTier => {
  if (hoursUntilStart >= 72) return "MORE_THAN_72_HOURS";
  if (hoursUntilStart >= 24) return "BETWEEN_24_AND_72_HOURS";
  if (hoursUntilStart >= 12) return "BETWEEN_12_AND_24_HOURS";
  if (hoursUntilStart >= 2) return "BETWEEN_2_AND_12_HOURS";
  return "UNDER_2_HOURS";
};

/** Approved v2 Normal Booking windows (business-cancellation-policy.model.ts). Same boundary
 * convention as above: exactly 24 h before the start is still "more than 24 hours". */
export const classifyNormalCancellationTier = (
  hoursUntilStart: number,
): BookingCancellationTier => {
  if (hoursUntilStart >= 24) return "MORE_THAN_24_HOURS";
  if (hoursUntilStart >= 12) return "BETWEEN_12_AND_24_HOURS";
  if (hoursUntilStart >= 2) return "BETWEEN_2_AND_12_HOURS";
  return "UNDER_2_HOURS";
};

export const buildCancellationOutcome = (input: {
  scheduledStartAt: Date;
  now: Date;
  policySnapshot: BookingCancellationPolicySnapshot | undefined;
  eligiblePlatformFeeBasisCents: number;
  /** The customer's already-collected, non-refundable deposit (== the first-booking platform
   * fee actually paid; 0 for a returning customer or a MANUAL Booking) — see
   * BookingCancellationOutcome's own doc comment for why this nets against the fee below. */
  depositAlreadyPaidCents: number;
  /** The Booking's own `cancellationTermsVersion`; absent = the five-window terms it was made under. */
  termsVersion?: typeof NORMAL_CANCELLATION_TERMS_VERSION | undefined;
}): BookingCancellationOutcome => {
  const hoursUntilStart = (input.scheduledStartAt.getTime() - input.now.getTime()) / MS_PER_HOUR;
  if (input.termsVersion === NORMAL_CANCELLATION_TERMS_VERSION) {
    const normalTier = classifyNormalCancellationTier(hoursUntilStart);
    // v2: free, and the deposit actually paid is owed back. The caller decides whether this
    // Booking kind may be refunded (e.g. Package-linked and MANUAL Bookings are not).
    if (normalTier === "MORE_THAN_24_HOURS") {
      const refundOwedCents = Math.max(0, input.depositAlreadyPaidCents);
      return {
        classifiedAt: input.now,
        tier: normalTier,
        feeMode: "FREE",
        cancellationFeeCents: 0,
        depositAppliedCents: 0,
        additionalChargeCents: 0,
        refundOwedCents,
        settlementStatus: refundOwedCents > 0 ? "PENDING" : "NOT_APPLICABLE",
      };
    }
    return withFee(input, normalTier);
  }
  return withFee(input, classifyCancellationTier(hoursUntilStart));
};

/** The fee windows shared by both term versions: the Booking's snapshotted rule, netted against
 * the deposit; the deposit itself is retained (never refunded) for a customer cancellation. */
const withFee = (
  input: Parameters<typeof buildCancellationOutcome>[0],
  tier: BookingCancellationTier,
): BookingCancellationOutcome => {
  let feeMode: CancellationFeeMode = "FREE";
  let feePercentage: number | undefined;

  if (input.policySnapshot && tier !== "MORE_THAN_24_HOURS") {
    const rule = input.policySnapshot.tiers.find(
      (entry) => entry.tier === (tier as CancellationTier),
    );
    if (rule) {
      feeMode = rule.mode;
      feePercentage = rule.percentage;
    }
  }

  const cancellationFeeCents =
    feeMode === "PERCENTAGE" && feePercentage !== undefined
      ? Math.round((input.eligiblePlatformFeeBasisCents * feePercentage) / 100)
      : 0;

  const depositAppliedCents = Math.min(cancellationFeeCents, input.depositAlreadyPaidCents);
  const additionalChargeCents = Math.max(0, cancellationFeeCents - input.depositAlreadyPaidCents);

  return {
    classifiedAt: input.now,
    tier,
    feeMode,
    ...(feePercentage !== undefined ? { feePercentage } : {}),
    cancellationFeeCents,
    depositAppliedCents,
    additionalChargeCents,
    refundOwedCents: 0,
    settlementStatus: additionalChargeCents > 0 ? "PENDING" : "NOT_APPLICABLE",
  };
};
