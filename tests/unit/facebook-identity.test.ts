import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildFacebookAuthUrl,
  FACEBOOK_OAUTH_SCOPES,
  FacebookIdentityError,
  resolveFacebookIdentity,
  splitFacebookName,
} from "../../src/common/oauth/facebook-identity.js";

const CONFIG = {
  clientId: "fb-app-123",
  clientSecret: "fb-secret",
  redirectUri: "http://localhost:3000/api/v1/auth/customer/oauth/facebook/callback",
};

const mockFetchSequence = (responses: Array<{ ok?: boolean; body: unknown }>) => {
  const fetchMock = vi.fn();
  for (const { ok = true, body } of responses) {
    fetchMock.mockResolvedValueOnce({ ok, json: async () => body });
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const VALID_TOKEN = { body: { access_token: "user-token-abc", token_type: "bearer" } };
const VALID_DEBUG = {
  body: { data: { is_valid: true, app_id: "fb-app-123", user_id: "fb-user-999" } },
};
const VALID_ME = {
  body: {
    id: "fb-user-999",
    name: "Pat Example",
    email: "Pat@Example.com",
    first_name: "Pat",
    last_name: "Example",
  },
};

describe("common/oauth/facebook-identity", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  describe("buildFacebookAuthUrl", () => {
    it("targets the OAuth dialog with client id, redirect URI, state and minimal scopes only", () => {
      const url = new URL(buildFacebookAuthUrl(CONFIG, "signed-state"));
      expect(url.origin + url.pathname).toBe("https://www.facebook.com/v23.0/dialog/oauth");
      expect(url.searchParams.get("client_id")).toBe("fb-app-123");
      expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
      expect(url.searchParams.get("state")).toBe("signed-state");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("scope")).toBe("email,public_profile");
      expect([...FACEBOOK_OAUTH_SCOPES]).toEqual(["email", "public_profile"]);
    });
  });

  describe("resolveFacebookIdentity", () => {
    it("returns the verified identity from introspection + minimal profile", async () => {
      const fetchMock = mockFetchSequence([VALID_TOKEN, VALID_DEBUG, VALID_ME]);
      const identity = await resolveFacebookIdentity(CONFIG, "auth-code");

      expect(identity).toEqual({
        providerAccountId: "fb-user-999",
        email: "Pat@Example.com",
        emailVerified: true,
        displayName: "Pat Example",
        firstName: "Pat",
        lastName: "Example",
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const [tokenUrl, debugUrl, meUrl] = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(tokenUrl).toContain("/oauth/access_token");
      expect(tokenUrl).toContain("code=auth-code");
      expect(debugUrl).toContain("/debug_token");
      expect(debugUrl).toContain("input_token=user-token-abc");
      expect(debugUrl).toContain(encodeURIComponent("fb-app-123|fb-secret"));
      expect(meUrl).toContain("/me?");
      expect(meUrl).toContain("appsecret_proof=");
    });

    it("returns emailVerified:false and no email key when Facebook returns no email (NOT an error)", async () => {
      mockFetchSequence([VALID_TOKEN, VALID_DEBUG, { body: { id: "fb-user-999", name: "Pat" } }]);
      const identity = await resolveFacebookIdentity(CONFIG, "code");
      expect(identity).toMatchObject({ providerAccountId: "fb-user-999", emailVerified: false });
      expect(identity).not.toHaveProperty("email");
    });

    it("throws FacebookIdentityError when the code exchange fails", async () => {
      mockFetchSequence([{ ok: false, body: { error: { message: "bad" } } }]);
      await expect(resolveFacebookIdentity(CONFIG, "bad")).rejects.toBeInstanceOf(
        FacebookIdentityError,
      );
    });

    it("throws when no access_token is returned", async () => {
      mockFetchSequence([{ body: { token_type: "bearer" } }]);
      await expect(resolveFacebookIdentity(CONFIG, "code")).rejects.toBeInstanceOf(
        FacebookIdentityError,
      );
    });

    it("rejects an invalid token", async () => {
      mockFetchSequence([
        VALID_TOKEN,
        { body: { data: { is_valid: false, app_id: "fb-app-123", user_id: "fb-user-999" } } },
      ]);
      await expect(resolveFacebookIdentity(CONFIG, "code")).rejects.toBeInstanceOf(
        FacebookIdentityError,
      );
    });

    it("rejects a token minted for a DIFFERENT Meta app (app_id mismatch)", async () => {
      mockFetchSequence([
        VALID_TOKEN,
        { body: { data: { is_valid: true, app_id: "someone-else", user_id: "fb-user-999" } } },
      ]);
      await expect(resolveFacebookIdentity(CONFIG, "code")).rejects.toBeInstanceOf(
        FacebookIdentityError,
      );
    });

    it("rejects when introspection carries no user_id", async () => {
      mockFetchSequence([
        VALID_TOKEN,
        { body: { data: { is_valid: true, app_id: "fb-app-123" } } },
      ]);
      await expect(resolveFacebookIdentity(CONFIG, "code")).rejects.toBeInstanceOf(
        FacebookIdentityError,
      );
    });

    it("rejects when /me.id disagrees with the introspected user_id", async () => {
      mockFetchSequence([
        VALID_TOKEN,
        VALID_DEBUG,
        { body: { id: "a-different-id", name: "X", email: "x@y.com" } },
      ]);
      await expect(resolveFacebookIdentity(CONFIG, "code")).rejects.toBeInstanceOf(
        FacebookIdentityError,
      );
    });

    it("never returns or echoes the provider access token", async () => {
      mockFetchSequence([VALID_TOKEN, VALID_DEBUG, VALID_ME]);
      const identity = await resolveFacebookIdentity(CONFIG, "code");
      expect(JSON.stringify(identity)).not.toContain("user-token-abc");
    });
  });

  describe("splitFacebookName", () => {
    it("uses first_name + last_name when both present", () => {
      expect(splitFacebookName({ firstName: "Ada", lastName: "Lovelace" })).toEqual({
        firstName: "Ada",
        lastName: "Lovelace",
      });
    });

    it("splits a multi-word display name", () => {
      expect(splitFacebookName({ displayName: "Grace Brewster Hopper" })).toEqual({
        firstName: "Grace",
        lastName: "Brewster Hopper",
      });
    });

    it("falls back to Facebook / User (never Google) when nothing is usable", () => {
      expect(splitFacebookName({})).toEqual({ firstName: "Facebook", lastName: "User" });
    });
  });
});
