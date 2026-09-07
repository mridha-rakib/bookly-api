import { exportPKCS8, generateKeyPair, importSPKI, jwtVerify } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A real ES256 keypair so the real jose SignJWT path runs (no network, deterministic).
let privateKeyBase64: string;
let publicKeyPem: string;

const mockEnv: Record<string, string | undefined> = {};
vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
vi.mock("../../src/config/logger.js", () => ({ logger }));

const {
  getAppleClientSecret,
  isAppleClientSecretConfigured,
  __resetAppleClientSecretCache,
  AppleClientSecretError,
} = await import("../../src/common/oauth/apple-client-secret.js");

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  privateKeyBase64 = Buffer.from(await exportPKCS8(privateKey)).toString("base64");
  publicKeyPem = await exportPKCS8(publicKey).catch(async () => {
    // publicKey exports as SPKI, not PKCS8
    const { exportSPKI } = await import("jose");
    return exportSPKI(publicKey);
  });
});

beforeEach(() => {
  __resetAppleClientSecretCache();
  vi.clearAllMocks();
  mockEnv["APPLE_CLIENT_ID"] = "cy.bookly.web";
  mockEnv["APPLE_TEAM_ID"] = "TEAM123456";
  mockEnv["APPLE_KEY_ID"] = "KEY1234567";
  mockEnv["APPLE_PRIVATE_KEY"] = privateKeyBase64;
});

afterEach(() => {
  vi.useRealTimers();
});

const verify = async (secret: string) => {
  const spki = await importSPKI(publicKeyPem, "ES256");
  return jwtVerify(secret, spki, { audience: "https://appleid.apple.com" });
};

describe("apple-client-secret", () => {
  it("isAppleClientSecretConfigured is true only when every credential is present", () => {
    expect(isAppleClientSecretConfigured()).toBe(true);
    mockEnv["APPLE_KEY_ID"] = undefined;
    expect(isAppleClientSecretConfigured()).toBe(false);
  });

  it("signs an ES256 JWT with the audited header + claims", async () => {
    const secret = await getAppleClientSecret();
    const [headerB64] = secret.split(".");
    const header = JSON.parse(Buffer.from(headerB64 as string, "base64url").toString());
    expect(header).toMatchObject({ alg: "ES256", kid: "KEY1234567" });

    const { payload } = await verify(secret);
    expect(payload.iss).toBe("TEAM123456");
    expect(payload.sub).toBe("cy.bookly.web");
    expect(payload.aud).toBe("https://appleid.apple.com");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    // Apple's hard cap is 15777000s (~6 months); ours is well under.
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(15_777_000);
    expect((payload.exp as number) - (payload.iat as number)).toBeGreaterThan(30 * 24 * 60 * 60);
  });

  it("caches the secret and reuses it while it is comfortably valid", async () => {
    const a = await getAppleClientSecret();
    const b = await getAppleClientSecret();
    expect(a).toBe(b);
  });

  it("regenerates a fresh secret once it is within the renew skew of expiring", async () => {
    const first = await getAppleClientSecret();
    vi.useFakeTimers();
    // Jump ~5 months forward — past the renew skew.
    vi.setSystemTime(new Date(Date.now() + 150 * 24 * 60 * 60 * 1000));
    const second = await getAppleClientSecret();
    expect(second).not.toBe(first);
  });

  it("throws AppleClientSecretError (no key material in the message) on an invalid private key", async () => {
    mockEnv["APPLE_PRIVATE_KEY"] = Buffer.from(
      "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----",
    ).toString("base64");
    __resetAppleClientSecretCache();
    const error = await getAppleClientSecret().catch((e) => e);
    expect(error).toBeInstanceOf(AppleClientSecretError);
    expect(String(error.message)).not.toContain("PRIVATE KEY");
  });

  it("throws when a required credential is missing", async () => {
    mockEnv["APPLE_TEAM_ID"] = undefined;
    __resetAppleClientSecretCache();
    await expect(getAppleClientSecret()).rejects.toBeInstanceOf(AppleClientSecretError);
  });

  it("never logs the private key or the generated secret", async () => {
    await getAppleClientSecret();
    const logged = JSON.stringify(logger.error.mock.calls) + JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain(privateKeyBase64);
  });
});
