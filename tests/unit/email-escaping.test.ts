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
 * FINAL QA — Phase X: adversarial escaping. Every dynamic string that reaches HTML must render
 * as TEXT, never as executable/raw markup. Escaping happens at the render boundary only —
 * persisted domain data is never mutated.
 */

const EVIL = "<script>alert(1)</script>";
const EVIL2 = "Tom & Jerry <Premium> \"x\" 'y'";

const evilBooking = (over: Partial<BookingDocument> = {}): BookingDocument =>
  buildBooking({
    customer: {
      businessClientId: new Types.ObjectId(),
      customerUserId: new Types.ObjectId(),
      contact: {
        firstName: EVIL,
        lastName: EVIL2,
        normalizedEmail: "dana@example.com",
        phone: { countryCode: "+357", nationalNumber: "1", e164: "+3571" },
      },
    } as never,
    fulfilment: {
      mode: "AT_BUSINESS_LOCATION",
      businessLocation: {
        city: EVIL2,
        area: EVIL,
        streetName: EVIL2,
        streetNumber: "1",
      },
    } as never,
    serviceLines: [
      {
        serviceId: new Types.ObjectId(),
        serviceSnapshot: { name: EVIL, pricingMode: "FIXED", durationMin: 30 },
        pricingInput: {},
        responsibleStaffMembershipId: new Types.ObjectId(),
        staffSnapshot: { firstName: EVIL2, lastName: EVIL },
        addons: [{ addonId: new Types.ObjectId(), name: EVIL, priceCents: 500 }],
        amountCents: 3000,
        reservationId: new Types.ObjectId(),
      },
    ] as never,
    ...over,
  });

const assertNoRawMarkup = (html: string): void => {
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).not.toContain("<Premium>");
  // the escaped forms MUST be what appears instead
  expect(html).toContain("&lt;script&gt;");
};

const BIZ = { businessName: EVIL, includeCustomerBookingLink: true } as const;

describe("email templates escape all dynamic content (Phase X)", () => {
  it("OTP", () => {
    assertNoRawMarkup(
      renderEmailTemplate("OTP_VERIFICATION", { code: EVIL, expiryMinutes: 10 }).html,
    );
  });

  it("CLIENT_CREATED", () => {
    assertNoRawMarkup(
      renderEmailTemplate("CLIENT_CREATED", { clientFirstName: EVIL, businessName: EVIL2 }).html,
    );
  });

  it("booking creation templates (customer / owner / for-client / staff-created)", () => {
    const data = buildBookingEmailData(evilBooking(), BIZ);
    assertNoRawMarkup(renderEmailTemplate("BOOKING_CUSTOMER_CONFIRMED", data).html);
    assertNoRawMarkup(renderEmailTemplate("BOOKING_OWNER_NEW_BOOKING", data).html);
    assertNoRawMarkup(renderEmailTemplate("BOOKING_FOR_CLIENT_CONFIRMED", data).html);
    assertNoRawMarkup(
      renderEmailTemplate("BOOKING_STAFF_CREATED_NOTIFICATION", {
        ...data,
        createdByLabel: `${EVIL} created a booking`,
      }).html,
    );
  });

  it("BOOKING_COMPLETED (email body + invoice summary)", () => {
    const invoice = buildInvoiceData(
      evilBooking({
        status: "COMPLETED" as never,
        completionPayment: {
          paid: true,
          amountCents: 2800,
          recordedAt: new Date(),
          recordedBy: new Types.ObjectId(),
        } as never,
      }),
      { businessName: EVIL, businessPhone: EVIL2, businessAddress: `${EVIL}, ${EVIL2}` },
    );
    assertNoRawMarkup(renderEmailTemplate("BOOKING_COMPLETED", { invoice }).html);
  });

  it("cancellation templates (customer + owner)", () => {
    const data = buildCancellationEmailData(
      evilBooking({
        cancellationOutcome: {
          classifiedAt: new Date(),
          tier: "UNDER_2_HOURS",
          feeMode: "PERCENTAGE",
          feePercentage: 50,
          cancellationFeeCents: 1200,
          depositAppliedCents: 800,
          additionalChargeCents: 400,
          refundOwedCents: 0,
          settlementStatus: "SUCCEEDED",
        } as never,
      }),
      { businessName: EVIL, cancelledBy: "CUSTOMER" },
    );
    assertNoRawMarkup(renderEmailTemplate("BOOKING_CANCELLED_CUSTOMER", data).html);
    assertNoRawMarkup(renderEmailTemplate("BOOKING_CANCELLED_OWNER", data).html);
  });

  it("no-show templates (charged / waived / cancelled)", () => {
    const charged = buildNoShowEmailData(evilBooking(), {
      businessName: EVIL,
      outcome: "CHARGED",
      amounts: NO_SHOW_CHARGED_AMOUNTS,
    });
    assertNoRawMarkup(renderEmailTemplate("NO_SHOW_CHARGED", charged).html);
    assertNoRawMarkup(
      renderEmailTemplate("NO_SHOW_WAIVED", { ...charged, outcome: "WAIVED", charged: undefined })
        .html,
    );
    assertNoRawMarkup(
      renderEmailTemplate("NO_SHOW_CANCELLED", {
        ...charged,
        outcome: "CANCELLED",
        charged: undefined,
      }).html,
    );
  });

  it("BUSINESS_REGISTERED", () => {
    assertNoRawMarkup(
      renderEmailTemplate("BUSINESS_REGISTERED", {
        businessId: "b1",
        businessName: EVIL,
        ownerName: EVIL2,
        ownerEmail: "o@example.com",
        phone: EVIL,
        category: EVIL2,
        city: EVIL,
        status: "PENDING",
        registeredAtFormatted: "Sat",
      }).html,
    );
  });
});
