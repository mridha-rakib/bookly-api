import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Generic, dependency-free AES-256-GCM secret-at-rest primitive.
 *
 * Deliberately a NEW module rather than a reuse of `modules/integration/integration.crypto.ts`:
 * that file hard-codes Google-Calendar-specific failure codes
 * (`GOOGLE_CALENDAR_NOT_CONFIGURED` / `GOOGLE_CALENDAR_OAUTH_FAILED`) and reads one specific env
 * var, so a payout caller reusing it would surface "Google Calendar is not configured" when an
 * IBAN key is missing. The algorithm/IV/auth-tag mechanics here are intentionally identical to
 * that file's; only the error behaviour is inverted — this primitive throws plain `Error`s and
 * lets the caller map them onto its own domain errors.
 *
 * Differences from the Google Calendar helper, both required by the payout use case:
 *  - the key is PASSED IN (callers own key resolution, including key versioning), never read
 *    from `env` here;
 *  - optional AAD (additional authenticated data) is supported. Payout callers bind a ciphertext
 *    to its owning `businessId`, so a ciphertext copied onto another Business's record fails the
 *    GCM auth-tag check instead of decrypting cleanly.
 *
 * The output is a structured `{ ciphertext, iv, authTag }` triple (hex) rather than the joined
 * `iv:authTag:ciphertext` string, because the payout record stores the three parts in separate
 * schema fields (all `select: false`).
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** The at-rest shape: three hex strings, and never the plaintext. */
export type EncryptedSecret = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

/**
 * Parses a 64-hex-char (32-byte) key string into a Buffer. Throws a plain `Error` on anything
 * that is not exactly a 32-byte hex key — callers decide what domain error that maps to.
 */
export const parseAes256KeyHex = (keyHex: string): Buffer => {
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
    throw new Error("AES-256-GCM key must be a 64-character hex string (32 bytes)");
  }

  const key = Buffer.from(keyHex, "hex");

  if (key.length !== KEY_BYTES) {
    throw new Error("AES-256-GCM key must decode to exactly 32 bytes");
  }

  return key;
};

const toKey = (key: Buffer | string): Buffer =>
  typeof key === "string" ? parseAes256KeyHex(key) : key;

/**
 * AES-256-GCM encrypt with a fresh random 12-byte IV. Encrypting the same plaintext twice
 * therefore always produces a different ciphertext.
 *
 * `aad`, when given, is authenticated but NOT encrypted: decryption only succeeds when the exact
 * same `aad` is supplied again.
 */
export const encryptSecret = (
  plaintext: string,
  key: Buffer | string,
  aad?: string,
): EncryptedSecret => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, toKey(key), iv);

  if (aad !== undefined) {
    cipher.setAAD(Buffer.from(aad, "utf8"));
  }

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return {
    ciphertext: ciphertext.toString("hex"),
    iv: iv.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
  };
};

/**
 * AES-256-GCM decrypt. Throws a plain `Error` on a tampered ciphertext, a tampered auth tag, a
 * wrong key, or a wrong/missing `aad` — GCM makes all four indistinguishable by design, which is
 * exactly the fail-closed behaviour the payout reveal path wants. There is no partial-plaintext
 * path: `decipher.final()` either authenticates the whole message or throws.
 */
export const decryptSecret = (
  payload: EncryptedSecret,
  key: Buffer | string,
  aad?: string,
): string => {
  if (!payload.ciphertext || !payload.iv || !payload.authTag) {
    throw new Error("Encrypted payload is missing ciphertext/iv/authTag");
  }

  const decipher = createDecipheriv(ALGORITHM, toKey(key), Buffer.from(payload.iv, "hex"));

  if (aad !== undefined) {
    decipher.setAAD(Buffer.from(aad, "utf8"));
  }

  decipher.setAuthTag(Buffer.from(payload.authTag, "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "hex")),
    decipher.final(),
  ]).toString("utf8");
};
