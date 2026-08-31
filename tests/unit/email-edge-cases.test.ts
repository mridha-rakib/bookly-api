import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import type { BookingDocument } from "../../src/modules/booking/booking.model.js";
import { renderEmailTemplate } from "../../src/modules/email/template-registry.js";
import { buildBookingEmailData } from "../../src/modules/email/templates/booking/booking-email-data.js";
import { buildCancellationEmailData } from "../../src/modules/email/templates/booking/cancellation-email-data.js";
import { buildNoShowEmailData } from "../../src/modules/email/templates/booking/no-show-email-data.js";
import { buildInvoiceData } from "../../src/modules/email/templates/invoice/invoice-data.js";
import { buildBooking } from "./stage-b-fixtures.js";
import { NO_SHOW_CHARGED_AMOUNTS } from "./stage-d-fixtures.js";

/**
 * FINAL QA — Phase Y (long content) + Phase Z (missing optional data). No `undefined` / `null` /
 * `NaN` / `[object Object]` may appear in any rendered email or its text part.
 */

const BAD_TOKENS = ["undefined", "null", "NaN", "[object Object]"];
const assertClean = (parts: string[]): void => {
  for (const part of parts) {
    for (const token of BAD_TOKENS) {
      expect(part).not.toContain(token);
    }
  }
};

const LONG = "Q".repeat(160);

const minimalBooking = (over: Partial<BookingDocument> = {}): BookingDocument =>
  buildBooking({
    // no staff snapshot, no add-ons, no promo, no cancellation policy, no travel/discount
    serviceLines: [
      {
        serviceId: new Types.ObjectId(),
        serviceSnapshot: { name: "Cut", pricingMode: "FIXED", durationMin: 20 },
        pricingInput: {},
        responsibleStaffMembershipId: new Types.ObjectId(),
        addons: [],
        amountCents: 3500,
        reservationId: new Types.ObjectId(),
      },
    ] as never,
    financials: {
      currency: "EUR",
      servicesSubtotalCents: 3500,
      addonsSubtotalCents: 0,
      serviceDiscountCents: 0,
      travelFeeCents: 0,
      eligiblePlatformFeeBasisCents: 3500,
      platformFeeCents: 700,
      depositCents: 700,
      balanceDueCents: 2800,
      totalCents: 3500,
    } as never,
    cancellationPolicySnapshot: undefined,
    customer: {
      businessClientId: new Types.ObjectId(),
      // no customerUserId -> no CTA
      contact: {
        firstName: "A",
        normalizedEmail: "a@example.com",
        phone: { countryCode: "+357", nationalNumber: "1", e164: "+3571" },
      },
    } as never,
    ...over,
  });

describe("FINAL QA — long content + missing optional data", () => {
  it("booking creation email: no staff/add-ons/policy/CTA — clean omission", () => {
    const data = buildBookingEmailData(minimalBooking(), {
      businessName: LONG,
      includeCustomerBookingLink: true,
    });
    expect(data.customerBookingUrlPath).toBeUndefined();
    const email = renderEmailTemplate("BOOKING_CUSTOMER_CONFIRMED", data);
    assertClean([email.html, email.text, email.subject]);
    // no "  - Cut (20 min with <staff>)" — staff omitted cleanly
    expect(email.text).toContain("Cut (20 min)");
  });

  it("BOOKING_COMPLETED: NOT_RECORDED settlement + minimal booking renders cleanly", () => {
    const invoice = buildInvoiceData(
      minimalBooking({ status: "COMPLETED" as never, completionPayment: undefined }),
      { businessName: LONG },
    );
    expect(invoice.financial.settlementStatus).toBe("NOT_RECORDED");
    expect(invoice.business.phone).toBeUndefined();
    expect(invoice.business.address).toBeUndefined();
    const email = renderEmailTemplate("BOOKING_COMPLETED", { invoice });
    assertClean([email.html, email.text, email.subject]);
  });

  it("cancellation email: FREE outcome, no fee/refund — clean omission", () => {
    const data = buildCancellationEmailData(minimalBooking(), {
      businessName: LONG,
      cancelledBy: "CUSTOMER",
    });
    expect(data.financialOutcome.hasCancellationFee).toBe(false);
    for (const key of ["BOOKING_CANCELLED_CUSTOMER", "BOOKING_CANCELLED_OWNER"] as const) {
      const email = renderEmailTemplate(key, data);
      assertClean([email.html, email.text, email.subject]);
    }
  });

  it("no-show waived / cancelled with a minimal booking — clean", () => {
    const base = buildNoShowEmailData(minimalBooking(), { businessName: LONG, outcome: "WAIVED" });
    assertClean([
      renderEmailTemplate("NO_SHOW_WAIVED", base).html,
      renderEmailTemplate("NO_SHOW_WAIVED", base).text,
      renderEmailTemplate("NO_SHOW_CANCELLED", { ...base, outcome: "CANCELLED" }).text,
    ]);
  });

  it("no-show charged with long business name + large valid amounts", () => {
    const data = buildNoShowEmailData(minimalBooking(), {
      businessName: LONG,
      outcome: "CHARGED",
      amounts: {
        ...NO_SHOW_CHARGED_AMOUNTS,
        eligibleBasisCents: 9_999_999,
        grossFeeCents: 2_999_999,
        additionalChargeCents: 2_199_999,
      },
    });
    const email = renderEmailTemplate("NO_SHOW_CHARGED", data);
    assertClean([email.html, email.text]);
    expect(email.text).toContain("€99999.99");
  });

  it("BUSINESS_REGISTERED with only the required fields", () => {
    const email = renderEmailTemplate("BUSINESS_REGISTERED", {
      businessId: "b1",
      businessName: LONG,
      ownerName: "O",
      ownerEmail: "o@example.com",
      status: "PENDING",
      registeredAtFormatted: "Saturday, 5 September 2026",
    });
    assertClean([email.html, email.text, email.subject]);
    expect(email.text).not.toContain("Phone:");
    expect(email.text).not.toContain("Category:");
    expect(email.text).not.toContain("City:");
  });

  it("multiple services + multiple add-ons still render cleanly", () => {
    const many = buildBooking({
      serviceLines: Array.from({ length: 6 }, (_, i) => ({
        serviceId: new Types.ObjectId(),
        serviceSnapshot: { name: `Service ${i} ${LONG}`, pricingMode: "FIXED", durationMin: 30 },
        pricingInput: {},
        responsibleStaffMembershipId: new Types.ObjectId(),
        staffSnapshot: { firstName: `Staff ${i}`, lastName: LONG },
        addons: [
          { addonId: new Types.ObjectId(), name: `Addon ${i}a`, priceCents: 200 },
          { addonId: new Types.ObjectId(), name: `Addon ${i}b`, priceCents: 300 },
        ],
        amountCents: 3000,
        reservationId: new Types.ObjectId(),
      })) as never,
    });
    const data = buildBookingEmailData(many, {
      businessName: "B",
      includeCustomerBookingLink: false,
    });
    const email = renderEmailTemplate("BOOKING_OWNER_NEW_BOOKING", data);
    assertClean([email.html, email.text]);
  });
});
