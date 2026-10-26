import { z } from "zod";
import type { PaymentAttemptDocument } from "./payment-attempt.model.js";

const hex = z.string().regex(/^[a-f0-9]{24}$/);
export const lifecyclePaymentBindingSchema = z
  .object({
    version: z.literal(1),
    operationId: hex,
    intentHash: z.string().regex(/^[a-f0-9]{64}$/),
    businessId: hex,
    businessClientId: hex,
    customerUserId: hex,
    packageProgressId: hex,
    bookingId: hex,
    kind: z.enum(["CANCELLATION_FEE", "NO_SHOW_FEE", "SESSION_DUES"]),
    amountCents: z.number().int().safe().positive(),
    currency: z.literal("EUR"),
  })
  .strict();
export type LifecyclePaymentBinding = z.infer<typeof lifecyclePaymentBindingSchema>;
export const lifecyclePaymentKey = (binding: LifecyclePaymentBinding) =>
  `bookly:package-session-money:v1:${binding.operationId}`;
export function assertLifecyclePaymentBinding(
  attempt: Omit<
    Pick<
      PaymentAttemptDocument,
      | "packageLifecycleBinding"
      | "packageBatchBinding"
      | "logicalIdempotencyKey"
      | "purpose"
      | "businessId"
      | "businessClientId"
      | "customerUserId"
      | "packageProgressId"
      | "bookingId"
      | "currency"
      | "expectedAmountCents"
      | "productKind"
      | "financialContractVersion"
      | "relationshipClassification"
    >,
    "businessId" | "businessClientId" | "customerUserId" | "packageProgressId" | "bookingId"
  > & {
    businessId?: unknown;
    businessClientId?: unknown;
    customerUserId: unknown;
    packageProgressId?: unknown;
    bookingId?: unknown;
  },
) {
  const b = lifecyclePaymentBindingSchema.parse(attempt.packageLifecycleBinding);
  if (
    attempt.packageBatchBinding ||
    attempt.productKind ||
    attempt.financialContractVersion ||
    attempt.relationshipClassification ||
    attempt.purpose !== "PACKAGE_LIFECYCLE_MONEY" ||
    attempt.logicalIdempotencyKey !== lifecyclePaymentKey(b) ||
    String(attempt.businessId) !== b.businessId ||
    String(attempt.businessClientId) !== b.businessClientId ||
    String(attempt.customerUserId) !== b.customerUserId ||
    String(attempt.packageProgressId) !== b.packageProgressId ||
    String(attempt.bookingId) !== b.bookingId ||
    attempt.currency !== "EUR" ||
    attempt.expectedAmountCents !== b.amountCents
  )
    throw Error("Lifecycle payment binding mismatch");
  return b;
}
export function lifecyclePaymentMetadata(binding: LifecyclePaymentBinding) {
  return {
    purpose: "PACKAGE_LIFECYCLE_MONEY",
    businessId: binding.businessId,
    businessClientId: binding.businessClientId,
    bookingId: binding.bookingId,
    booklyLifecycleOperation: binding.operationId,
    booklyLifecycleIntent: binding.intentHash,
    booklyLifecycleKind: binding.kind,
    booklyLifecycleProgress: binding.packageProgressId,
    booklyLifecycleVersion: "1",
  };
}
export function assertLifecyclePaymentMetadata(
  binding: LifecyclePaymentBinding,
  metadata: Record<string, string>,
) {
  for (const [k, v] of Object.entries(lifecyclePaymentMetadata(binding)))
    if (metadata[k] !== v) throw Error("Lifecycle provider metadata mismatch");
}
export function hasLifecyclePaymentEvidence(
  attempt: Pick<
    PaymentAttemptDocument,
    "packageLifecycleBinding" | "logicalIdempotencyKey" | "purpose"
  >,
) {
  return (
    !!attempt.packageLifecycleBinding ||
    attempt.purpose === "PACKAGE_LIFECYCLE_MONEY" ||
    (typeof attempt.logicalIdempotencyKey === "string" &&
      attempt.logicalIdempotencyKey.startsWith("bookly:package-session-money:"))
  );
}
