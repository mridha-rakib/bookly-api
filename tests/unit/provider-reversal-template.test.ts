import { describe, expect, it } from "vitest";

import {
  isEmailTemplateRegistered,
  renderEmailTemplate,
} from "../../src/modules/email/template-registry.js";
import type {
  FinanceSupportAlertKind,
  ProviderReversalBusinessKind,
} from "../../src/modules/email/templates/finance/provider-reversal.template.js";

const BUSINESS_KINDS: ProviderReversalBusinessKind[] = [
  "DISPUTE_OPENED",
  "DISPUTE_FUNDS_WITHDRAWN",
  "DISPUTE_FUNDS_REINSTATED",
  "DISPUTE_WON",
  "DISPUTE_LOST",
  "EXTERNAL_REFUND",
];

const SUPPORT_KINDS: FinanceSupportAlertKind[] = [
  "DISPUTE_NEW",
  "DISPUTE_INVESTIGATION",
  "DISPUTE_RECONCILIATION_REQUIRED",
  "EXTERNAL_REFUND",
  "EXTERNAL_REFUND_INVESTIGATION",
  "WEBHOOK_FAILED",
];

describe("P6 provider-reversal email templates", () => {
  it("both templates are registered on the outbox", () => {
    expect(isEmailTemplateRegistered("PROVIDER_REVERSAL_BUSINESS")).toBe(true);
    expect(isEmailTemplateRegistered("FINANCE_SUPPORT_ALERT")).toBe(true);
  });

  it.each(BUSINESS_KINDS)("Business %s copy is truthful and never promises an outcome", (kind) => {
    const email = renderEmailTemplate("PROVIDER_REVERSAL_BUSINESS", {
      kind,
      businessName: "Salon",
      amountFormatted: "€20.00",
      bookingReference: "BK-123",
      providerReference: "dp_1",
    });
    expect(email.subject).toContain("BK-123");
    expect(email.text).toContain("BK-123");
    expect(email.html.length).toBeGreaterThan(0);
    expect(email.text.toLowerCase()).not.toMatch(/will be (won|refunded|returned)|guarantee/);
    if (kind !== "DISPUTE_WON" && kind !== "DISPUTE_LOST") expect(email.text).toContain("€20.00");
  });

  it("an opened dispute says the outcome is not decided; a withdrawal is not a verdict", () => {
    const render = (kind: ProviderReversalBusinessKind) =>
      renderEmailTemplate("PROVIDER_REVERSAL_BUSINESS", {
        kind,
        businessName: "Salon",
        amountFormatted: "€20.00",
        bookingReference: "BK-1",
        providerReference: "dp_1",
      }).text;
    expect(render("DISPUTE_OPENED")).toContain("not decided");
    expect(render("DISPUTE_FUNDS_WITHDRAWN")).toContain(
      "does not by itself mean the dispute is decided",
    );
    expect(render("EXTERNAL_REFUND")).not.toMatch(/cancel/i); // never a business-cancellation refund
  });

  it.each(SUPPORT_KINDS)(
    "support %s alert carries the provider facts and keeps evidence in Stripe",
    (kind) => {
      const email = renderEmailTemplate("FINANCE_SUPPORT_ALERT", {
        kind,
        providerReference: "dp_1",
        amountFormatted: "€20.00",
        businessId: "b1",
        bookingId: "k1",
        detail: "owner=BUSINESS",
      });
      expect(email.subject).toMatch(/^\[Finance\] .* — dp_1$/);
      for (const fact of ["dp_1", "€20.00", "b1", "k1", "owner=BUSINESS"]) {
        expect(email.text).toContain(fact);
      }
      expect(email.text).toContain("Stripe Dashboard");
    },
  );
});
