import { describe, expect, it } from "vitest";
import type { BookingDocument } from "../../src/modules/booking/booking.model.js";
import {
  buildCancellationOutcome,
  classifyNormalCancellationTier,
} from "../../src/modules/booking/booking-cancellation-classification.js";
import { buildBookingEmailData } from "../../src/modules/email/templates/booking/booking-email-data.js";
import { buildBooking } from "./stage-b-fixtures.js";

/** Approved Normal Booking cancellation terms v2 (2026-11-05). Synthetic data only. */
const HOUR = 60 * 60 * 1000;
const START = new Date("2026-11-10T08:00:00.000Z");
const v2Snapshot = {
  tiers: [
    { tier: "BETWEEN_12_AND_24_HOURS" as const, mode: "PERCENTAGE" as const, percentage: 40 },
    { tier: "BETWEEN_2_AND_12_HOURS" as const, mode: "PERCENTAGE" as const, percentage: 60 },
    { tier: "UNDER_2_HOURS" as const, mode: "PERCENTAGE" as const, percentage: 80 },
  ],
  noShowPercentage: 90,
};
const outcomeAt = (hoursBefore: number, termsVersion?: 2, deposit = 1_600) =>
  buildCancellationOutcome({
    scheduledStartAt: START,
    now: new Date(START.getTime() - hoursBefore * HOUR),
    policySnapshot: termsVersion
      ? v2Snapshot
      : {
          tiers: [
            { tier: "MORE_THAN_72_HOURS", mode: "FREE" },
            { tier: "BETWEEN_24_AND_72_HOURS", mode: "PERCENTAGE", percentage: 20 },
            ...v2Snapshot.tiers,
          ],
          noShowPercentage: 90,
        },
    eligiblePlatformFeeBasisCents: 8_000,
    depositAlreadyPaidCents: deposit,
    termsVersion,
  });

describe("v2 classification", () => {
  it("uses the four approved windows; exactly 24 hours ahead is still free", () => {
    expect(classifyNormalCancellationTier(100)).toBe("MORE_THAN_24_HOURS");
    expect(classifyNormalCancellationTier(24)).toBe("MORE_THAN_24_HOURS");
    expect(classifyNormalCancellationTier(23.99)).toBe("BETWEEN_12_AND_24_HOURS");
    expect(classifyNormalCancellationTier(12)).toBe("BETWEEN_12_AND_24_HOURS");
    expect(classifyNormalCancellationTier(11.99)).toBe("BETWEEN_2_AND_12_HOURS");
    expect(classifyNormalCancellationTier(2)).toBe("BETWEEN_2_AND_12_HOURS");
    expect(classifyNormalCancellationTier(1.99)).toBe("UNDER_2_HOURS");
  });

  it("more than 24 hours: no fee and the deposit actually paid is owed back", () => {
    expect(outcomeAt(30, 2)).toMatchObject({
      tier: "MORE_THAN_24_HOURS",
      feeMode: "FREE",
      cancellationFeeCents: 0,
      refundOwedCents: 1_600,
      settlementStatus: "PENDING",
    });
    expect(outcomeAt(30, 2, 0)).toMatchObject({
      refundOwedCents: 0,
      settlementStatus: "NOT_APPLICABLE",
    });
  });

  it("later windows use the Business rate, net against the deposit and refund nothing", () => {
    expect(outcomeAt(18, 2)).toMatchObject({
      tier: "BETWEEN_12_AND_24_HOURS",
      feePercentage: 40,
      cancellationFeeCents: 3_200,
      depositAppliedCents: 1_600,
      additionalChargeCents: 1_600,
      refundOwedCents: 0,
    });
    expect(outcomeAt(1, 2)).toMatchObject({
      tier: "UNDER_2_HOURS",
      feePercentage: 80,
      cancellationFeeCents: 6_400,
      refundOwedCents: 0,
    });
  });

  it("an unconfigured fee window charges nothing and never invents a rate", () => {
    const outcome = buildCancellationOutcome({
      scheduledStartAt: START,
      now: new Date(START.getTime() - 5 * HOUR),
      policySnapshot: undefined,
      eligiblePlatformFeeBasisCents: 8_000,
      depositAlreadyPaidCents: 1_600,
      termsVersion: 2,
    });
    expect(outcome).toMatchObject({
      tier: "BETWEEN_2_AND_12_HOURS",
      feeMode: "FREE",
      cancellationFeeCents: 0,
      refundOwedCents: 0,
    });
  });

  it("a Booking without a terms version keeps its five-window contract", () => {
    expect(outcomeAt(30)).toMatchObject({
      tier: "BETWEEN_24_AND_72_HOURS",
      feePercentage: 20,
      refundOwedCents: 0,
    });
    expect(outcomeAt(100)).toMatchObject({
      tier: "MORE_THAN_72_HOURS",
      feeMode: "FREE",
      refundOwedCents: 0,
    });
  });
});

describe("v2 confirmation email disclosure", () => {
  const booking = (overrides: Partial<BookingDocument>) =>
    buildBooking({
      schedule: {
        timezone: "Europe/Nicosia",
        startAt: START,
        endAt: new Date(START.getTime() + HOUR),
      },
      createdAt: new Date(START.getTime() - 10 * 24 * HOUR),
      cancellationPolicySnapshot: v2Snapshot,
      cancellationTermsVersion: 2,
      ...overrides,
    } as Partial<BookingDocument>);
  const disclosure = (b: BookingDocument) =>
    buildBookingEmailData(b, { businessName: "Aurelia", includeCustomerBookingLink: false })
      .policyDisclosure;

  it("lists the four approved windows with the deposit refund in the first", () => {
    const base = booking({});
    const result = disclosure(booking({ financials: { ...base.financials, depositCents: 1_600 } }));
    expect(result?.windows).toHaveLength(4);
    expect(result?.windows[0]?.fee).toBe("No fee; the €16.00 paid online is refunded in full");
    expect(result?.windows.slice(1).map((window) => window.fee)).toEqual([
      expect.stringMatching(/^40% of /),
      expect.stringMatching(/^60% of /),
      expect.stringMatching(/^80% of /),
    ]);
    expect(result?.noShow).toMatch(/^90% of /);
  });

  it("older Bookings keep their five-window email disclosure", () => {
    const result = disclosure(
      booking({
        cancellationTermsVersion: undefined,
        cancellationPolicySnapshot: {
          tiers: [
            { tier: "MORE_THAN_72_HOURS", mode: "FREE" },
            { tier: "BETWEEN_24_AND_72_HOURS", mode: "PERCENTAGE", percentage: 20 },
            ...v2Snapshot.tiers,
          ],
          noShowPercentage: 90,
        },
      }),
    );
    expect(result?.windows).toHaveLength(5);
    expect(result?.windows.some((window) => window.fee.includes("refunded"))).toBe(false);
  });
});

describe("v2 exact boundaries (absolute instants)", () => {
  const at = (msBefore: number) =>
    buildCancellationOutcome({
      scheduledStartAt: START,
      now: new Date(START.getTime() - msBefore),
      policySnapshot: v2Snapshot,
      eligiblePlatformFeeBasisCents: 8_000,
      depositAlreadyPaidCents: 1_600,
      termsVersion: 2,
    });
  it.each([
    [24 * HOUR, "MORE_THAN_24_HOURS", 1_600],
    [24 * HOUR - 1, "BETWEEN_12_AND_24_HOURS", 0],
    [12 * HOUR, "BETWEEN_12_AND_24_HOURS", 0],
    [12 * HOUR - 1, "BETWEEN_2_AND_12_HOURS", 0],
    [2 * HOUR, "BETWEEN_2_AND_12_HOURS", 0],
    [2 * HOUR - 1, "UNDER_2_HOURS", 0],
    [0, "UNDER_2_HOURS", 0],
  ] as const)("%i ms before the start is %s with refund %i", (msBefore, tier, refund) => {
    expect(at(msBefore)).toMatchObject({ tier, refundOwedCents: refund });
  });
});

describe("refund completed email", () => {
  it("states the confirmed amount, currency, booking and Business without card details", async () => {
    const { renderBookingRefundCompletedCustomerEmail } = await import(
      "../../src/modules/email/templates/booking/booking-refund-completed-customer.template.js"
    );
    const { buildCancellationEmailData } = await import(
      "../../src/modules/email/templates/booking/cancellation-email-data.js"
    );
    const booking = buildBooking({
      schedule: {
        timezone: "Europe/Nicosia",
        startAt: START,
        endAt: new Date(START.getTime() + HOUR),
      },
    } as Partial<BookingDocument>);
    const email = renderBookingRefundCompletedCustomerEmail(
      buildCancellationEmailData(booking, {
        businessName: "Aurelia",
        cancelledBy: "CUSTOMER",
        refundOverride: { succeeded: true, amountCents: 1_600, status: "SUCCEEDED" },
      }),
    );
    expect(email.subject).toBe("Your refund has been processed");
    expect(email.text).toContain(
      `Your refund of €16.00 (EUR) for booking ${booking.reference} with Aurelia has been processed.`,
    );
    expect(email.text).not.toMatch(/\b\d{4}\b.*card|last4|•••/i);
  });
});
