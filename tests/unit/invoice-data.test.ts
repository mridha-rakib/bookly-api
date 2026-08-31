import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import type { BookingDocument } from "../../src/modules/booking/booking.model.js";
import { buildInvoiceData } from "../../src/modules/email/templates/invoice/invoice-data.js";
import { buildCompletedBooking } from "./stage-c-fixtures.js";

/** MAILING STAGE C — the single InvoiceData builder (Part AE items 6–21). */

const ctx = { businessName: "Soho Vintage Barbers", businessPhone: "+35799000111" };

const withCompletion = (cp: Partial<BookingDocument["completionPayment"]> | undefined) =>
  buildCompletedBooking({ completionPayment: cp as never });

describe("buildInvoiceData", () => {
  it("6/7 uses the booking reference as the invoice reference — no fake sequence", () => {
    const data = buildInvoiceData(buildCompletedBooking(), ctx);
    expect(data.bookingReference).toBe("BK-7F3K9QZC");
    expect(data.invoiceReference).toBe("BK-7F3K9QZC");
    expect(JSON.stringify(data)).not.toMatch(/INV-\d|invoiceNumber|invoiceSeq/i);
  });

  it("8/9 line items come from the persisted service + add-on snapshots", () => {
    const data = buildInvoiceData(buildCompletedBooking(), ctx);
    expect(data.lineItems).toEqual([
      { label: "Haircut", kind: "SERVICE", amountFormatted: "€30.00" },
      { label: "Beard trim", kind: "ADDON", amountFormatted: "€5.00" },
    ]);
  });

  it("10 business + customer come from supplied context / booking snapshot; no business email", () => {
    const data = buildInvoiceData(buildCompletedBooking(), ctx);
    expect(data.business).toEqual({ name: "Soho Vintage Barbers", phone: "+35799000111" });
    expect(data.business).not.toHaveProperty("email");
    expect(data.customer.name).toBe("Dana Klein");
    expect(data.customer.email).toBe("dana@example.com");
  });

  it("11 no VAT / tax fields invented", () => {
    const json = JSON.stringify(buildInvoiceData(buildCompletedBooking(), ctx)).toLowerCase();
    for (const t of ["vat", "tax", "taxpercent", "taxregistration", "companyregistration"]) {
      expect(json).not.toContain(t);
    }
  });

  it("14/17/18/19/20 FULL: venue == balanceDue, totals reconcile, outstanding 0", () => {
    const data = buildInvoiceData(
      withCompletion({
        paid: true,
        amountCents: 2800,
        recordedAt: new Date(),
        recordedBy: new Types.ObjectId(),
      }),
      ctx,
    ).financial;
    expect(data.settlementStatus).toBe("FULL");
    expect(data.settlementLabel).toBe("Paid in full");
    expect(data.upfrontPaidFormatted).toBe("€7.00"); // financials.depositCents
    expect(data.venuePaymentFormatted).toBe("€28.00"); // completionPayment.amountCents
    expect(data.totalPaidFormatted).toBe("€35.00"); // 7 + 28
    expect(data.outstandingFormatted).toBe("€0.00");
    expect(data.show.outstanding).toBe(false);
  });

  it("15/20/21 PARTIAL: outstanding = balanceDue - venuePayment, shown, never negative", () => {
    const data = buildInvoiceData(
      withCompletion({
        paid: true,
        amountCents: 1000,
        recordedAt: new Date(),
        recordedBy: new Types.ObjectId(),
      }),
      ctx,
    ).financial;
    expect(data.settlementStatus).toBe("PARTIAL");
    expect(data.settlementLabel).toBe("Partially paid");
    expect(data.venuePaymentFormatted).toBe("€10.00");
    expect(data.totalPaidFormatted).toBe("€17.00"); // 7 + 10
    expect(data.outstandingFormatted).toBe("€18.00"); // 28 - 10
    expect(data.show.outstanding).toBe(true);
  });

  it("16/20 NOT_PAID: nothing at venue, full balance outstanding", () => {
    const data = buildInvoiceData(
      withCompletion({ paid: false, recordedAt: new Date(), recordedBy: new Types.ObjectId() }),
      ctx,
    ).financial;
    expect(data.settlementStatus).toBe("NOT_PAID");
    expect(data.settlementLabel).toBe("Not paid at venue");
    expect(data.venuePaymentFormatted).toBe("€0.00");
    expect(data.show.venuePayment).toBe(false);
    expect(data.totalPaidFormatted).toBe("€7.00");
    expect(data.outstandingFormatted).toBe("€28.00");
    expect(data.show.outstanding).toBe(true);
  });

  it("NOT_RECORDED: completion with no venuePayment answer", () => {
    const data = buildInvoiceData(withCompletion(undefined), ctx).financial;
    expect(data.settlementStatus).toBe("NOT_RECORDED");
    expect(data.settlementLabel).toBe("Venue payment not recorded");
    expect(data.outstandingFormatted).toBe("€28.00");
  });

  it("promo booking: paid-online is the real charge, promo discount shown, reconciles", () => {
    const booking = buildCompletedBooking({
      promo: {
        promoId: new Types.ObjectId(),
        code: "WELCOME",
        type: "FIXED",
        value: 300,
        discountCents: 300,
        chargeCents: 400,
        fundingOwner: "BOOKLY",
        appliedAt: new Date(),
      } as never,
    });
    const f = buildInvoiceData(booking, ctx).financial;
    expect(f.upfrontPaidFormatted).toBe("€4.00"); // promo.chargeCents
    expect(f.promoDiscountFormatted).toBe("€3.00");
    expect(f.show.promoDiscount).toBe(true);
    expect(f.totalPaidFormatted).toBe("€32.00"); // 4 + 28
    // FULL venue settlement -> nothing still owed at the venue
    expect(f.outstandingFormatted).toBe("€0.00");
  });

  it("FULL with a zero venue balance (deposit covered everything)", () => {
    const booking = buildCompletedBooking({
      financials: {
        currency: "EUR",
        servicesSubtotalCents: 700,
        addonsSubtotalCents: 0,
        serviceDiscountCents: 0,
        travelFeeCents: 0,
        eligiblePlatformFeeBasisCents: 700,
        platformFeeCents: 700,
        depositCents: 700,
        balanceDueCents: 0,
        totalCents: 700,
      } as never,
      completionPayment: {
        paid: true,
        recordedAt: new Date(),
        recordedBy: new Types.ObjectId(),
      } as never,
    });
    const f = buildInvoiceData(booking, ctx).financial;
    expect(f.settlementStatus).toBe("FULL");
    expect(f.outstandingFormatted).toBe("€0.00");
    expect(f.show.venuePayment).toBe(false);
  });
});
