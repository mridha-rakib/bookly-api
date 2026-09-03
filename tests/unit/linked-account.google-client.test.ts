import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv: {
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
  GOOGLE_ACCOUNT_LINK_REDIRECT_URI?: string | undefined;
} = {
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_ACCOUNT_LINK_REDIRECT_URI: "http://localhost:3000/api/v1/auth/oauth/google/callback",
};

vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));

const generateAuthUrl = vi.fn(() => "https://accounts.google.com/o/oauth2/v2/auth?mock=1");
const getToken = vi.fn();
const verifyIdToken = vi.fn();

class MockOAuth2Client {
  public generateAuthUrl = generateAuthUrl;
  public getToken = getToken;
  public verifyIdToken = verifyIdToken;
}

vi.mock("google-auth-library", () => ({ OAuth2Client: MockOAuth2Client }));

const {
  buildGoogleAccountLinkAuthUrl,
  isGoogleAccountLinkConfigured,
  verifyGoogleAccountLinkCallback,
} = await import("../../src/modules/linked-account/google-oauth.client.js");

describe("linked-account google-oauth client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.GOOGLE_CLIENT_ID = "test-client-id";
    mockEnv.GOOGLE_CLIENT_SECRET = "test-client-secret";
    mockEnv.GOOGLE_ACCOUNT_LINK_REDIRECT_URI =
      "http://localhost:3000/api/v1/auth/oauth/google/callback";
  });

  describe("isGoogleAccountLinkConfigured", () => {
    it("is true only when id, secret and redirect URI are all set", () => {
      expect(isGoogleAccountLinkConfigured()).toBe(true);

      mockEnv.GOOGLE_ACCOUNT_LINK_REDIRECT_URI = undefined;
      expect(isGoogleAccountLinkConfigured()).toBe(false);
    });
  });

  describe("buildGoogleAccountLinkAuthUrl", () => {
    it("requests OIDC scopes only, online access, an account chooser, and passes the state", () => {
      const url = buildGoogleAccountLinkAuthUrl("signed-state-token");

      expect(url).toBe("https://accounts.google.com/o/oauth2/v2/auth?mock=1");
      expect(generateAuthUrl).toHaveBeenCalledWith({
        access_type: "online",
        prompt: "select_account",
        scope: ["openid", "email", "profile"],
        state: "signed-state-token",
      });
    });
  });

  describe("verifyGoogleAccountLinkCallback", () => {
    it("returns the verified identity (sub, email, emailVerified, displayName) from the id_token", async () => {
      getToken.mockResolvedValue({ tokens: { id_token: "an-id-token" } });
      verifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: "google-sub-123",
          email: "Person@Gmail.com",
          email_verified: true,
          name: "Person Example",
        }),
      });

      const identity = await verifyGoogleAccountLinkCallback("auth-code");

      expect(verifyIdToken).toHaveBeenCalledWith({
        idToken: "an-id-token",
        audience: "test-client-id",
      });
      expect(identity).toEqual({
        providerAccountId: "google-sub-123",
        email: "Person@Gmail.com",
        emailVerified: true,
        displayName: "Person Example",
      });
    });

    it("marks emailVerified false when the claim is not exactly true, and omits an absent name", async () => {
      getToken.mockResolvedValue({ tokens: { id_token: "an-id-token" } });
      verifyIdToken.mockResolvedValue({
        getPayload: () => ({ sub: "sub-1", email: "a@b.com", email_verified: "true" }),
      });

      const identity = await verifyGoogleAccountLinkCallback("auth-code");

      expect(identity.emailVerified).toBe(false);
      expect(identity).not.toHaveProperty("displayName");
    });

    it("throws LINKED_ACCOUNT_OAUTH_FAILED (502) when the code exchange fails", async () => {
      getToken.mockRejectedValue(new Error("invalid_grant"));

      await expect(verifyGoogleAccountLinkCallback("bad-code")).rejects.toMatchObject({
        statusCode: 502,
        details: [{ code: "LINKED_ACCOUNT_OAUTH_FAILED" }],
      });
    });

    it("throws LINKED_ACCOUNT_OAUTH_FAILED when no id_token is returned", async () => {
      getToken.mockResolvedValue({ tokens: {} });

      await expect(verifyGoogleAccountLinkCallback("code")).rejects.toMatchObject({
        statusCode: 502,
      });
    });

    it("throws LINKED_ACCOUNT_OAUTH_FAILED when id_token verification fails", async () => {
      getToken.mockResolvedValue({ tokens: { id_token: "tampered" } });
      verifyIdToken.mockRejectedValue(new Error("Invalid token signature"));

      await expect(verifyGoogleAccountLinkCallback("code")).rejects.toMatchObject({
        statusCode: 502,
      });
    });

    it("throws LINKED_ACCOUNT_OAUTH_FAILED when the payload has no sub or email", async () => {
      getToken.mockResolvedValue({ tokens: { id_token: "an-id-token" } });
      verifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: "only-sub" }) });

      await expect(verifyGoogleAccountLinkCallback("code")).rejects.toMatchObject({
        statusCode: 502,
      });
    });
  });
});
