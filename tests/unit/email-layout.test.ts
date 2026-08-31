import { describe, expect, it } from "vitest";

import { renderEmailLayout } from "../../src/modules/email/templates/components/email-layout.js";

/** MAILING STAGE A — reusable header/footer (Phase I/J/K). Part Y items 19–25. */

const layout = () =>
  renderEmailLayout({
    preheader: "preview text",
    contentHtml: "<p>body</p>",
    contentText: "body",
  });

describe("reusable branded email layout", () => {
  it("19 header references the official Bookly wordmark by CID with alt text", () => {
    const { html, attachments } = layout();
    expect(html).toContain('src="cid:bookly-wordmark"');
    expect(html).toContain('alt="Bookly.cy"');
    expect(
      attachments.some((a) => a.contentId === "bookly-wordmark" && a.disposition === "inline"),
    ).toBe(true);
  });

  it("20/21/22 footer carries exactly Contact Us | Privacy Policy | Terms and Conditions", () => {
    const { html, text } = layout();
    expect(html).toContain("Contact Us");
    expect(html).toContain("Privacy Policy");
    expect(html).toContain("Terms and Conditions");
    expect(html).toContain("/privacy");
    expect(html).toContain("/terms-of-use");
    expect(text).toContain("Privacy Policy: http://localhost:3000/privacy");
    expect(text).toContain("Terms and Conditions: http://localhost:3000/terms-of-use");
  });

  it("23 footer shows the public support address", () => {
    const { html, text } = layout();
    expect(html).toContain("support@bookly.cy");
    expect(text).toContain("support@bookly.cy");
  });

  it("24 footer never exposes admin@bookly.cy", () => {
    const { html, text } = layout();
    expect(html).not.toContain("admin@bookly.cy");
    expect(text).not.toContain("admin@bookly.cy");
  });

  it("25 contains no legacy BeforeListed / Pennymore / vercel links", () => {
    const { html, text } = layout();
    const haystack = `${html}\n${text}`.toLowerCase();
    expect(haystack).not.toContain("beforelisted");
    expect(haystack).not.toContain("pennymore");
    expect(haystack).not.toContain("vercel.app");
  });

  it("produces both an HTML part and a text part (no HTML-only email)", () => {
    const { html, text } = layout();
    expect(html.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("© Bookly.cy");
    expect(text).toContain("This is an automated transactional email.");
  });
});
