import { describe, expect, it } from "vitest";

import { renderMarketingEmailLayout } from "../../src/modules/email/templates/components/marketing-email-layout.js";

/** Marketing Email Stage M2 — the marketing-only branded shell. */

const UNSUB = "http://localhost:3000/marketing/unsubscribe?token=abc.def.ghi";

const layout = (overrides: Partial<Parameters<typeof renderMarketingEmailLayout>[0]> = {}) =>
  renderMarketingEmailLayout({
    preheader: "preview text",
    contentHtml: "<p>body</p>",
    contentText: "body",
    unsubscribeUrl: UNSUB,
    ...overrides,
  });

describe("marketing email layout", () => {
  it("renders a visible unsubscribe link in both HTML and text parts", () => {
    const { html, text } = layout();
    expect(html).toContain(`href="${UNSUB}"`);
    expect(html.toLowerCase()).toContain(">unsubscribe<");
    expect(text).toContain(`Unsubscribe: ${UNSUB}`);
  });

  it("keeps the Contact / Privacy / Terms footer links", () => {
    const { html } = layout();
    expect(html).toContain("Contact Us");
    expect(html).toContain("Privacy Policy");
    expect(html).toContain("Terms and Conditions");
    expect(html).toContain("/privacy");
    expect(html).toContain("/terms-of-use");
  });

  it("never carries the transactional 'automated transactional email' notice", () => {
    const { html, text } = layout();
    expect(html).not.toContain("This is an automated transactional email.");
    expect(text).not.toContain("This is an automated transactional email.");
  });

  it("uses the shared Bookly wordmark by CID and returns the brand image attachments", () => {
    const { html, attachments } = layout();
    expect(html).toContain('src="cid:bookly-wordmark"');
    expect(attachments.some((a) => a.contentId === "bookly-wordmark")).toBe(true);
    expect(attachments.some((a) => a.contentId === "bookly-icon")).toBe(true);
  });

  it("escapes a hostile unsubscribe URL rather than injecting markup", () => {
    const { html } = layout({
      unsubscribeUrl: 'http://x/"><script>alert(1)</script>',
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("produces both an HTML part and a text part", () => {
    const { html, text } = layout();
    expect(html.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("© Bookly.cy");
  });
});
