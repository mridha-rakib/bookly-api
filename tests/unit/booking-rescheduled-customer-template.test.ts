import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import {
  isEmailTemplateRegistered,
  renderEmailTemplate,
} from "../../src/modules/email/template-registry.js";
import {
  buildBookingRescheduledEmailData,
  renderBookingRescheduledCustomerEmail,
} from "../../src/modules/email/templates/booking/booking-rescheduled-customer.template.js";

/**
 * CUSTOMER RESCHEDULE CONFIRMATION EMAIL — template coverage. Shows both the previous and the
 * new appointment (formatted in the venue timezone), actor-aware wording, a manage link only for
 * a linked account, and never any payment / OTP / internal-staff data.
 */

const bookingBase = {
  _id: new Types.ObjectId(),
  reference: "BK-9F3K2Q",
  schedule: {
    // 13:30 UTC == 16:30 in Europe/Nicosia (UTC+3 in September)
    startAt: new Date("2026-09-08T13:30:00.000Z"),
    endAt: new Date("2026-09-08T14:15:00.000Z"),
    timezone: "Europe/Nicosia",
  },
  customer: {
    customerUserId: new Types.ObjectId(),
    contact: { firstName: "Jane", lastName: "Doe", normalizedEmail: "jane@example.com" },
  },
  serviceLines: [{ serviceSnapshot: { name: "Deep Tissue Massage", durationMin: 45 } }],
  fulfilment: {
    mode: "AT_BUSINESS_LOCATION",
    businessLocation: {
      streetNumber: "12",
      streetName: "Makariou Ave",
      area: "Centre",
      city: "NICOSIA",
    },
  },
  rescheduleHistory: [
    {
      actorUserId: new Types.ObjectId(),
      actorRole: "CUSTOMER",
      previousStart: new Date("2026-09-05T09:00:00.000Z"), // 12:00 Nicosia
      previousEnd: new Date("2026-09-05T09:45:00.000Z"),
      newStart: new Date("2026-09-08T13:30:00.000Z"),
      newEnd: new Date("2026-09-08T14:15:00.000Z"),
      countedTowardCustomerQuota: true,
      createdAt: new Date(),
    },
  ],
} as never;

const withActor = (actorRole: string, linked = true) =>
  ({
    ...(bookingBase as Record<string, unknown>),
    customer: linked
      ? (bookingBase as { customer: unknown }).customer
      : { contact: { firstName: "Jane", normalizedEmail: "jane@example.com" } },
    rescheduleHistory: [
      {
        ...(bookingBase as { rescheduleHistory: Array<Record<string, unknown>> })
          .rescheduleHistory[0],
        actorRole,
      },
    ],
  }) as never;

describe("BOOKING_RESCHEDULED_CUSTOMER template", () => {
  it("payload carries both times in the venue timezone, not UTC/browser", () => {
    const data = buildBookingRescheduledEmailData(bookingBase, { businessName: "Glow Studio" });
    expect(data.previousTime).toBe("12:00");
    expect(data.newTime).toBe("16:30");
    expect(data.venueTimezone).toBe("Europe/Nicosia");
    expect(data.durationMin).toBe(45);
    expect(data.rescheduledByBusiness).toBe(false);
    expect(data.customerBookingUrlPath).toContain("/customer/bookings/view?id=");
  });

  it("renders greeting, business, reference, previous + new time, services, timezone note", () => {
    const data = buildBookingRescheduledEmailData(bookingBase, { businessName: "Glow Studio" });
    const email = renderBookingRescheduledCustomerEmail(data);

    expect(email.subject).toBe("Your appointment has been rescheduled");
    for (const needle of [
      "Jane",
      "Glow Studio",
      "BK-9F3K2Q",
      "12:00",
      "16:30",
      "Deep Tissue Massage",
      "Europe/Nicosia",
    ]) {
      expect(email.html).toContain(needle);
      expect(email.text).toContain(needle);
    }
    // branded shell
    expect(email.html).toContain("cid:bookly-wordmark");
    expect(email.html).toContain("Privacy Policy");
    expect(email.text).not.toMatch(/undefined|NaN|\[object Object\]/);
  });

  it("actor-aware wording: customer vs business", () => {
    const customerCopy = renderBookingRescheduledCustomerEmail(
      buildBookingRescheduledEmailData(withActor("CUSTOMER"), { businessName: "Glow Studio" }),
    );
    expect(`${customerCopy.html}${customerCopy.text}`).toContain(
      "You've rescheduled your appointment",
    );

    const businessCopy = renderBookingRescheduledCustomerEmail(
      buildBookingRescheduledEmailData(withActor("BUSINESS_OWNER"), {
        businessName: "Glow Studio",
      }),
    );
    expect(`${businessCopy.html}${businessCopy.text}`).toContain(
      "Glow Studio has moved your appointment",
    );
  });

  it("manage CTA only for a linked customer account", () => {
    const linked = renderBookingRescheduledCustomerEmail(
      buildBookingRescheduledEmailData(withActor("CUSTOMER", true), {
        businessName: "Glow Studio",
      }),
    );
    expect(linked.html).toContain("/customer/bookings/view?id=");
    expect(linked.html.toLowerCase()).toContain("view your booking");

    const unlinked = renderBookingRescheduledCustomerEmail(
      buildBookingRescheduledEmailData(withActor("BUSINESS_OWNER", false), {
        businessName: "Glow Studio",
      }),
    );
    expect(unlinked.html).not.toContain("/customer/bookings/view");
    expect(unlinked.html.toLowerCase()).not.toContain("view your booking");
  });

  it("carries NO payment data, tokens, or internal staff identity", () => {
    const email = renderBookingRescheduledCustomerEmail(
      buildBookingRescheduledEmailData(bookingBase, { businessName: "Glow Studio" }),
    );
    const haystack = `${email.html}\n${email.text}`.toLowerCase();
    for (const forbidden of [
      "deposit",
      "balance",
      "refund",
      "€",
      "token=",
      "otp",
      "reservationid",
    ]) {
      expect(haystack).not.toContain(forbidden);
    }
  });

  it("escapes HTML metacharacters in dynamic values", () => {
    const data = buildBookingRescheduledEmailData(bookingBase, {
      businessName: "A <script>alert(1)</script>",
    });
    const email = renderBookingRescheduledCustomerEmail(data);
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("is wired into the shared template registry", () => {
    expect(isEmailTemplateRegistered("BOOKING_RESCHEDULED_CUSTOMER")).toBe(true);
    const data = buildBookingRescheduledEmailData(bookingBase, { businessName: "Glow Studio" });
    expect(() => renderEmailTemplate("BOOKING_RESCHEDULED_CUSTOMER", data)).not.toThrow();
  });
});
