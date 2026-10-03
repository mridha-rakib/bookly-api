import { describe, expect, it, vi } from "vitest";

import type { BookingRepository } from "../../src/modules/booking/booking.repository.js";
import type { PaymentGateway } from "../../src/modules/payment/payment.types.js";
import type { ParsedPaymentIntentMetadata } from "../../src/modules/payment/payment-intent-metadata.js";
import { PaymentTaxAssociationReconciler } from "../../src/modules/payment/payment-tax-association-reconciler.js";

const metadata: ParsedPaymentIntentMetadata = {
  version: "c3-prep-v1",
  taxMode: "VAT_INCLUSIVE",
  bookingId: "0123456789abcdef01234567",
  businessId: "1123456789abcdef01234567",
  businessClientId: "2123456789abcdef01234567",
  purpose: "BOOKING_DEPOSIT",
  preTaxChargeCents: 2000,
  taxCents: 380,
  chargedAmountCents: 2380,
  taxCalculationId: "taxcalc_test_1",
};

const gateway = (association: Awaited<ReturnType<PaymentGateway["findTaxAssociation"]>>) =>
  ({ findTaxAssociation: vi.fn(async () => association) }) as unknown as PaymentGateway;

describe("PaymentTaxAssociationReconciler", () => {
  it("keeps missing eventual Stripe association retryable", async () => {
    const reconciler = new PaymentTaxAssociationReconciler(gateway(null), {} as BookingRepository);
    await expect(reconciler.reconcile("pi_test_1", metadata)).resolves.toEqual({
      status: "pending",
      reason: "Stripe Tax Association is not available yet",
    });
  });

  it("persists a committed association exactly through the matching snapshot guard", async () => {
    const setTaxTransactionIdIfMatching = vi.fn(async () => ({ _id: "booking" }));
    const reconciler = new PaymentTaxAssociationReconciler(
      gateway({ taxCalculationId: "taxcalc_test_1", taxTransactionId: "tax_txn_1" }),
      { setTaxTransactionIdIfMatching } as unknown as BookingRepository,
    );

    await expect(reconciler.reconcile("pi_test_1", metadata)).resolves.toEqual({
      status: "completed",
    });
    expect(setTaxTransactionIdIfMatching).toHaveBeenCalledWith({
      bookingId: metadata.bookingId,
      businessId: metadata.businessId,
      paymentIntentId: "pi_test_1",
      taxCalculationId: "taxcalc_test_1",
      taxTransactionId: "tax_txn_1",
    });
  });

  it("escalates a terminal Stripe Tax attempt without blind retry", async () => {
    const reconciler = new PaymentTaxAssociationReconciler(
      gateway({ taxCalculationId: "taxcalc_test_1", terminalErrorReason: "currency_mismatch" }),
      {} as BookingRepository,
    );
    await expect(reconciler.reconcile("pi_test_1", metadata)).resolves.toMatchObject({
      status: "investigation",
    });
  });
});
