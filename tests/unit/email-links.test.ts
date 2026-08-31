import { describe, expect, it } from "vitest";

import {
  EMAIL_AUTOMATED_NOTICE,
  getEmailFooterLinks,
  SUPPORT_EMAIL,
  SUPPORT_MAILTO,
} from "../../src/modules/email/email.config.js";
import { buildFrontendUrl } from "../../src/modules/email/email.links.js";

/**
 * MAILING STAGE A — FRONTEND_BASE_URL link builder (Phase G) + public config (Phase H).
 * Part Y items 15–18. Tests run with the default FRONTEND_BASE_URL=http://localhost:3000.
 */
describe("email links and public config", () => {
  it("15 builds the Privacy Policy URL from FRONTEND_BASE_URL + /privacy", () => {
    expect(buildFrontendUrl("/privacy")).toBe("http://localhost:3000/privacy");
  });

  it("16 builds the Terms URL from FRONTEND_BASE_URL + /terms-of-use", () => {
    expect(buildFrontendUrl("/terms-of-use")).toBe("http://localhost:3000/terms-of-use");
  });

  it("17 never produces a double slash between base and path", () => {
    expect(buildFrontendUrl("privacy")).toBe("http://localhost:3000/privacy");
    expect(buildFrontendUrl("//privacy")).toBe("http://localhost:3000/privacy");
    expect(buildFrontendUrl("/")).toBe("http://localhost:3000");
    expect(buildFrontendUrl("/privacy")).not.toContain("//privacy");
  });

  it("18 exposes the canonical support address and mailto", () => {
    expect(SUPPORT_EMAIL).toBe("support@bookly.cy");
    expect(SUPPORT_MAILTO).toBe("mailto:support@bookly.cy");
    const links = getEmailFooterLinks();
    expect(links).toEqual([
      { label: "Contact Us", href: "mailto:support@bookly.cy" },
      { label: "Privacy Policy", href: "http://localhost:3000/privacy" },
      { label: "Terms and Conditions", href: "http://localhost:3000/terms-of-use" },
    ]);
    expect(EMAIL_AUTOMATED_NOTICE).toContain("automated transactional email");
  });
});
