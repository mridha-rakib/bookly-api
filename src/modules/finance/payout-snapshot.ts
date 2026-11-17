import { createHash } from "node:crypto";

/**
 * Finance Gap 02 — binds a recorded manual bank transfer to the exact eligible set the Super
 * Admin reviewed. The digest covers every Business-owned, unclaimed ledger entry a payout would
 * claim (id, type, amount), so ANY change between viewing the payable and confirming the
 * transfer (a new deposit/fee, a refund, a dispute movement, a concurrent payout) yields a
 * different digest, even when the net amount happens to be unchanged.
 *
 * Deliberately NOT a reservation or lock: it adds no lifecycle state. A changed snapshot simply
 * refuses the record; the Super Admin re-reads the payable and decides again.
 */
const DOMAIN = "bookly-business-payout-snapshot-v1";

export const computePayoutSnapshotDigest = (
  entries: ReadonlyArray<{ _id: { toString(): string }; type: string; amountCents: number }>,
): string => {
  const lines = entries
    .map((entry) => `${entry._id.toString()}:${entry.type}:${entry.amountCents}`)
    .sort();
  return createHash("sha256")
    .update([DOMAIN, ...lines].join("\n"))
    .digest("hex");
};
