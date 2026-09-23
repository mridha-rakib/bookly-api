import { describe, expect, it } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  parseAes256KeyHex,
} from "../../src/common/crypto/aes-256-gcm-secret.js";

// Obviously-fake, test-only key material. Never a real key.
const KEY_A = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const KEY_B = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

// Synthetic, valid-checksum test IBANs only — these are the published example IBANs, not
// anybody's real bank account.
const IBAN = "CY17002001280000001200527600";

const BUSINESS_A = "652f1a2b3c4d5e6f70819200";
const BUSINESS_B = "652f1a2b3c4d5e6f70819201";

const flipLastHexChar = (hex: string): string => {
  const last = hex.slice(-1);
  return `${hex.slice(0, -1)}${last === "0" ? "1" : "0"}`;
};

describe("common/crypto/aes-256-gcm-secret", () => {
  it("round-trips a secret through encrypt/decrypt", () => {
    const payload = encryptSecret(IBAN, KEY_A);
    expect(decryptSecret(payload, KEY_A)).toBe(IBAN);
  });

  it("round-trips with AAD when the same AAD is supplied", () => {
    const payload = encryptSecret(IBAN, KEY_A, BUSINESS_A);
    expect(decryptSecret(payload, KEY_A, BUSINESS_A)).toBe(IBAN);
  });

  it("produces a different ciphertext for the same plaintext each time (random IV)", () => {
    const first = encryptSecret(IBAN, KEY_A, BUSINESS_A);
    const second = encryptSecret(IBAN, KEY_A, BUSINESS_A);

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    // Both still decrypt to the same plaintext.
    expect(decryptSecret(first, KEY_A, BUSINESS_A)).toBe(IBAN);
    expect(decryptSecret(second, KEY_A, BUSINESS_A)).toBe(IBAN);
  });

  it("never stores the plaintext in the serialized structure", () => {
    const payload = encryptSecret(IBAN, KEY_A, BUSINESS_A);
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain(IBAN);
    expect(serialized).not.toContain("0527600");
    expect(Object.keys(payload).sort()).toEqual(["authTag", "ciphertext", "iv"]);
  });

  it("rejects a tampered ciphertext", () => {
    const payload = encryptSecret(IBAN, KEY_A, BUSINESS_A);
    const tampered = { ...payload, ciphertext: flipLastHexChar(payload.ciphertext) };

    expect(() => decryptSecret(tampered, KEY_A, BUSINESS_A)).toThrow();
  });

  it("rejects a tampered auth tag", () => {
    const payload = encryptSecret(IBAN, KEY_A, BUSINESS_A);
    const tampered = { ...payload, authTag: flipLastHexChar(payload.authTag) };

    expect(() => decryptSecret(tampered, KEY_A, BUSINESS_A)).toThrow();
  });

  it("rejects a tampered IV", () => {
    const payload = encryptSecret(IBAN, KEY_A, BUSINESS_A);
    const tampered = { ...payload, iv: flipLastHexChar(payload.iv) };

    expect(() => decryptSecret(tampered, KEY_A, BUSINESS_A)).toThrow();
  });

  it("rejects the wrong key", () => {
    const payload = encryptSecret(IBAN, KEY_A, BUSINESS_A);

    expect(() => decryptSecret(payload, KEY_B, BUSINESS_A)).toThrow();
  });

  it("rejects the wrong AAD — a ciphertext copied to another Business cannot be decrypted", () => {
    const payload = encryptSecret(IBAN, KEY_A, BUSINESS_A);

    expect(() => decryptSecret(payload, KEY_A, BUSINESS_B)).toThrow();
    // ...and also fails when the AAD is simply omitted.
    expect(() => decryptSecret(payload, KEY_A)).toThrow();
  });

  it("rejects a payload missing ciphertext/iv/authTag", () => {
    const payload = encryptSecret(IBAN, KEY_A);

    expect(() => decryptSecret({ ...payload, ciphertext: "" }, KEY_A)).toThrow(/missing/i);
    expect(() => decryptSecret({ ...payload, iv: "" }, KEY_A)).toThrow(/missing/i);
    expect(() => decryptSecret({ ...payload, authTag: "" }, KEY_A)).toThrow(/missing/i);
  });

  it("rejects a key that is not 64 hex characters", () => {
    expect(() => parseAes256KeyHex("abc")).toThrow(/64-character hex/i);
    expect(() => parseAes256KeyHex("z".repeat(64))).toThrow(/64-character hex/i);
    expect(() => encryptSecret(IBAN, "short")).toThrow(/64-character hex/i);
    expect(parseAes256KeyHex(KEY_A)).toHaveLength(32);
  });
});

describe("payout-destination.crypto (key versioning + businessId AAD)", () => {
  it("stamps the current key version and round-trips via that stored version", async () => {
    const { CURRENT_PAYOUT_KEY_VERSION, decryptIban, encryptIban } = await import(
      "../../src/modules/payout-destination/payout-destination.crypto.js"
    );

    const encrypted = encryptIban(IBAN, BUSINESS_A);

    expect(encrypted.keyVersion).toBe(CURRENT_PAYOUT_KEY_VERSION);
    expect(JSON.stringify(encrypted)).not.toContain(IBAN);
    expect(decryptIban(encrypted, BUSINESS_A)).toBe(IBAN);
  });

  it("fails closed on an unknown key version rather than treating it as unconfigured", async () => {
    const { decryptIban, encryptIban } = await import(
      "../../src/modules/payout-destination/payout-destination.crypto.js"
    );
    const { PayoutDestinationError } = await import(
      "../../src/modules/payout-destination/payout-destination.errors.js"
    );

    const encrypted = encryptIban(IBAN, BUSINESS_A);

    expect(() => decryptIban({ ...encrypted, keyVersion: 99 }, BUSINESS_A)).toThrow(
      PayoutDestinationError,
    );
    expect(() => decryptIban({ ...encrypted, keyVersion: 99 }, BUSINESS_A)).toThrow(
      /could not be read/i,
    );
  });

  it("fails closed (one generic 500-class error) on tamper and on a wrong-Business AAD", async () => {
    const { decryptIban, encryptIban } = await import(
      "../../src/modules/payout-destination/payout-destination.crypto.js"
    );

    const encrypted = encryptIban(IBAN, BUSINESS_A);

    const wrongBusiness = (() => {
      try {
        decryptIban(encrypted, BUSINESS_B);
        return null;
      } catch (error) {
        return error as { statusCode: number; message: string };
      }
    })();
    const tampered = (() => {
      try {
        decryptIban(
          { ...encrypted, ciphertext: flipLastHexChar(encrypted.ciphertext) },
          BUSINESS_A,
        );
        return null;
      } catch (error) {
        return error as { statusCode: number; message: string };
      }
    })();

    expect(wrongBusiness?.statusCode).toBe(500);
    expect(tampered?.statusCode).toBe(500);
    // Indistinguishable to a caller — no oracle for which failure mode occurred.
    expect(wrongBusiness?.message).toBe(tampered?.message);
    // Never a partial/malformed IBAN.
    expect(wrongBusiness?.message).not.toContain("CY");
  });
});
