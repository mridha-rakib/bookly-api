import { isValidIBAN } from "ibantools";

import { PayoutDestinationError } from "./payout-destination.errors.js";

/**
 * IBAN normalization + validation. `ibantools` (a narrowly-scoped, well-maintained package added
 * as a dependency for exactly this) owns the mod-97 checksum and the per-country length/structure
 * table — none of that is hand-rolled here, because a hand-rolled checksum that is subtly wrong
 * fails OPEN (it accepts a typo'd account number and money goes to the wrong place).
 *
 * Normalization happens BEFORE validation and before encryption, so the stored ciphertext is
 * always of the canonical electronic form. The user's original spacing/casing is never persisted
 * in any form, and `ibanLast4`/`ibanCountry` are derived from this same canonical string so the
 * mask can never disagree with what was encrypted.
 */

/** Trim, strip ALL whitespace (including the pretty-print groups banks print), uppercase. */
export const normalizeIban = (raw: string): string => raw.replace(/\s+/g, "").trim().toUpperCase();

export type ValidatedIban = {
  /** The canonical electronic-format IBAN — the ONLY value that is ever encrypted. */
  normalized: string;
  country: string;
  last4: string;
};

/**
 * Normalizes and validates, or throws `PAYOUT_DESTINATION_IBAN_INVALID` (400). Returns the
 * derived `country`/`last4` alongside, so no caller ever re-derives them from a different string.
 */
export const requireValidIban = (raw: string): ValidatedIban => {
  const normalized = normalizeIban(raw);

  // Cheap structural gate first: `isValidIBAN` is strict, but this keeps a clearly-malformed
  // input from depending on library internals, and guarantees the slices below are safe.
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(normalized)) {
    throw new PayoutDestinationError("PAYOUT_DESTINATION_IBAN_INVALID", 400);
  }

  // Checksum + country-specific length/structure (mod-97), from ibantools.
  if (!isValidIBAN(normalized)) {
    throw new PayoutDestinationError("PAYOUT_DESTINATION_IBAN_INVALID", 400);
  }

  return {
    normalized,
    country: normalized.slice(0, 2),
    last4: normalized.slice(-4),
  };
};
