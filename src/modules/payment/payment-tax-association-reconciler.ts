import type { BookingRepository } from "../booking/booking.repository.js";
import type { PaymentGateway } from "./payment.types.js";
import type { ParsedPaymentIntentMetadata } from "./payment-intent-metadata.js";

export type TaxAssociationReconciliationResult =
  | { status: "not_applicable" }
  | { status: "pending"; reason: string }
  | { status: "investigation"; reason: string }
  | { status: "completed" };

/**
 * Dark until VAT_INCLUSIVE PIs exist. Stripe creates the Tax transaction asynchronously after
 * PI success, so this deliberately distinguishes an absent association from a terminal Stripe
 * attempt error. The webhook caller owns retry delivery; this class has no queue of its own.
 */
export class PaymentTaxAssociationReconciler {
  public constructor(
    private readonly gateway: PaymentGateway,
    private readonly bookingRepository: BookingRepository,
  ) {}

  public async reconcile(
    paymentIntentId: string,
    metadata: ParsedPaymentIntentMetadata,
  ): Promise<TaxAssociationReconciliationResult> {
    if (metadata.taxMode !== "VAT_INCLUSIVE") return { status: "not_applicable" };
    if (!metadata.taxCalculationId) {
      return {
        status: "investigation",
        reason: "VAT-inclusive PaymentIntent lacks taxCalculationId",
      };
    }

    const association = await this.gateway.findTaxAssociation(paymentIntentId);
    if (!association) {
      return { status: "pending", reason: "Stripe Tax Association is not available yet" };
    }
    if (association.taxCalculationId !== metadata.taxCalculationId) {
      return {
        status: "investigation",
        reason: "Stripe Tax Association calculation does not match metadata",
      };
    }
    if (association.terminalErrorReason) {
      return {
        status: "investigation",
        reason: `Stripe Tax Association terminal error: ${association.terminalErrorReason}`,
      };
    }
    if (!association.taxTransactionId) {
      return { status: "pending", reason: "Stripe Tax transaction is not committed yet" };
    }

    const updated = await this.bookingRepository.setTaxTransactionIdIfMatching({
      bookingId: metadata.bookingId,
      businessId: metadata.businessId,
      paymentIntentId,
      taxCalculationId: metadata.taxCalculationId,
      taxTransactionId: association.taxTransactionId,
    });
    if (!updated) {
      return { status: "pending", reason: "VAT Booking snapshot is not persisted yet" };
    }
    return { status: "completed" };
  }
}
