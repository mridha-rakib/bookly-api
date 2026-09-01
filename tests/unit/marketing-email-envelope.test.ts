import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_API_BASE = process.env["PUBLIC_API_BASE_URL"];

const loadModule = async () => {
  vi.resetModules();
  return import("../../src/modules/marketing/marketing-email-envelope.js");
};

const loadLinks = async () => {
  vi.resetModules();
  return import("../../src/modules/marketing/marketing.links.js");
};

describe("marketing email envelope + links", () => {
  beforeEach(() => {
    delete process.env["PUBLIC_API_BASE_URL"];
  });

  afterEach(() => {
    if (ORIGINAL_API_BASE === undefined) {
      delete process.env["PUBLIC_API_BASE_URL"];
    } else {
      process.env["PUBLIC_API_BASE_URL"] = ORIGINAL_API_BASE;
    }
    vi.resetModules();
  });

  it("builds the visible page URL from FRONTEND_BASE_URL with the token as a query param", async () => {
    const { buildMarketingUnsubscribePageUrl } = await loadLinks();
    const url = buildMarketingUnsubscribePageUrl("abc.def.ghi");
    expect(url).toBe("http://localhost:3000/marketing/unsubscribe?token=abc.def.ghi");
  });

  it("returns no one-click URL when PUBLIC_API_BASE_URL is unset", async () => {
    const { resolveMarketingUnsubscribeOneClickUrl } = await loadLinks();
    expect(resolveMarketingUnsubscribeOneClickUrl("abc")).toBeUndefined();
  });

  it("builds the one-click URL against PUBLIC_API_BASE_URL (trailing slash trimmed) when set", async () => {
    process.env["PUBLIC_API_BASE_URL"] = "https://api.bookly.cy/api/v1/";
    const { resolveMarketingUnsubscribeOneClickUrl } = await loadLinks();
    expect(resolveMarketingUnsubscribeOneClickUrl("t0k3n")).toBe(
      "https://api.bookly.cy/api/v1/marketing/unsubscribe?token=t0k3n",
    );
  });

  it("envelope: emits List-Unsubscribe + one-click POST headers when the API base URL is configured", async () => {
    process.env["PUBLIC_API_BASE_URL"] = "https://api.bookly.cy/api/v1";
    const { buildMarketingEmailEnvelope, LIST_UNSUBSCRIBE_POST_VALUE } = await loadModule();

    const envelope = await buildMarketingEmailEnvelope("64b7f0c2e1a2b3c4d5e6f7a8");

    expect(envelope.unsubscribePageUrl).toMatch(
      /^http:\/\/localhost:3000\/marketing\/unsubscribe\?token=/,
    );
    expect(envelope.headers["List-Unsubscribe-Post"]).toBe(LIST_UNSUBSCRIBE_POST_VALUE);
    expect(LIST_UNSUBSCRIBE_POST_VALUE).toBe("List-Unsubscribe=One-Click");
    expect(envelope.headers["List-Unsubscribe"]).toMatch(
      /^<https:\/\/api\.bookly\.cy\/api\/v1\/marketing\/unsubscribe\?token=.+>$/,
    );
  });

  it("envelope: omits the one-click headers (but still returns a visible page URL) when unconfigured", async () => {
    const { buildMarketingEmailEnvelope } = await loadModule();
    const envelope = await buildMarketingEmailEnvelope("64b7f0c2e1a2b3c4d5e6f7a8");

    expect(envelope.headers).toEqual({});
    expect(envelope.unsubscribePageUrl).toMatch(/\/marketing\/unsubscribe\?token=/);
  });

  it("assertMarketingOneClickConfigured throws when PUBLIC_API_BASE_URL is unset and passes when set", async () => {
    const { assertMarketingOneClickConfigured } = await loadModule();
    expect(() => assertMarketingOneClickConfigured()).toThrowError(/one-click unsubscribe/i);

    process.env["PUBLIC_API_BASE_URL"] = "https://api.bookly.cy/api/v1";
    const reloaded = await loadModule();
    expect(() => reloaded.assertMarketingOneClickConfigured()).not.toThrow();
  });
});
