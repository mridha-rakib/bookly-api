import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv: { GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: string | undefined } = {
  GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: "a".repeat(64),
};

vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));

describe("integration.crypto (AES-256-GCM token-at-rest encryption)", () => {
  beforeEach(() => {
    mockEnv.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY = "a".repeat(64);
  });

  it("round-trips a secret through encrypt/decrypt", async () => {
    const { encryptSecret, decryptSecret } = await import(
      "../../src/modules/integration/integration.crypto.js"
    );

    const ciphertext = encryptSecret("ya29.super-secret-google-access-token");

    expect(ciphertext).not.toContain("super-secret");
    expect(decryptSecret(ciphertext)).toBe("ya29.super-secret-google-access-token");
  });

  it("produces a different ciphertext for the same plaintext each time (random IV)", async () => {
    const { encryptSecret } = await import("../../src/modules/integration/integration.crypto.js");

    expect(encryptSecret("same-value")).not.toBe(encryptSecret("same-value"));
  });

  it("rejects a tampered ciphertext (auth tag mismatch)", async () => {
    const { encryptSecret, decryptSecret } = await import(
      "../../src/modules/integration/integration.crypto.js"
    );

    const [iv, authTag, ciphertext] = encryptSecret("token").split(":");
    const lastChar = ciphertext?.slice(-1) ?? "0";
    const flippedChar = lastChar === "0" ? "1" : "0";
    const tampered = `${iv}:${authTag}:${(ciphertext ?? "").slice(0, -1)}${flippedChar}`;

    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("throws GOOGLE_CALENDAR_NOT_CONFIGURED when no encryption key is configured", async () => {
    mockEnv.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY = undefined;
    const { encryptSecret } = await import("../../src/modules/integration/integration.crypto.js");

    expect(() => encryptSecret("token")).toThrow(/not configured/i);
  });
});
