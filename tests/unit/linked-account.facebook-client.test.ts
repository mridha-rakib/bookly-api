import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv: {
  FACEBOOK_CLIENT_ID?: string | undefined;
  FACEBOOK_CLIENT_SECRET?: string | undefined;
  FACEBOOK_ACCOUNT_LINK_REDIRECT_URI?: string | undefined;
} = {
  FACEBOOK_CLIENT_ID: "fb-app-123",
  FACEBOOK_CLIENT_SECRET: "fb-secret",
  FACEBOOK_ACCOUNT_LINK_REDIRECT_URI: "http://localhost:3000/api/v1/auth/oauth/facebook/callback",
};

vi.mock("../../src/config/env.js", () => ({ env: mockEnv }));

const {
  buildFacebookAccountLinkAuthUrl,
  isFacebookAccountLinkConfigured,
  verifyFacebookAccountLinkCallback,
} = await import("../../src/modules/linked-account/facebook-oauth.client.js");

/**
 * Sequences JSON responses for the three ordered Graph calls:
 *   1. GET /oauth/access_token   2. GET /debug_token   3. GET /me
 */
const mockFetchSequence = (responses: Array<{ ok?: boolean; body: unknown }>) => {
  const fetchMock = vi.fn();
  for (const { ok = true, body } of responses) {
    fetchMock.mockResolvedValueOnce({
      ok,
      json: async () => body,
    });
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const VALID_TOKEN = { body: { access_token: "user-token-abc", token_type: "bearer" } };
const VALID_DEBUG = {
  body: { data: { is_valid: true, app_id: "fb-app-123", user_id: "fb-user-999" } },
};
const VALID_ME = { body: { id: "fb-user-999", name: "Pat Example", email: "Pat@Example.com" } };

describe("linked-account facebook-oauth client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.FACEBOOK_CLIENT_ID = "fb-app-123";
    mockEnv.FACEBOOK_CLIENT_SECRET = "fb-secret";
    mockEnv.FACEBOOK_ACCOUNT_LINK_REDIRECT_URI =
      "http://localhost:3000/api/v1/auth/oauth/facebook/callback";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("isFacebookAccountLinkConfigured", () => {
    it("is true only when id, secret and redirect URI are all set", () => {
      expect(isFacebookAccountLinkConfigured()).toBe(true);

      mockEnv.FACEBOOK_ACCOUNT_LINK_REDIRECT_URI = undefined;
      expect(isFacebookAccountLinkConfigured()).toBe(false);

      mockEnv.FACEBOOK_ACCOUNT_LINK_REDIRECT_URI = "x";
      mockEnv.FACEBOOK_CLIENT_SECRET = undefined;
      expect(isFacebookAccountLinkConfigured()).toBe(false);
    });
  });

  describe("buildFacebookAccountLinkAuthUrl", () => {
    it("targets the OAuth dialog with the client id, redirect URI, signed state and minimal scopes", () => {
      const url = new URL(buildFacebookAccountLinkAuthUrl("signed-state-token"));

      expect(url.origin + url.pathname).toBe("https://www.facebook.com/v23.0/dialog/oauth");
      expect(url.searchParams.get("client_id")).toBe("fb-app-123");
      expect(url.searchParams.get("redirect_uri")).toBe(
        "http://localhost:3000/api/v1/auth/oauth/facebook/callback",
      );
      expect(url.searchParams.get("state")).toBe("signed-state-token");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("scope")).toBe("email,public_profile");
      // No over-broad permissions.
      expect(url.searchParams.get("scope")).not.toContain("pages");
      expect(url.searchParams.get("scope")).not.toContain("publish");
      expect(url.searchParams.get("scope")).not.toContain("business");
    });

    it("throws NOT_CONFIGURED (503) when config is missing", () => {
      mockEnv.FACEBOOK_CLIENT_ID = undefined;
      expect(() => buildFacebookAccountLinkAuthUrl("s")).toThrowError();
    });
  });

  describe("verifyFacebookAccountLinkCallback", () => {
    it("returns the verified identity from the introspected token + minimal profile", async () => {
      const fetchMock = mockFetchSequence([VALID_TOKEN, VALID_DEBUG, VALID_ME]);

      const identity = await verifyFacebookAccountLinkCallback("auth-code");

      expect(identity).toEqual({
        providerAccountId: "fb-user-999",
        email: "Pat@Example.com",
        emailVerified: true,
        displayName: "Pat Example",
      });

      // 3 ordered Graph calls: token exchange, debug_token, /me.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const [tokenUrl, debugUrl, meUrl] = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(tokenUrl).toContain("/oauth/access_token");
      expect(tokenUrl).toContain("code=auth-code");
      expect(debugUrl).toContain("/debug_token");
      expect(debugUrl).toContain("input_token=user-token-abc");
      expect(debugUrl).toContain(encodeURIComponent("fb-app-123|fb-secret"));
      expect(meUrl).toContain("/me?");
      expect(meUrl).toContain("fields=id%2Cname%2Cemail");
      expect(meUrl).toContain("appsecret_proof=");
    });

    it("omits displayName when the profile has no name", async () => {
      mockFetchSequence([
        VALID_TOKEN,
        VALID_DEBUG,
        { body: { id: "fb-user-999", email: "a@b.com" } },
      ]);

      const identity = await verifyFacebookAccountLinkCallback("code");
      expect(identity).not.toHaveProperty("displayName");
    });

    it("throws OAUTH_FAILED (502) when the code exchange fails", async () => {
      mockFetchSequence([{ ok: false, body: { error: { message: "bad code" } } }]);

      await expect(verifyFacebookAccountLinkCallback("bad")).rejects.toMatchObject({
        statusCode: 502,
        details: [{ code: "LINKED_ACCOUNT_OAUTH_FAILED" }],
      });
    });

    it("throws OAUTH_FAILED when no access_token is returned", async () => {
      mockFetchSequence([{ body: { token_type: "bearer" } }]);

      await expect(verifyFacebookAccountLinkCallback("code")).rejects.toMatchObject({
        statusCode: 502,
      });
    });

    it("rejects a token that is not valid", async () => {
      mockFetchSequence([
        VALID_TOKEN,
        { body: { data: { is_valid: false, app_id: "fb-app-123", user_id: "fb-user-999" } } },
      ]);

      await expect(verifyFacebookAccountLinkCallback("code")).rejects.toMatchObject({
        statusCode: 502,
      });
    });

    it("rejects a token minted for a DIFFERENT Facebook app", async () => {
      mockFetchSequence([
        VALID_TOKEN,
        { body: { data: { is_valid: true, app_id: "someone-elses-app", user_id: "fb-user-999" } } },
      ]);

      await expect(verifyFacebookAccountLinkCallback("code")).rejects.toMatchObject({
        statusCode: 502,
      });
    });

    it("rejects when the introspection carries no user id", async () => {
      mockFetchSequence([
        VALID_TOKEN,
        { body: { data: { is_valid: true, app_id: "fb-app-123" } } },
      ]);

      await expect(verifyFacebookAccountLinkCallback("code")).rejects.toMatchObject({
        statusCode: 502,
      });
    });

    it("rejects when /me id disagrees with the introspected user id", async () => {
      mockFetchSequence([
        VALID_TOKEN,
        VALID_DEBUG,
        { body: { id: "a-different-id", name: "X", email: "x@y.com" } },
      ]);

      await expect(verifyFacebookAccountLinkCallback("code")).rejects.toMatchObject({
        statusCode: 502,
      });
    });

    it("rejects when Facebook returns no email (schema requires one; same as Google)", async () => {
      mockFetchSequence([VALID_TOKEN, VALID_DEBUG, { body: { id: "fb-user-999", name: "X" } }]);

      await expect(verifyFacebookAccountLinkCallback("code")).rejects.toMatchObject({
        statusCode: 502,
        details: [{ code: "LINKED_ACCOUNT_OAUTH_FAILED" }],
      });
    });

    it("never returns or echoes the provider access token", async () => {
      mockFetchSequence([VALID_TOKEN, VALID_DEBUG, VALID_ME]);
      const identity = await verifyFacebookAccountLinkCallback("code");
      expect(JSON.stringify(identity)).not.toContain("user-token-abc");
    });
  });
});
