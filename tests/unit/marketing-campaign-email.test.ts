import { describe, expect, it } from "vitest";

import { renderMarketingCampaignEmail } from "../../src/modules/marketing/marketing-campaign-email.js";

const UNSUB = "http://localhost:3000/marketing/unsubscribe?token=abc.def.ghi";

describe("renderMarketingCampaignEmail — ARTICLE", () => {
  const rendered = renderMarketingCampaignEmail({
    type: "ARTICLE",
    snapshot: {
      title: "How to book a great massage",
      excerpt: "A short practical guide.",
      coverImageUrl: null,
    },
    ctaUrl: "http://localhost:3000/blog/how-to-book",
    unsubscribeUrl: UNSUB,
  });

  it("uses the article title as the subject and includes the excerpt + CTA", () => {
    expect(rendered.subject).toBe("How to book a great massage");
    expect(rendered.html).toContain("A short practical guide.");
    expect(rendered.html).toContain('href="http://localhost:3000/blog/how-to-book"');
    expect(rendered.html.toLowerCase()).toContain(">read the article<");
    expect(rendered.text).toContain("Read the article: http://localhost:3000/blog/how-to-book");
  });

  it("delegates to the marketing layout — visible unsubscribe link, no transactional notice", () => {
    expect(rendered.html).toContain(UNSUB);
    expect(rendered.html.toLowerCase()).toContain(">unsubscribe<");
    expect(rendered.html).not.toContain("This is an automated transactional email.");
    expect(rendered.attachments?.some((a) => a.contentId === "bookly-wordmark")).toBe(true);
  });

  it("clamps an over-long subject to ~120 chars with an ellipsis", () => {
    const long = renderMarketingCampaignEmail({
      type: "ARTICLE",
      snapshot: { title: "x".repeat(200), excerpt: "e", coverImageUrl: null },
      ctaUrl: "http://localhost:3000/blog/x",
      unsubscribeUrl: UNSUB,
    });
    expect(long.subject.length).toBeLessThanOrEqual(120);
    expect(long.subject.endsWith("…")).toBe(true);
  });

  it("never embeds a cover image — the only <img>s are the branded wordmark/icon CIDs", () => {
    const imgs = rendered.html.match(/<img[^>]+>/g) ?? [];
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) {
      expect(img).toContain("cid:bookly-");
    }
  });
});

describe("renderMarketingCampaignEmail — PROMO", () => {
  const percentage = renderMarketingCampaignEmail({
    type: "PROMO",
    snapshot: {
      normalizedCode: "BOOKLY20",
      type: "PERCENTAGE",
      value: 20,
      expiresAt: new Date("2026-09-14T00:00:00.000Z"),
      scope: "ALL_BOOKINGS",
      businessIds: [],
    },
    ctaUrl: "http://localhost:3000/explore",
    unsubscribeUrl: UNSUB,
  });

  it("renders a PERCENTAGE discount line, code, qualification, and a fixed end date", () => {
    expect(percentage.subject).toBe("20% off at Bookly");
    expect(percentage.html).toContain("20% off");
    expect(percentage.html).toContain("BOOKLY20");
    expect(percentage.html).toContain(
      "Valid on eligible bookings only, subject to terms, availability and while the offer lasts.",
    );
    expect(percentage.html).toMatch(/Ends 14 Sept? 2026/);
    expect(percentage.text).toContain("Use code BOOKLY20 at checkout.");
    expect(percentage.html).toContain('href="http://localhost:3000/explore"');
  });

  it("renders a FIXED discount as a currency amount (value is cents)", () => {
    const fixed = renderMarketingCampaignEmail({
      type: "PROMO",
      snapshot: {
        normalizedCode: "FIVE",
        type: "FIXED",
        value: 500,
        expiresAt: new Date("2026-01-02T00:00:00.000Z"),
        scope: "ALL_FIRST_BOOKINGS",
        businessIds: [],
      },
      ctaUrl: "http://localhost:3000/explore",
      unsubscribeUrl: UNSUB,
    });
    expect(fixed.subject).toBe("€5.00 off at Bookly");
    expect(fixed.html).toContain("€5.00 off");
    expect(fixed.html).toContain("For your first booking at a participating business.");
  });

  it("never claims a guaranteed discount and uses no countdown language", () => {
    const haystack = `${percentage.html}\n${percentage.text}`.toLowerCase();
    expect(haystack).not.toContain("guaranteed");
    expect(haystack).not.toContain("hurry");
    expect(haystack).not.toMatch(/\d+\s*(hours?|minutes?)\s+left/);
  });
});
