import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { PaymentAttemptDocument } from "./payment-attempt.model.js";
import { BOOKLY_PAYMENT_METADATA_VERSION } from "./payment-intent-metadata.js";

const hex = z.string().regex(/^[a-f0-9]{24}$/);
/** Optional on new first-class attempts only. Old PACKAGE_PURCHASE means legacy unless
 * canonical retained evidence proves otherwise. Provider metadata is never authority. */
export const paymentBatchBindingSchema = z
  .object({
    version: z.literal(1),
    claimId: hex,
    batchId: hex,
    quoteId: hex,
    termsHash: z.string().regex(/^[a-f0-9]{64}$/),
    acceptanceId: hex,
    packageProgressId: hex,
    originBookingId: hex,
    customerUserId: hex,
    businessId: hex,
    businessClientId: hex,
  })
  .strict();
export type PaymentBatchBinding = z.output<typeof paymentBatchBindingSchema>;

export function assertPaymentBatchBinding(
  attempt: Pick<
    PaymentAttemptDocument,
    | "packageBatchBinding"
    | "businessId"
    | "customerUserId"
    | "businessClientId"
    | "bookingId"
    | "packageProgressId"
    | "purpose"
    | "productKind"
    | "financialContractVersion"
    | "currency"
    | "relationshipClassification"
  >,
) {
  const binding = paymentBatchBindingSchema.parse(attempt.packageBatchBinding);
  if (
    attempt.purpose !== "PACKAGE_PURCHASE" ||
    attempt.productKind !== "PACKAGE_PURCHASE" ||
    attempt.financialContractVersion !== 2 ||
    attempt.currency !== "EUR" ||
    !["FIRST", "RETURNING"].includes(attempt.relationshipClassification ?? "") ||
    String(attempt.businessId) !== binding.businessId ||
    String(attempt.customerUserId) !== binding.customerUserId ||
    String(attempt.businessClientId) !== binding.businessClientId ||
    String(attempt.bookingId) !== binding.originBookingId ||
    String(attempt.packageProgressId) !== binding.packageProgressId
  )
    throw new Error("PaymentAttempt batch identity mismatch");
  return binding;
}

export function equalPaymentBatchBindings(a: unknown, b: unknown) {
  return isDeepStrictEqual(a, b);
}

export function paymentBatchMetadata(binding: PaymentBatchBinding): Record<string, string> {
  const value = paymentBatchBindingSchema.parse(binding);
  return {
    booklyBatchVersion: "1",
    booklyBatchClaimId: value.claimId,
    booklyBatchId: value.batchId,
    booklyBatchQuoteId: value.quoteId,
    booklyBatchTermsHash: value.termsHash,
    booklyBatchAcceptanceId: value.acceptanceId,
    booklyBatchProgressId: value.packageProgressId,
  };
}

export function assertPaymentBatchMetadata(
  binding: PaymentBatchBinding,
  metadata: Record<string, string>,
) {
  const roots = {
    booklyPaymentVersion: BOOKLY_PAYMENT_METADATA_VERSION,
    purpose: "PACKAGE_PURCHASE",
    productKind: "PACKAGE_PURCHASE",
    financialContractVersion: "2",
    bookingId: binding.originBookingId,
    businessId: binding.businessId,
    businessClientId: binding.businessClientId,
  };
  for (const [key, value] of Object.entries({ ...paymentBatchMetadata(binding), ...roots }))
    if (metadata[key] !== value) throw new Error("PaymentIntent batch metadata mismatch");
}
