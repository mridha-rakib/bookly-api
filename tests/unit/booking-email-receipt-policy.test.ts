import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import type { BookingDocument } from "../../src/modules/booking/booking.model.js";
import { renderBookingCustomerConfirmedEmail } from "../../src/modules/email/templates/booking/booking-customer-confirmed.template.js";
import {
  type BookingEmailOnlinePayment,
  buildBookingEmailData,
  formatDateTimeWithZone,
} from "../../src/modules/email/templates/booking/booking-email-data.js";
import { renderBookingForClientConfirmedEmail } from "../../src/modules/email/templates/booking/booking-for-client-confirmed.template.js";
import { renderBookingOwnerNewBookingEmail } from "../../src/modules/email/templates/booking/booking-owner-new-booking.template.js";
import { buildBooking } from "./stage-b-fixtures.js";

/**
 * F4A Tier 3 — confirmation payment wording, receipt section and agreed-policy disclosure.
 * Synthetic Booking fixtures only; nothing is sent.
 */

const HOUR = 60 * 60 * 1000;
// 10:00 Nicosia on Tuesday 10 November 2026 (UTC+2 in November).
const START = new Date("2026-11-10T08:00:00.000Z");

const policyBooking = (overrides: Partial<BookingDocument> = {}): BookingDocument =>
  buildBooking({
    schedule: {
      timezone: "Europe/Nicosia",
      startAt: START,
      endAt: new Date(START.getTime() + HOUR),
    },
    createdAt: new Date(START.getTime() - 10 * 24 * HOUR),
    cancellationPolicySnapshot: {
      tiers: [
        { tier: "MORE_THAN_72_HOURS", mode: "FREE" },
        { tier: "BETWEEN_24_AND_72_HOURS", mode: "PERCENTAGE", percentage: 20 },
        { tier: "BETWEEN_12_AND_24_HOURS", mode: "PERCENTAGE", percentage: 50 },
        { tier: "BETWEEN_2_AND_12_HOURS", mode: "PERCENTAGE", percentage: 80 },
        { tier: "UNDER_2_HOURS", mode: "PERCENTAGE", percentage: 100 },
      ],
      noShowPercentage: 30,
    },
    ...overrides,
  } as Partial<BookingDocument>);

const data = (booking: BookingDocument, onlinePayment?: BookingEmailOnlinePayment) =>
  buildBookingEmailData(booking, {
    businessName: "Soho Vintage Barbers",
    includeCustomerBookingLink: false,
    ...(onlinePayment ? { onlinePayment } : {}),
  });

const PAID: BookingEmailOnlinePayment = {
  kind: "PAID",
  amountFormatted: "€7.00",
  paidAt: "Tuesday 3 November 2026 at 09:12 (Europe/Nicosia)",
  paymentReference: "pi_synthetic_123",
  paymentFor: "BOOKING",
};

describe("policy disclosure from the Booking's own snapshot", () => {
  it("14/15/17 lists every window with its business-timezone deadline and the snapshot fee", () => {
    const policy = data(policyBooking()).policyDisclosure;
    // Deadlines are exact instants before the start (72/24/12/2 h), shown in the Booking's zone.
    const at = (hours: number) =>
      formatDateTimeWithZone(new Date(START.getTime() - hours * HOUR), "Europe/Nicosia");

    expect(at(72)).toContain("10:00 (Europe/Nicosia)");
    expect(at(12)).toContain("22:00 (Europe/Nicosia)");
    expect(at(72)).toMatch(/Saturday,? 7 November 2026/);
    expect(policy?.windows).toEqual([
      { label: `Cancel by ${at(72)}`, fee: "No fee" },
      { label: `Cancel between ${at(72)} and ${at(24)}`, fee: "20% of €35.00" },
      { label: `Cancel between ${at(24)} and ${at(12)}`, fee: "50% of €35.00" },
      { label: `Cancel between ${at(12)} and ${at(2)}`, fee: "80% of €35.00" },
      { label: `Cancel after ${at(2)}`, fee: "100% of €35.00" },
    ]);
    expect(policy?.noShow).toBe("30% of €35.00");
    expect(policy?.upfrontCountsTowardsFee).toBe(true);
  });

  it("17 windows that had already ended when the Booking was created are omitted", () => {
    const policy = data(
      policyBooking({ createdAt: new Date(START.getTime() - 10 * HOUR) }),
    ).policyDisclosure;
    expect(policy?.windows.map((w) => w.fee)).toEqual(["80% of €35.00", "100% of €35.00"]);
  });

  it("a window without a snapshot rule is free, exactly like the cancellation classifier", () => {
    const booking = policyBooking({
      cancellationPolicySnapshot: { tiers: [], noShowPercentage: 30 },
    });
    expect(data(booking).policyDisclosure?.windows.every((w) => w.fee === "No fee")).toBe(true);
  });

  it("18 package-linked: late cancellation and no-show forfeit the session, no percentage fee", () => {
    const base = policyBooking();
    const booking = policyBooking({
      serviceLines: base.serviceLines.map((line) => ({
        ...line,
        pricingInput: {
          packageProgressId: new Types.ObjectId(),
          sessionsInPackage: 5,
          sessionIndex: 2,
        },
      })),
    });
    const result = data(booking);

    expect(result.policyDisclosure?.windows.slice(1).every((w) => /forfeited/.test(w.fee))).toBe(
      true,
    );
    expect(result.policyDisclosure?.noShow).toMatch(/forfeits the package session/);
    expect(result.policyDisclosure?.upfrontCountsTowardsFee).toBe(false);
    expect(result.serviceLines[0]?.quantityLabel).toBe("Package session 2 of 5");
  });

  it("16 no snapshot: states what the fee functions compute — no fee", () => {
    const booking = policyBooking({ cancellationPolicySnapshot: undefined });
    const text = renderBookingCustomerConfirmedEmail(data(booking)).text;
    expect(text).toContain("No cancellation or no-show fee applies to this booking.");
  });

  it("15 no longer presents the no-show percentage as the late-cancellation fee", () => {
    const renderers = [renderBookingCustomerConfirmedEmail, renderBookingForClientConfirmedEmail];
    for (const render of renderers) {
      const email = render(data(policyBooking()));
      expect(email.text).not.toContain("A late cancellation or no-show may be charged");
      expect(email.text).toContain("Cancellation and no-show policy");
      expect(email.text).toContain("No-show: 30% of €35.00");
      expect(email.html).toContain("Cancellation and no-show policy");
    }
  });
});

describe("paid / unpaid / unverified wording", () => {
  it("6/11 PAID: receipt section with amount, provider time, reference — customer only", () => {
    const customer = renderBookingCustomerConfirmedEmail(data(policyBooking(), PAID));
    expect(customer.text).toContain("Payment receipt");
    expect(customer.text).toContain("Amount paid: €7.00");
    expect(customer.text).toContain("Paid on: Tuesday 3 November 2026 at 09:12 (Europe/Nicosia)");
    expect(customer.text).toContain("Payment reference: pi_synthetic_123");
    expect(customer.text).toContain("Paid online: €7.00");
    expect(customer.text).not.toContain("Paid online now");

    const owner = renderBookingOwnerNewBookingEmail(data(policyBooking(), PAID));
    expect(owner.text).not.toContain("Payment receipt");
    expect(owner.text).toContain("Paid online: €7.00");
  });

  it("7 NONE: no receipt, and says nothing was taken online", () => {
    const text = renderBookingCustomerConfirmedEmail(data(policyBooking(), { kind: "NONE" })).text;
    expect(text).not.toContain("Payment receipt");
    expect(text).toContain("Paid online: Nothing — no upfront payment was taken");
  });

  it("8/9/10 UNVERIFIED: never shown as paid — no paid line, no receipt", () => {
    const text = renderBookingCustomerConfirmedEmail(
      data(policyBooking(), { kind: "UNVERIFIED" }),
    ).text;
    expect(text).not.toContain("Payment receipt");
    expect(text).not.toMatch(/Paid online/);
  });

  it("legacy callers (no evidence supplied) keep the previous row unchanged", () => {
    const text = renderBookingCustomerConfirmedEmail(data(policyBooking())).text;
    expect(text).toContain("Paid online now: €7.00");
    expect(text).not.toContain("Payment receipt");
  });

  it("12/13 no VAT, tax or card data is ever invented", () => {
    const email = renderBookingCustomerConfirmedEmail(data(policyBooking(), PAID));
    expect(`${email.text}\n${email.html}`).not.toMatch(/\bVAT\b|\btax\b|card ending|\*\*\*\*/i);
  });

  it("17 shows the appointment time zone and booked quantities", () => {
    const base = policyBooking();
    const booking = policyBooking({
      serviceLines: base.serviceLines.map((line) => ({
        ...line,
        pricingInput: { hours: 2, personCount: 3 },
      })),
    });
    const text = renderBookingCustomerConfirmedEmail(data(booking)).text;
    expect(text).toContain("Time zone: Europe/Nicosia");
    expect(text).toContain("2 hours, 3 people");
  });

  it("escapes untrusted text in the new sections", () => {
    const booking = policyBooking({ reference: "<b>BK</b>" } as Partial<BookingDocument>);
    const html = renderBookingCustomerConfirmedEmail(data(booking, PAID)).html;
    expect(html).not.toContain("<b>BK</b>");
    expect(html).toContain("&lt;b&gt;BK&lt;/b&gt;");
  });
});
