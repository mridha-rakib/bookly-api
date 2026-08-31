import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderEmailTemplate } from "../../src/modules/email/template-registry.js";
import { renderBookingCancelledCustomerEmail } from "../../src/modules/email/templates/booking/booking-cancelled-customer.template.js";
import { renderBookingCancelledOwnerEmail } from "../../src/modules/email/templates/booking/booking-cancelled-owner.template.js";
import { buildCancellationEmailData } from "../../src/modules/email/templates/booking/cancellation-email-data.js";
import { buildCancelledBooking } from "./stage-d-fixtures.js";

/** MAILING STAGE D — cancellation data builder + templates (Part: cancellation 4,5,8,9,10,11,12,13; arch 42–48). */

const CTX_CUSTOMER = { businessName: "Soho Vintage Barbers", cancelledBy: "CUSTOMER" as const };
const CTX_BUSINESS = { businessName: "Soho Vintage Barbers", cancelledBy: "BUSINESS" as const };

describe("cancellation email data + templates", () => {
  it("9/10/11 customer-cancel with a late fee: persisted fee/deposit/additional-charge shown", () => {
    const booking = buildCancelledBooking({
      feeMode: "PERCENTAGE",
      feePercentage: 50,
      cancellationFeeCents: 1200,
      depositAppliedCents: 800,
      additionalChargeCents: 400,
      settlementStatus: "SUCCEEDED",
    });
    const data = buildCancellationEmailData(booking, CTX_CUSTOMER);
    expect(data.financialOutcome.hasCancellationFee).toBe(true);
    expect(data.financialOutcome.cancellationFeeFormatted).toBe("€12.00");
    expect(data.financialOutcome.depositAppliedFormatted).toBe("€8.00");
    expect(data.financialOutcome.additionalChargeFormatted).toBe("€4.00");
    expect(data.financialOutcome.hasAdditionalCharge).toBe(true);

    const text = renderBookingCancelledCustomerEmail(data).text;
    expect(text).toContain("Cancellation fee: €12.00");
    expect(text).toContain("Applied from your deposit already paid: €8.00");
    expect(text).toContain("Additional amount charged: €4.00");
  });

  it("a FAILED additional charge is not claimed as charged to the customer", () => {
    const data = buildCancellationEmailData(
      buildCancelledBooking({
        feeMode: "PERCENTAGE",
        cancellationFeeCents: 1200,
        depositAppliedCents: 800,
        additionalChargeCents: 400,
        settlementStatus: "FAILED",
      }),
      CTX_CUSTOMER,
    );
    expect(data.financialOutcome.hasAdditionalCharge).toBe(false);
    expect(renderBookingCancelledCustomerEmail(data).text).not.toContain(
      "Additional amount charged",
    );
  });

  it("4 customer wording says the customer cancelled", () => {
    const data = buildCancellationEmailData(buildCancelledBooking(), CTX_CUSTOMER);
    expect(renderBookingCancelledCustomerEmail(data).text).toContain(
      "has been cancelled as you requested",
    );
  });

  it("8 business-cancel customer wording says the business cancelled + shows persisted refund", () => {
    const data = buildCancellationEmailData(
      buildCancelledBooking({ refundOwedCents: 800, settlementStatus: "SUCCEEDED" }),
      CTX_BUSINESS,
    );
    const text = renderBookingCancelledCustomerEmail(data).text;
    expect(text).toContain("Soho Vintage Barbers has cancelled your booking.");
    expect(text).toContain("Refund of €8.00 for your upfront payment has been processed.");
  });

  it("5 owner wording says the customer cancelled", () => {
    const data = buildCancellationEmailData(buildCancelledBooking(), CTX_CUSTOMER);
    expect(renderBookingCancelledOwnerEmail(data).text).toContain(
      "Dana Klein cancelled this booking.",
    );
  });

  it("owner email for a business cancellation states the business cancelled + refund status", () => {
    const data = buildCancellationEmailData(
      buildCancelledBooking({ refundOwedCents: 800, settlementStatus: "SUCCEEDED" }),
      CTX_BUSINESS,
    );
    const text = renderBookingCancelledOwnerEmail(data).text;
    expect(text).toContain("cancelled by Soho Vintage Barbers");
    expect(text).toContain("Upfront payment of €8.00 refunded to the customer.");
  });

  it("42–47 both templates: HTML+text, shared branded header/footer, support/privacy/terms, no admin/legacy", () => {
    const data = buildCancellationEmailData(buildCancelledBooking(), CTX_CUSTOMER);
    for (const email of [
      renderBookingCancelledCustomerEmail(data),
      renderBookingCancelledOwnerEmail(data),
    ]) {
      expect(email.html).toContain("cid:bookly-wordmark");
      expect(email.text.length).toBeGreaterThan(80);
      expect(email.html).toContain("support@bookly.cy");
      expect(email.html).toContain("/privacy");
      expect(email.html).toContain("/terms-of-use");
      expect(email.html).not.toContain("admin@bookly.cy");
      const lower = `${email.html}\n${email.text}`.toLowerCase();
      expect(lower).not.toContain("beforelisted");
      expect(lower).not.toContain("vercel.app");
    }
  });

  it("13/48 templates + data builder contain no cancellation-fee arithmetic", () => {
    for (const file of [
      "src/modules/email/templates/booking/booking-cancelled-customer.template.ts",
      "src/modules/email/templates/booking/booking-cancelled-owner.template.ts",
      "src/modules/email/templates/booking/cancellation-facts-section.ts",
    ]) {
      const src = readFileSync(file, "utf8");
      expect(/[A-Za-z]Cents\s*[-+*/]|[-+*/]\s*[A-Za-z]*Cents/.test(src)).toBe(false);
      expect(
        /from\s+["'][^"']*\.(repository|model)\.js["']/.test(src.replace(/import type .*/g, "")),
      ).toBe(false);
    }
  });

  it("registry renders both cancellation keys", () => {
    const data = buildCancellationEmailData(buildCancelledBooking(), CTX_CUSTOMER);
    expect(renderEmailTemplate("BOOKING_CANCELLED_CUSTOMER", data).subject).toBe(
      "Your booking has been cancelled",
    );
    expect(renderEmailTemplate("BOOKING_CANCELLED_OWNER", data).subject).toContain(
      "Booking cancelled —",
    );
  });
});
