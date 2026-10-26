import { type ClientSession, Types } from "mongoose";
import { BusinessClientModel } from "../client/client.model.js";
import { FinancialRelationshipRepository } from "../client/financial-relationship.repository.js";
import type { PaymentAttemptDocument } from "../payment/payment-attempt.model.js";
import { PaymentAttemptModel } from "../payment/payment-attempt.model.js";
import { assertPaymentBatchBinding } from "../payment/payment-batch-binding.js";
import { hasLifecyclePaymentEvidence } from "../payment/payment-lifecycle-binding.js";
import { RefundOperationModel } from "../payment/refund-operation.model.js";
import { BookingCreationClaimModel } from "./booking-creation-claim.model.js";
import { assertCanonicalBatchFinance, verifyBatchCompletion } from "./package-batch-completion.js";
import {
  assertBatchPreparation,
  batchConflict,
  canonicalPackageBatch,
} from "./package-batch-contract.js";

/** Early discriminator shared by worker/relationship/webhook. A retained checkout cannot
 * fall back to legacy recovery even if a malformed writer omitted the attempt extension.
 * F1's INTERNAL_MATERIALIZATION_ONLY is deliberately insufficient monetary proof. */
export async function inspectBatchPaymentAuthority(
  attempt: PaymentAttemptDocument,
  session?: ClientSession,
) {
  if (hasLifecyclePaymentEvidence(attempt))
    throw Error("Lifecycle money requires its own complete-result authority");
  if (
    !attempt.packageBatchBinding &&
    attempt.purpose !== "PACKAGE_PURCHASE" &&
    attempt.productKind !== "PACKAGE_PURCHASE" &&
    !attempt.packageProgressId
  )
    return null;
  const claim = await BookingCreationClaimModel.findOne({
    idempotencyKey: attempt.logicalIdempotencyKey,
  })
    .session(session ?? null)
    .read("primary")
    .maxTimeMS(2000);
  if (!attempt.packageBatchBinding && !claim?.packageCheckoutRetention) return null;
  const binding = assertPaymentBatchBinding(attempt);
  if (
    !claim?._id.equals(binding.claimId) ||
    !claim.businessId.equals(binding.businessId) ||
    !claim.actorUserId.equals(binding.customerUserId) ||
    !claim.bookingId.equals(binding.originBookingId)
  )
    throw batchConflict();
  const { quote, accepted, retention } = canonicalPackageBatch(claim.toObject());
  const p = assertBatchPreparation(claim.toObject(), claim.packageBatchPreparation);
  assertCanonicalBatchFinance(claim.toObject(), claim.packageBatchFinance);
  if (
    !p.businessClientId.equals(binding.businessClientId) ||
    !quote.batchId.equals(binding.batchId) ||
    !quote.quoteId.equals(binding.quoteId) ||
    !quote.packageProgressId.equals(binding.packageProgressId) ||
    !accepted.evidence.acceptanceId.equals(binding.acceptanceId) ||
    retention.quote.termsHash !== binding.termsHash ||
    quote.financials.requiredUpfrontCents !== attempt.expectedAmountCents ||
    attempt.currency !== "EUR" ||
    attempt.expectedAmountCents <= 0 ||
    attempt.relationshipClassification !== quote.financials.classification
  )
    throw batchConflict();
  if (claim.packageBatchCompletion) {
    const complete = await verifyBatchCompletion(claim.toObject(), session);
    if (!complete.completion.paymentAttemptId?.equals(attempt._id)) throw batchConflict();
    return { kind: "BATCH_PAYMENT_COMPLETE" as const, binding, claim };
  }
  return { kind: "BATCH_PAYMENT_UNRESOLVED" as const, binding, claim };
}

/** Relationship's unbound/pending branch must discriminate before origin lookup or lease
 * expiry, including a crashed operation that has no PaymentAttempt yet. */
export async function isCanonicalRetainedBatch(key: string, session?: ClientSession) {
  return Boolean(
    await BookingCreationClaimModel.exists({
      idempotencyKey: key,
      packageCheckoutRetention: { $exists: true },
    })
      .session(session ?? null)
      .read("primary")
      .maxTimeMS(2000),
  );
}

/** Only a terminal full refund of the exact token-authorized failed batch can restore FIRST.
 * No absent Booking, pending age or incomplete read is used as abort proof. */
export async function readExactBatchCompensation(attempt: PaymentAttemptDocument) {
  const authority = await inspectBatchPaymentAuthority(attempt);
  if (
    !authority ||
    authority.kind === "BATCH_PAYMENT_COMPLETE" ||
    attempt.persistenceStatus !== "FAILED" ||
    attempt.compensationStatus !== "REFUNDED" ||
    attempt.providerStatus !== "SUCCEEDED" ||
    !attempt.providerPaymentIntentId
  )
    return;
  const finance = assertCanonicalBatchFinance(
    authority.claim.toObject(),
    authority.claim.packageBatchFinance,
  );
  if (finance.contract.classification !== "FIRST") return;
  const refund = await RefundOperationModel.findOne({
    logicalIdempotencyKey: `refund:${attempt.providerPaymentIntentId}:compensation`,
    sourcePaymentAttemptId: attempt._id,
    sourcePaymentIntentId: attempt.providerPaymentIntentId,
    expectedRefundAmountCents: attempt.expectedAmountCents,
    currency: attempt.currency,
    providerStatus: "SUCCEEDED",
    reason: "BOOKING_PERSISTENCE_COMPENSATION",
    businessId: new Types.ObjectId(authority.binding.businessId),
    customerUserId: attempt.customerUserId,
    businessClientId: new Types.ObjectId(authority.binding.businessClientId),
    bookingId: new Types.ObjectId(authority.binding.originBookingId),
    packageProgressId: new Types.ObjectId(authority.binding.packageProgressId),
  })
    .read("primary")
    .maxTimeMS(2000);
  if (!refund?.providerRefundId) return;
  return { authority, finance, refund };
}

export async function reconcileBatchCompensation(key: string) {
  const attempt = await PaymentAttemptModel.findOne({ logicalIdempotencyKey: key });
  if (!attempt) return;
  const proof = await readExactBatchCompensation(attempt);
  if (!proof) return;
  const { authority, refund } = proof;
  const repo = new FinancialRelationshipRepository();
  let client = await BusinessClientModel.findById(authority.binding.businessClientId);
  let relationship = client?.financialRelationship;
  const pending = relationship?.pending;
  if (!pending?.paymentAttemptId?.equals(attempt._id) || pending.idempotencyKey !== key) return;
  if (relationship?.state === "FIRST_PENDING") {
    if (
      !(await repo.markRestorationPending(new Types.ObjectId(authority.binding.businessClientId), {
        idempotencyKey: key,
        paymentAttemptId: attempt._id,
        expectedRevision: relationship.revision,
        refundOperationId: refund._id,
      }))
    )
      return;
    client = await BusinessClientModel.findById(authority.binding.businessClientId);
    relationship = client?.financialRelationship;
  }
  if (client && relationship?.state === "RESTORATION_PENDING")
    await repo.restoreAfterCompensation(client._id, {
      idempotencyKey: key,
      paymentAttemptId: attempt._id,
      refundOperationId: refund._id,
      expectedRevision: relationship.revision,
    });
}
