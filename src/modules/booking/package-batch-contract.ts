import { isDeepStrictEqual } from "node:util";
import { Types } from "mongoose";
import { z } from "zod";
import { packageInitialReservationKey } from "../booking-slot-reservation/reservation-operation.js";
import { packageGroupSeatSchema } from "../packages/package-service-entitlement.js";
import type { BookingCreationClaimDocument } from "./booking-creation-claim.model.js";
import { planPackageBatchMaterialization } from "./package-batch-materialization.js";
import { PackageCheckoutConflictError } from "./package-checkout.errors.js";
import { assertPackageAccepted } from "./package-checkout-acceptance.js";
import { hashCanonicalPackageCheckoutContent } from "./package-checkout-binding.js";
import { packageCheckoutRetentionSchema } from "./package-checkout-retention.js";

const id = z.custom<Types.ObjectId>((value) => value instanceof Types.ObjectId);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const packageBatchPreparationSchema = z
  .object({
    version: z.literal(1),
    protocol: z.literal("PACKAGE_INTERNAL_MATERIALIZATION"),
    claimId: id,
    idempotencyKey: z.string().min(1).max(200),
    businessId: id,
    customerUserId: id,
    businessClientId: id,
    quoteId: id,
    batchId: id,
    packageProgressId: id,
    originBookingId: id,
    termsHash: hash,
    disclosureHash: hash,
    acceptanceId: id,
    // Pinned internal test-authorized evidence; never an issuer of genuine purchasedAt.
    materializedAt: z.date(),
    activationId: id,
    activationEventId: id,
    members: z
      .array(
        z
          .object({
            bookingId: id,
            selectionId: id,
            packageItemId: id,
            definitionItemId: id,
            serviceId: id,
            staffMembershipId: id,
            startAt: z.date(),
            endAt: z.date(),
            group: packageGroupSeatSchema.optional(),
            reference: z.string().regex(/^BK-[A-Z0-9]+$/),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type PackageBatchPreparation = z.output<typeof packageBatchPreparationSchema>;
export const packageBatchControlSchema = z.discriminatedUnion("phase", [
  z.object({ version: z.literal(1), phase: z.literal("PREPARED") }).strict(),
  z.object({ version: z.literal(1), phase: z.literal("PERSISTING"), token: z.uuid() }).strict(),
  z
    .object({ version: z.literal(1), phase: z.literal("PREPARATION_COMPLETE"), token: z.uuid() })
    .strict(),
  z
    .object({
      version: z.literal(1),
      phase: z.literal("FAILED_FINAL"),
      token: z.uuid(),
      reason: z.literal("DEFINITIVE_COMPENSATED_ABORT"),
      paymentAttemptId: id,
      refundOperationId: id,
    })
    .strict(),
  z
    .object({ version: z.literal(1), phase: z.literal("INTERNAL_MATERIALIZED"), token: z.uuid() })
    .strict(),
]);
export type PackageBatchControl = z.output<typeof packageBatchControlSchema>;
export const packageBatchMaterializationSchema = z
  .object({
    version: z.literal(1),
    state: z.literal("INTERNAL_MATERIALIZATION_ONLY"),
    commercialCompletion: z.literal("NOT_ESTABLISHED"),
    preparationHash: hash,
    members: z
      .array(
        z.object({ bookingId: id, reservationId: id, operationKey: z.string().min(1) }).strict(),
      )
      .min(1),
  })
  .strict();
export type PackageBatchMaterialization = z.output<typeof packageBatchMaterializationSchema>;
export const packageBatchOperation = (
  p: PackageBatchPreparation,
  member: PackageBatchPreparation["members"][number],
) => ({
  version: 1 as const,
  kind: "PACKAGE_INITIAL_APPOINTMENT" as const,
  businessId: p.businessId.toHexString(),
  bookingId: member.bookingId.toHexString(),
  batchId: p.batchId.toHexString(),
  selectionId: member.selectionId.toHexString(),
});

export const batchConflict = () =>
  new PackageCheckoutConflictError("Package batch binding unavailable or conflicting");
export class PackageBatchUnresolvedError extends Error {
  public readonly statusCode = 503;
  public readonly code = "PACKAGE_BATCH_MATERIALIZATION_UNRESOLVED";
  public constructor() {
    super("The original internal materialization is not yet provable");
  }
}

export function canonicalPackageBatch(claim: BookingCreationClaimDocument) {
  if (
    claim.financialContract ||
    claim.packageRequestBinding ||
    !claim.packageCheckoutRetention ||
    !claim.packageCheckoutPresentation ||
    !claim.packageCheckoutAcceptance
  )
    throw batchConflict();
  const retention = packageCheckoutRetentionSchema.parse(claim.packageCheckoutRetention);
  const accepted = assertPackageAccepted(
    retention,
    claim.packageCheckoutPresentation,
    claim.packageCheckoutAcceptance,
  );
  planPackageBatchMaterialization({
    retention,
    claim: {
      idempotencyKey: claim.idempotencyKey,
      businessId: claim.businessId,
      actorUserId: claim.actorUserId,
      bookingId: claim.bookingId,
    },
  });
  return { retention, quote: retention.quote.payload, accepted };
}

export function assertBatchPreparation(claim: BookingCreationClaimDocument, input: unknown) {
  const p = packageBatchPreparationSchema.parse(input);
  const { quote: q, retention, accepted } = canonicalPackageBatch(claim);
  const equal = (a: Types.ObjectId, b: Types.ObjectId) => a.equals(b);
  if (
    !equal(p.claimId, claim._id) ||
    p.idempotencyKey !== claim.idempotencyKey ||
    !equal(p.businessId, claim.businessId) ||
    !equal(p.customerUserId, claim.actorUserId) ||
    !equal(p.quoteId, q.quoteId) ||
    !equal(p.batchId, q.batchId) ||
    !equal(p.packageProgressId, q.packageProgressId) ||
    !equal(p.originBookingId, q.originBookingId) ||
    !equal(p.acceptanceId, accepted.evidence.acceptanceId) ||
    p.termsHash !== retention.quote.termsHash ||
    p.disclosureHash !== accepted.disclosureHash ||
    p.members.length !== q.appointments.length ||
    p.materializedAt < accepted.evidence.acceptedAt ||
    p.materializedAt >= q.expiresAt ||
    new Set(p.members.map((m) => m.bookingId.toHexString())).size !== p.members.length ||
    new Set(p.members.map((m) => m.reference)).size !== p.members.length
  )
    throw batchConflict();
  for (const m of p.members) {
    const row = q.appointments.find((r) => r.bookingId.equals(m.bookingId));
    if (
      !row ||
      !["selectionId", "packageItemId", "definitionItemId", "serviceId", "staffMembershipId"].every(
        (key) => isDeepStrictEqual(Reflect.get(row, key), Reflect.get(m, key)),
      ) ||
      row.startAt.getTime() !== m.startAt.getTime() ||
      row.endAt.getTime() !== m.endAt.getTime() ||
      !isDeepStrictEqual(row.group, m.group)
    )
      throw batchConflict();
  }
  return p;
}

export function assertBatchMaterialization(preparation: PackageBatchPreparation, input: unknown) {
  const proof = packageBatchMaterializationSchema.parse(input);
  if (
    proof.preparationHash !== hashCanonicalPackageCheckoutContent(preparation) ||
    proof.members.length !== preparation.members.length ||
    new Set(proof.members.map((m) => m.bookingId.toHexString())).size !== proof.members.length
  )
    throw batchConflict();
  for (const member of preparation.members) {
    const actual = proof.members.find((m) => m.bookingId.equals(member.bookingId));
    if (
      !actual ||
      actual.operationKey !==
        packageInitialReservationKey(packageBatchOperation(preparation, member))
    )
      throw batchConflict();
  }
  return proof;
}
