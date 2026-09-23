import {
  decryptSecret,
  type EncryptedSecret,
  encryptSecret,
} from "../../common/crypto/aes-256-gcm-secret.js";
import { env } from "../../config/env.js";
import { PayoutDestinationError } from "./payout-destination.errors.js";

/**
 * Payout-IBAN encryption: the generic AES-256-GCM primitive plus this module's two policies —
 * key VERSIONING and `businessId`-as-AAD.
 *
 * This file deliberately does NOT import `modules/integration/integration.crypto.ts`. That helper
 * is hard-wired to the Google Calendar env key and throws Google-Calendar-specific error codes
 * (a missing payout key would report "Google Calendar is not configured"), and it has no AAD or
 * key-version support. The Google Calendar module is left completely untouched.
 */

/** The write key is ALWAYS the newest version; older versions exist only so old rows still read. */
export const CURRENT_PAYOUT_KEY_VERSION = 1;

/**
 * version → key material. Only version 1 exists today. A rotation adds
 * `2: env.PAYOUT_DESTINATION_ENCRYPTION_KEY_V2` here and bumps
 * {@link CURRENT_PAYOUT_KEY_VERSION}; rows written under version 1 keep decrypting untouched.
 */
const keysByVersion: Record<number, string | undefined> = {
  1: env.PAYOUT_DESTINATION_ENCRYPTION_KEY_V1,
};

/**
 * Fail CLOSED on every key problem. An unknown version, or a known version whose env key is not
 * configured, throws — it is never silently treated as "no destination configured", which would
 * turn a misconfigured deploy into a silent data-loss/"please re-enter your IBAN" prompt.
 */
const requireKey = (version: number, whenMissing: "READ" | "WRITE"): string => {
  const key = keysByVersion[version];

  if (!key) {
    throw new PayoutDestinationError(
      whenMissing === "WRITE"
        ? "PAYOUT_DESTINATION_ENCRYPTION_NOT_CONFIGURED"
        : "PAYOUT_DESTINATION_DECRYPT_FAILED",
      500,
    );
  }

  return key;
};

/** `businessId` as GCM additional authenticated data: a ciphertext copied from one Business's
 * record onto another's fails its auth-tag check rather than decrypting to a valid IBAN. */
const aadFor = (businessId: { toString(): string }): string => businessId.toString();

export type EncryptedIban = EncryptedSecret & { keyVersion: number };

export const encryptIban = (
  normalizedIban: string,
  businessId: { toString(): string },
): EncryptedIban => {
  const version = CURRENT_PAYOUT_KEY_VERSION;
  const encrypted = encryptSecret(normalizedIban, requireKey(version, "WRITE"), aadFor(businessId));

  return { ...encrypted, keyVersion: version };
};

/**
 * The ONLY decrypt path. Every failure mode — unknown/unconfigured key version, tampered
 * ciphertext, tampered auth tag, wrong-Business AAD — collapses into one 500-class
 * `PAYOUT_DESTINATION_DECRYPT_FAILED`. There is no partial result: GCM authenticates the whole
 * message or throws, so a malformed IBAN can never be returned.
 */
export const decryptIban = (stored: EncryptedIban, businessId: { toString(): string }): string => {
  const key = requireKey(stored.keyVersion, "READ");

  try {
    return decryptSecret(stored, key, aadFor(businessId));
  } catch {
    // Never re-thrown with the cause attached: the underlying node:crypto message distinguishes
    // the failure modes, which is exactly what an attacker probing a tampered row wants.
    throw new PayoutDestinationError("PAYOUT_DESTINATION_DECRYPT_FAILED", 500);
  }
};

/** Whether the write key is configured at all — used only to fail fast with a clear error. */
export const isPayoutDestinationEncryptionConfigured = (): boolean =>
  Boolean(keysByVersion[CURRENT_PAYOUT_KEY_VERSION]);
