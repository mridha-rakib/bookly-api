import { type CryptoKey, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Real ES256 keypair; the resolver's jwtVerify runs for real against the test public key.
let signingKey: CryptoKey;
let verifyKey: CryptoKey;
let otherSigningKey: CryptoKey;

// createRemoteJWKSet returns a "getKey" function — we substitute one that always yields our test
// public key. getAppleClientSecret is stubbed (its own test covers signing). fetch is stubbed for
// the token endpoint.
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet: () => async () => verifyKey,
  };
});
vi.mock("../../src/common/oauth/apple-client-secret.js", () => ({
  getAppleClientSecret: vi.fn(async () => "test-apple-client-secret"),
  isAppleClientSecretConfigured: () => true,
}));

const {
  buildAppleAuthUrl,
  resolveAppleIdentity,
  splitAppleName,
  parseAppleUserJson,
  AppleIdentityError,
  APPLE_OAUTH_SCOPES,
} = await import("../../src/common/oauth/apple-identity.js");

const CONFIG = {
  clientId: "cy.bookly.web",
  redirectUri: "https://bookly.cy/api/v1/auth/oauth/apple/callback",
};
const NONCE = "nonce-abc-123";

beforeAll(async () => {
  ({ privateKey: signingKey, publicKey: verifyKey } = await generateKeyPair("ES256"));
  ({ privateKey: otherSigningKey } = await generateKeyPair("ES256"));
});

const makeIdToken = async (
  claims: Record<string, unknown>,
  opts: { key?: CryptoKey; iss?: string; aud?: string; expired?: boolean } = {},
) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(opts.iss ?? "https://appleid.apple.com")
    .setAudience(opts.aud ?? CONFIG.clientId)
    .setIssuedAt()
    .setExpirationTime(opts.expired ? "-1h" : "1h")
    .sign(opts.key ?? signingKey);

const mockTokenEndpoint = (idToken: string | null, ok = true) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      json: async () =>
        idToken === null ? {} : { id_token: idToken, refresh_token: "r", access_token: "a" },
    })),
  );
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("common/oauth/apple-identity", () => {
  describe("buildAppleAuthUrl", () => {
    it("uses form_post, code+id_token, name+email scope, and passes state + nonce", () => {
      const url = new URL(buildAppleAuthUrl(CONFIG, "signed-state", NONCE));
      expect(url.origin + url.pathname).toBe("https://appleid.apple.com/auth/authorize");
      expect(url.searchParams.get("client_id")).toBe(CONFIG.clientId);
      expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
      expect(url.searchParams.get("response_type")).toBe("code id_token");
      expect(url.searchParams.get("response_mode")).toBe("form_post");
      expect(url.searchParams.get("scope")).toBe("name email");
      expect(url.searchParams.get("state")).toBe("signed-state");
      expect(url.searchParams.get("nonce")).toBe(NONCE);
      expect([...APPLE_OAUTH_SCOPES]).toEqual(["name", "email"]);
    });
  });

  describe("resolveAppleIdentity", () => {
    it("returns { sub, email, emailVerified } from a valid exchange", async () => {
      const idToken = await makeIdToken({
        sub: "apple-sub-1",
        nonce: NONCE,
        email: "pat@example.com",
        email_verified: "true",
        is_private_email: "false",
      });
      mockTokenEndpoint(idToken);

      const identity = await resolveAppleIdentity(CONFIG, { code: "auth-code", nonce: NONCE });
      expect(identity).toEqual({
        providerAccountId: "apple-sub-1",
        email: "pat@example.com",
        emailVerified: true,
        isPrivateEmail: false,
      });
    });

    it("parses a private relay email + is_private_email true", async () => {
      const idToken = await makeIdToken({
        sub: "apple-sub-2",
        nonce: NONCE,
        email: "abc123@privaterelay.appleid.com",
        email_verified: true,
        is_private_email: true,
      });
      mockTokenEndpoint(idToken);
      const identity = await resolveAppleIdentity(CONFIG, { code: "c", nonce: NONCE });
      expect(identity.email).toBe("abc123@privaterelay.appleid.com");
      expect(identity.emailVerified).toBe(true);
      expect(identity.isPrivateEmail).toBe(true);
    });

    it("returns emailVerified:false and no email key when Apple returns no email", async () => {
      mockTokenEndpoint(await makeIdToken({ sub: "apple-sub-3", nonce: NONCE }));
      const identity = await resolveAppleIdentity(CONFIG, { code: "c", nonce: NONCE });
      expect(identity).toEqual({ providerAccountId: "apple-sub-3", emailVerified: false });
      expect(identity).not.toHaveProperty("email");
    });

    it("email present but unverified → emailVerified:false (caller rejects signup)", async () => {
      mockTokenEndpoint(
        await makeIdToken({ sub: "s", nonce: NONCE, email: "x@y.com", email_verified: "false" }),
      );
      const identity = await resolveAppleIdentity(CONFIG, { code: "c", nonce: NONCE });
      expect(identity.email).toBe("x@y.com");
      expect(identity.emailVerified).toBe(false);
    });

    it("rejects a nonce that doesn't match the signed state", async () => {
      mockTokenEndpoint(await makeIdToken({ sub: "s", nonce: "some-other-nonce" }));
      await expect(
        resolveAppleIdentity(CONFIG, { code: "c", nonce: NONCE }),
      ).rejects.toBeInstanceOf(AppleIdentityError);
    });

    it("rejects a wrong issuer", async () => {
      mockTokenEndpoint(
        await makeIdToken({ sub: "s", nonce: NONCE }, { iss: "https://evil.example" }),
      );
      await expect(
        resolveAppleIdentity(CONFIG, { code: "c", nonce: NONCE }),
      ).rejects.toBeInstanceOf(AppleIdentityError);
    });

    it("rejects a wrong audience", async () => {
      mockTokenEndpoint(await makeIdToken({ sub: "s", nonce: NONCE }, { aud: "someone.else" }));
      await expect(
        resolveAppleIdentity(CONFIG, { code: "c", nonce: NONCE }),
      ).rejects.toBeInstanceOf(AppleIdentityError);
    });

    it("rejects an invalid signature (token signed by a different key)", async () => {
      mockTokenEndpoint(await makeIdToken({ sub: "s", nonce: NONCE }, { key: otherSigningKey }));
      await expect(
        resolveAppleIdentity(CONFIG, { code: "c", nonce: NONCE }),
      ).rejects.toBeInstanceOf(AppleIdentityError);
    });

    it("rejects an expired token", async () => {
      mockTokenEndpoint(await makeIdToken({ sub: "s", nonce: NONCE }, { expired: true }));
      await expect(
        resolveAppleIdentity(CONFIG, { code: "c", nonce: NONCE }),
      ).rejects.toBeInstanceOf(AppleIdentityError);
    });

    it("rejects a token with no sub", async () => {
      mockTokenEndpoint(await makeIdToken({ nonce: NONCE }));
      await expect(
        resolveAppleIdentity(CONFIG, { code: "c", nonce: NONCE }),
      ).rejects.toBeInstanceOf(AppleIdentityError);
    });

    it("rejects when the token endpoint returns an error", async () => {
      mockTokenEndpoint(null, false);
      await expect(
        resolveAppleIdentity(CONFIG, { code: "bad", nonce: NONCE }),
      ).rejects.toBeInstanceOf(AppleIdentityError);
    });

    it("rejects when the token endpoint returns no id_token", async () => {
      mockTokenEndpoint(null, true);
      await expect(
        resolveAppleIdentity(CONFIG, { code: "c", nonce: NONCE }),
      ).rejects.toBeInstanceOf(AppleIdentityError);
    });

    it("rejects when the callback id_token sub disagrees with the exchanged id_token sub", async () => {
      const exchanged = await makeIdToken({ sub: "sub-A", nonce: NONCE });
      const callback = await makeIdToken({ sub: "sub-B", nonce: NONCE });
      mockTokenEndpoint(exchanged);
      await expect(
        resolveAppleIdentity(CONFIG, { code: "c", idToken: callback, nonce: NONCE }),
      ).rejects.toBeInstanceOf(AppleIdentityError);
    });

    it("accepts when callback + exchanged id_tokens agree on sub", async () => {
      const t = await makeIdToken({
        sub: "sub-same",
        nonce: NONCE,
        email: "e@e.com",
        email_verified: true,
      });
      mockTokenEndpoint(t);
      const identity = await resolveAppleIdentity(CONFIG, { code: "c", idToken: t, nonce: NONCE });
      expect(identity.providerAccountId).toBe("sub-same");
    });

    it("never returns access/refresh/id tokens in the identity", async () => {
      mockTokenEndpoint(
        await makeIdToken({ sub: "s", nonce: NONCE, email: "e@e.com", email_verified: true }),
      );
      const identity = await resolveAppleIdentity(CONFIG, { code: "c", nonce: NONCE });
      const json = JSON.stringify(identity);
      expect(json).not.toContain("refresh_token");
      expect(json).not.toContain("id_token");
      expect(json).not.toMatch(/eyJ/); // no JWT
    });
  });

  describe("parseAppleUserJson", () => {
    it("extracts firstName/lastName from the first-auth user blob", () => {
      expect(parseAppleUserJson('{"name":{"firstName":"Ada","lastName":"Lovelace"}}')).toEqual({
        firstName: "Ada",
        lastName: "Lovelace",
      });
    });
    it("returns {} for absent or malformed input", () => {
      expect(parseAppleUserJson(undefined)).toEqual({});
      expect(parseAppleUserJson("not json")).toEqual({});
      expect(parseAppleUserJson('{"name":{}}')).toEqual({});
    });
  });

  describe("splitAppleName", () => {
    it("uses provided first/last", () => {
      expect(splitAppleName({ firstName: "Ada", lastName: "Lovelace" })).toEqual({
        firstName: "Ada",
        lastName: "Lovelace",
      });
    });
    it("falls back to Apple / User (never Google/Facebook) when nothing is usable", () => {
      expect(splitAppleName({})).toEqual({ firstName: "Apple", lastName: "User" });
    });
  });
});
