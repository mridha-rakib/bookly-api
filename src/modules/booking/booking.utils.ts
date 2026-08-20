import { randomInt } from "node:crypto";

// No 0/O/1/I — matches the visual-ambiguity avoidance used by staff.utils.ts's temp-password
// charset, since a Booking reference is read aloud/typed by humans (front desk, customer support).
const REFERENCE_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const REFERENCE_SUFFIX_LENGTH = 8;

const pick = (charset: string): string => charset[randomInt(0, charset.length)] as string;

/**
 * Cryptographically random, collision-safe Booking display reference, e.g. "BK-7F3K9QZC".
 * Never derived from Math.random(), a counter, or any Booking field — the 32-symbol alphabet
 * over 8 characters is ~1.1×10^12 possibilities, and the repository/service layer still treats
 * this as probabilistic and retries on a genuine unique-index collision (see
 * BookingService's reference-generation retry loop), matching this codebase's established
 * "unique index + duplicate-key catch" concurrency convention rather than assuming
 * uniqueness by construction alone.
 */
export const generateBookingReference = (): string => {
  const suffix = Array.from({ length: REFERENCE_SUFFIX_LENGTH }, () => pick(REFERENCE_CHARS)).join(
    "",
  );
  return `BK-${suffix}`;
};
