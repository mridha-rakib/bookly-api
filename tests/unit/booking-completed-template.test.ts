import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderEmailTemplate } from "../../src/modules/email/template-registry.js";
import { renderBookingCompletedEmail } from "../../src/modules/email/templates/booking/booking-completed.template.js";
import { buildInvoiceDataFixture } from "./stage-c-fixtures.js";

/** MAILING STAGE C — BOOKING_COMPLETED email template (Part AE items 22–33, 43, 44, 45, 12, 13). */

const payload = (over = {}) => ({
  invoice: buildInvoiceDataFixture(over),
  customerBookingUrlPath: "/customer/bookings/view?id=abc123",
});

describe("BOOKING_COMPLETED email template", () => {
  it("22/23 subject + purpose-specific completion copy", () => {
    const email = renderBookingCompletedEmail(payload());
    expect(email.subject).toBe("Your booking is complete");
    expect(email.text).toContain("your appointment with Soho Vintage Barbers is now complete");
  });

  it("24/25/26 non-empty HTML + text, shared branded header/footer", () => {
    const email = renderBookingCompletedEmail(payload());
    expect(email.html).toContain("cid:bookly-wordmark");
    expect(email.html.length).toBeGreaterThan(200);
    expect(email.text.length).toBeGreaterThan(200);
    expect(email.attachments?.some((a) => a.contentId === "bookly-wordmark")).toBe(true);
  });

  it("27 invoice summary present (reference, totals, status)", () => {
    const t = renderBookingCompletedEmail(payload()).text;
    expect(t).toContain("Booking reference: BK-7F3K9QZC");
    expect(t).toContain("Total: €35.00");
    expect(t).toContain("Paid online: €7.00");
    expect(t).toContain("Paid at venue: €28.00");
    expect(t).toContain("Total paid: €35.00");
    expect(t).toContain("Payment status: Paid in full");
  });

  it("28 states that the PDF invoice is attached", () => {
    const email = renderBookingCompletedEmail(payload());
    expect(email.text.toLowerCase()).toContain("pdf copy of your invoice is attached");
    expect(email.html.toLowerCase()).toContain("pdf copy of your invoice is attached");
  });

  it("29/30/31/32/33 footer links + no admin / legacy URLs", () => {
    const email = renderBookingCompletedEmail(payload());
    expect(email.html).toContain("support@bookly.cy");
    expect(email.html).toContain("/privacy");
    expect(email.html).toContain("/terms-of-use");
    expect(email.html).not.toContain("admin@bookly.cy");
    const lower = `${email.html}\n${email.text}`.toLowerCase();
    expect(lower).not.toContain("beforelisted");
    expect(lower).not.toContain("pennymore");
    expect(lower).not.toContain("vercel.app");
  });

  it("43 settlement labels: PARTIAL / NOT_PAID", () => {
    const partial = renderBookingCompletedEmail(
      payload({
        financial: {
          ...buildInvoiceDataFixture().financial,
          settlementStatus: "PARTIAL",
          settlementLabel: "Partially paid",
          outstandingFormatted: "€18.00",
          show: { ...buildInvoiceDataFixture().financial.show, outstanding: true },
        },
      }),
    );
    expect(partial.text).toContain("Payment status: Partially paid");
    expect(partial.text).toContain("Outstanding: €18.00");

    const notPaid = renderBookingCompletedEmail(
      payload({
        financial: {
          ...buildInvoiceDataFixture().financial,
          settlementStatus: "NOT_PAID",
          settlementLabel: "Not paid at venue",
          venuePaymentFormatted: "€0.00",
          outstandingFormatted: "€28.00",
          show: {
            ...buildInvoiceDataFixture().financial.show,
            venuePayment: false,
            outstanding: true,
          },
        },
      }),
    );
    expect(notPaid.text).toContain("Payment status: Not paid at venue");
    expect(notPaid.text).not.toContain("Paid at venue:");
    expect(notPaid.text).toContain("Outstanding: €28.00");
  });

  it("44/45 optional zero rows omit cleanly; non-zero outstanding always shown", () => {
    const t = renderBookingCompletedEmail(payload()).text; // FULL fixture: no discount/travel/outstanding
    expect(t).not.toContain("Discount:");
    expect(t).not.toContain("Travel fee:");
    expect(t).not.toContain("Outstanding:");
  });

  it("12/13 template file does no DB access and no money arithmetic", () => {
    const src = readFileSync(
      "src/modules/email/templates/booking/booking-completed.template.ts",
      "utf8",
    );
    const runtimeImports = src
      .split("\n")
      .filter((l) => /^\s*import\s/.test(l) && !/^\s*import\s+type\s/.test(l));
    expect(runtimeImports.some((l) => /\.(repository|model)\.js["']/.test(l))).toBe(false);
    expect(/\bmongoose\b/.test(src)).toBe(false);
    expect(/[A-Za-z]Cents\s*[-+*/]|[-+*/]\s*[A-Za-z]*Cents/.test(src)).toBe(false);
  });

  it("registry renders BOOKING_COMPLETED", () => {
    expect(renderEmailTemplate("BOOKING_COMPLETED", payload()).subject).toBe(
      "Your booking is complete",
    );
  });
});
