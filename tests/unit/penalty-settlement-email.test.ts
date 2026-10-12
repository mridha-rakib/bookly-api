import { describe, expect, it } from "vitest";
import { renderEmailTemplate } from "../../src/modules/email/template-registry.js";
import { renderBookingCancelledCustomerEmail } from "../../src/modules/email/templates/booking/booking-cancelled-customer.template.js";
import { renderBookingCancelledOwnerEmail } from "../../src/modules/email/templates/booking/booking-cancelled-owner.template.js";
import { buildCancellationEmailData } from "../../src/modules/email/templates/booking/cancellation-email-data.js";
import { buildPenaltySettlementEmailData } from "../../src/modules/email/templates/booking/penalty-settlement-email-data.js";
import {
  isDefinitivePenaltyFailure,
  isPenaltyPurpose,
  parsePenaltyAttemptKey,
  penaltyAttemptKey,
} from "../../src/modules/payment/penalty-attempt.js";
import { buildBooking, buildCancelledBooking } from "./stage-d-fixtures.js";

/** P5 — truthful staged penalty notifications + server-only penalty attempt key namespace. */

const CTX = { businessName: "Soho Vintage Barbers", cancelledBy: "CUSTOMER" as const };

const lateCancel = (settlementStatus: "PENDING" | "SUCCEEDED" | "FAILED" | "WAIVED") =>
  buildCancellationEmailData(
    buildCancelledBooking({
      feeMode: "PERCENTAGE",
      feePercentage: 50,
      cancellationFeeCents: 5000,
      depositAppliedCents: 2000,
      additionalChargeCents: 3000,
      settlementStatus,
    }),
    CTX,
  );

const settlement = (
  kind: "CANCELLATION_FEE" | "NO_SHOW_FEE",
  outcome: "SUCCEEDED" | "FAILED" | "WAIVED",
) =>
  buildPenaltySettlementEmailData(buildBooking(), {
    businessName: "Soho Vintage Barbers",
    kind,
    outcome,
    amountCents: 3000,
  });

describe("P5 cancellation email — staged settlement wording", () => {
  it("PENDING: says fee collection pending, never charged or failed", () => {
    const customer = renderBookingCancelledCustomerEmail(lateCancel("PENDING")).text;
    expect(customer).toContain("Additional amount due: €30.00 — fee collection pending.");
    expect(customer).not.toMatch(/charged|failed/i);
    const owner = renderBookingCancelledOwnerEmail(lateCancel("PENDING")).text;
    expect(owner).toContain("collection of the additional €30.00 is pending");
  });

  it("FAILED: no successful charge confirmed; WAIVED: waived; only SUCCEEDED says charged", () => {
    expect(renderBookingCancelledCustomerEmail(lateCancel("FAILED")).text).toContain(
      "collection failed — no successful charge has been confirmed",
    );
    expect(renderBookingCancelledCustomerEmail(lateCancel("WAIVED")).text).toContain(
      "The additional amount of €30.00 has been waived.",
    );
    expect(renderBookingCancelledOwnerEmail(lateCancel("WAIVED")).text).toContain(
      "the additional €30.00 was waived",
    );
    expect(renderBookingCancelledCustomerEmail(lateCancel("SUCCEEDED")).text).toContain(
      "Additional amount charged: €30.00",
    );
    for (const status of ["PENDING", "FAILED", "WAIVED"] as const) {
      expect(renderBookingCancelledCustomerEmail(lateCancel(status)).text).not.toContain(
        "Additional amount charged",
      );
    }
  });
});

describe("P5 penalty settlement follow-up templates", () => {
  it("cancellation SUCCEEDED / FAILED / WAIVED — customer and owner copy is truthful", () => {
    const succeeded = renderEmailTemplate(
      "PENALTY_SETTLEMENT_CUSTOMER",
      settlement("CANCELLATION_FEE", "SUCCEEDED"),
    );
    expect(succeeded.subject).toBe("Cancellation fee charged");
    expect(succeeded.text).toContain("has been charged to your saved card");

    const failed = renderEmailTemplate(
      "PENALTY_SETTLEMENT_CUSTOMER",
      settlement("CANCELLATION_FEE", "FAILED"),
    );
    expect(failed.text).toContain("No successful charge has been confirmed");
    expect(failed.text).toContain("Your booking remains cancelled.");
    expect(failed.text).not.toMatch(/has been charged|waived|refund/i);

    const waived = renderEmailTemplate(
      "PENALTY_SETTLEMENT_CUSTOMER",
      settlement("CANCELLATION_FEE", "WAIVED"),
    );
    expect(waived.text).toContain("You will not be charged for it");

    const ownerFailed = renderEmailTemplate(
      "PENALTY_SETTLEMENT_OWNER",
      settlement("CANCELLATION_FEE", "FAILED"),
    );
    expect(ownerFailed.subject).toContain("Cancellation fee not collected");
    expect(ownerFailed.text).toContain("will not be retried automatically");
    expect(ownerFailed.text).toContain("You can waive the fee from the booking.");
  });

  it("no-show FAILED: manual resolution, never claims a charge, a waiver or a resolved no-show", () => {
    const customer = renderEmailTemplate(
      "PENALTY_SETTLEMENT_CUSTOMER",
      settlement("NO_SHOW_FEE", "FAILED"),
    );
    expect(customer.subject).toBe("No-show fee not collected");
    expect(customer.text).toContain("awaiting review by Soho Vintage Barbers");
    expect(customer.text).not.toMatch(/has been charged|has waived|refund/i);
    const owner = renderEmailTemplate(
      "PENALTY_SETTLEMENT_OWNER",
      settlement("NO_SHOW_FEE", "FAILED"),
    );
    expect(owner.text).toContain("The no-show remains pending until you resolve it");
  });
});

describe("P5 penalty attempt identity", () => {
  it("keys are derived only from the obligation id and parse back exactly", () => {
    const id = "65f0c0ffee00000000000001";
    expect(penaltyAttemptKey(id)).toBe(`penalty:${id}`);
    expect(parsePenaltyAttemptKey(`penalty:${id}`)).toBe(id);
    expect(parsePenaltyAttemptKey("penalty:not-an-id")).toBeUndefined();
    expect(parsePenaltyAttemptKey(`cancellation-fee:${id}`)).toBeUndefined();
  });

  it("only the existing penalty purposes are penalty purposes; off-session terminal states are definitive", () => {
    expect(isPenaltyPurpose("CANCELLATION_FEE")).toBe(true);
    expect(isPenaltyPurpose("NO_SHOW_FEE")).toBe(true);
    expect(isPenaltyPurpose("BOOKING_DEPOSIT")).toBe(false);
    expect(isPenaltyPurpose(undefined)).toBe(false);
    for (const status of ["FAILED", "CANCELED", "REQUIRES_ACTION"] as const) {
      expect(isDefinitivePenaltyFailure({ providerStatus: status })).toBe(true);
    }
    for (const status of [
      "NOT_CREATED",
      "CREATED",
      "PROCESSING",
      "UNKNOWN",
      "SUCCEEDED",
    ] as const) {
      expect(isDefinitivePenaltyFailure({ providerStatus: status })).toBe(false);
    }
  });
});
