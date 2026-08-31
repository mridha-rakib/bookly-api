import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderEmailTemplate } from "../../src/modules/email/template-registry.js";
import { renderNoShowCancelledEmail } from "../../src/modules/email/templates/booking/no-show-cancelled.template.js";
import { renderNoShowChargedEmail } from "../../src/modules/email/templates/booking/no-show-charged.template.js";
import { buildNoShowEmailData } from "../../src/modules/email/templates/booking/no-show-email-data.js";
import { renderNoShowWaivedEmail } from "../../src/modules/email/templates/booking/no-show-waived.template.js";
import { buildNoShowBooking, NO_SHOW_CHARGED_AMOUNTS } from "./stage-d-fixtures.js";

/** MAILING STAGE D — no-show data builder + 3 templates (Part: no-show 19–25,29; arch 42–48). */

describe("no-show email data + templates", () => {
  it("19/20/21/22/23 CHARGED payload reflects the domain's own computed amounts (€40/30%/€8 → €4)", () => {
    const data = buildNoShowEmailData(buildNoShowBooking("NO_SHOW_CHARGED"), {
      businessName: "Soho Vintage Barbers",
      outcome: "CHARGED",
      amounts: NO_SHOW_CHARGED_AMOUNTS,
    });
    expect(data.charged).toEqual({
      noShowPercentage: 30,
      eligibleBasisFormatted: "€40.00",
      grossFeeFormatted: "€12.00",
      upfrontAppliedFormatted: "€8.00",
      additionalChargeFormatted: "€4.00",
    });

    const text = renderNoShowChargedEmail(data).text;
    expect(text).toContain("No-show fee rate: 30%");
    expect(text).toContain("Eligible booking amount: €40.00");
    expect(text).toContain("No-show fee: €12.00");
    expect(text).toContain("Already covered by your deposit: €8.00");
    expect(text).toContain("Charged to your card now: €4.00");
  });

  it("24/25 no €5/€35 clamp and no fee arithmetic anywhere in the no-show email layer", () => {
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const file of [
      "src/modules/email/templates/booking/no-show-email-data.ts",
      "src/modules/email/templates/booking/no-show-charged.template.ts",
      "src/modules/email/templates/booking/no-show-waived.template.ts",
      "src/modules/email/templates/booking/no-show-cancelled.template.ts",
    ]) {
      const src = stripComments(readFileSync(file, "utf8"));
      expect(/[A-Za-z]Cents\s*[-+*/]|[-+*/]\s*[A-Za-z]*Cents/.test(src)).toBe(false);
      expect(/Math\.round\(.*(?:Basis|Percentage|Fee).*\)/.test(src)).toBe(false);
      expect(src).not.toMatch(/\bclamp\b/i);
      // no €5 (500) / €35 (3500) clamp magic numbers
      expect(src).not.toMatch(/\b(?:500|3500)\b/);
    }
  });

  it("26/29 WAIVED and CANCELLED are semantically distinct and reassuring", () => {
    const waived = renderNoShowWaivedEmail(
      buildNoShowEmailData(buildNoShowBooking("NO_SHOW_WAIVED"), {
        businessName: "Soho",
        outcome: "WAIVED",
      }),
    );
    const cancelled = renderNoShowCancelledEmail(
      buildNoShowEmailData(buildNoShowBooking("NO_SHOW_CANCELLED"), {
        businessName: "Soho",
        outcome: "CANCELLED",
      }),
    );
    expect(waived.subject).toBe("No-show fee waived");
    expect(cancelled.subject).toBe("No-show status cancelled");
    expect(waived.text).toContain("has been waived");
    expect(cancelled.text).toContain("has been cancelled");
    expect(cancelled.text).toContain("reversed");
    expect(waived.text).not.toEqual(cancelled.text);
    for (const e of [waived, cancelled]) {
      expect(e.text.toLowerCase()).toContain("no no-show charge will be made");
    }
  });

  it("27 waived/cancelled emails never expose an internal note or waiver reason", () => {
    const data = buildNoShowEmailData(buildNoShowBooking("NO_SHOW_WAIVED"), {
      businessName: "Soho",
      outcome: "WAIVED",
    });
    const json = JSON.stringify(data).toLowerCase();
    for (const forbidden of ["internalnote", "note", "reason", "waivertaxonomy"]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("42–47 all 3 templates: HTML+text, branded header/footer, support/privacy/terms, no admin", () => {
    const emails = [
      renderNoShowChargedEmail(
        buildNoShowEmailData(buildNoShowBooking("NO_SHOW_CHARGED"), {
          businessName: "Soho",
          outcome: "CHARGED",
          amounts: NO_SHOW_CHARGED_AMOUNTS,
        }),
      ),
      renderNoShowWaivedEmail(
        buildNoShowEmailData(buildNoShowBooking("NO_SHOW_WAIVED"), {
          businessName: "Soho",
          outcome: "WAIVED",
        }),
      ),
      renderNoShowCancelledEmail(
        buildNoShowEmailData(buildNoShowBooking("NO_SHOW_CANCELLED"), {
          businessName: "Soho",
          outcome: "CANCELLED",
        }),
      ),
    ];
    for (const email of emails) {
      expect(email.html).toContain("cid:bookly-wordmark");
      expect(email.text.length).toBeGreaterThan(80);
      expect(email.html).toContain("support@bookly.cy");
      expect(email.html).toContain("/privacy");
      expect(email.html).toContain("/terms-of-use");
      expect(email.html).not.toContain("admin@bookly.cy");
    }
  });

  it("registry renders the 3 no-show keys", () => {
    const charged = buildNoShowEmailData(buildNoShowBooking("NO_SHOW_CHARGED"), {
      businessName: "Soho",
      outcome: "CHARGED",
      amounts: NO_SHOW_CHARGED_AMOUNTS,
    });
    expect(renderEmailTemplate("NO_SHOW_CHARGED", charged).subject).toBe("No-show fee charged");
    const waived = buildNoShowEmailData(buildNoShowBooking("NO_SHOW_WAIVED"), {
      businessName: "Soho",
      outcome: "WAIVED",
    });
    expect(renderEmailTemplate("NO_SHOW_WAIVED", waived).subject).toBe("No-show fee waived");
    expect(
      renderEmailTemplate("NO_SHOW_CANCELLED", { ...waived, outcome: "CANCELLED" }).subject,
    ).toBe("No-show status cancelled");
  });
});
