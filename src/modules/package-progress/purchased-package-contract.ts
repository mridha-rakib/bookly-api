import { Types } from "mongoose";
import { z } from "zod";
import {
  calculatePackageLifetimeCaptureCap,
  PACKAGE_DEFINITION_CONTRACT_VERSION,
  PACKAGE_DEFINITION_VALIDITY_CONTRACT_VERSION,
  PACKAGE_SESSION_PENALTY_POLICY as policy,
} from "../packages/package-session-penalty-policy.js";

/** Validation vocabulary reused by strict P2 storage validation, not a purchase constructor.
 * A parsed reference is a claim to evidence, never evidence of authority by itself.
 * P3 must verify authenticated consent, retained payload/hash, ownership, revision,
 * real batch/Bookings/origin, payment authority and the winning activation event.
 * D2 must define calculation semantics before calculationVersion 1 can be executed.
 * No expiry arithmetic, appointment cutoff inequality or delivery policy lives here.
 * Readonly containers do not make Date/ObjectId internals or persisted data immutable;
 * future persistence must enforce immutable snapshots and defensively own its values.
 */
export const PURCHASED_PACKAGE_CONTRACT_VERSION = 1 as const;

const id = z.custom<Types.ObjectId>(
  (value) => value instanceof Types.ObjectId,
  "Expected ObjectId",
);
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const quantity = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const months = z.union([z.literal(6), z.literal(12)]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.literal(PURCHASED_PACKAGE_CONTRACT_VERSION);
const date = z.date();
const timezone = z
  .string()
  .min(1)
  .refine((value) => {
    // Intl also accepts numeric offsets in some runtimes; those are not named zones.
    if (/^[+-]|^[Zz]$/.test(value) || value.trim() !== value) return false;
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Expected a valid named IANA timezone");

const definitionValidity = z.discriminatedUnion("mode", [
  z
    .object({ mode: z.literal("FINITE"), months })
    .strict()
    .readonly(),
  z
    .object({ mode: z.literal("FOREVER") })
    .strict()
    .readonly(),
]);

/** Copies the supported stored catalog shape without upgrading its version. */
export const purchasedDefinitionTermsSchema = z.discriminatedUnion("version", [
  z
    .object({
      version: z.literal(PACKAGE_DEFINITION_CONTRACT_VERSION),
      validityMonths: months,
      penaltyPolicyVersion: z.literal(policy.version),
    })
    .strict()
    .readonly(),
  z
    .object({
      version: z.literal(PACKAGE_DEFINITION_VALIDITY_CONTRACT_VERSION),
      validity: definitionValidity,
      penaltyPolicyVersion: z.literal(policy.version),
    })
    .strict()
    .readonly(),
]);

export const purchasedDefinitionReferenceSchema = z
  .object({
    packageId: id,
    packageRevision: quantity,
    contractTerms: purchasedDefinitionTermsSchema,
  })
  .strict()
  .readonly();

export const purchasedItemIdentitySchema = z
  .object({ packageItemId: id, definitionItemId: id, serviceId: id })
  .strict()
  .readonly();

/** The only principal-owning fragment. Reference prices and balances are not inputs. */
export const purchasedItemContractSchema = z
  .object({
    version,
    packageId: id,
    packageRevision: quantity,
    ...purchasedItemIdentitySchema.unwrap().shape,
    totalSessions: quantity,
    penaltyBasisCents: cents.max(policy.maxBasisCents),
    provenance: z.literal("ACCEPTED_DEFINITION_ITEM"),
  })
  .strict()
  .readonly();

export const purchasedPenaltyContractSchema = z
  .object({
    policyVersion: z.literal(policy.version),
    currency: z.literal(policy.currency),
    soldBundlePriceCents: cents,
    appointmentCapCents: z.literal(policy.appointmentCaptureCapCents),
    lifetimeCapCents: cents,
    noPurchaseDepositOffset: z.literal(true),
    scope: z.literal("INCLUDED_SESSION_ONLY"),
    provenance: z.literal("ACCEPTED_SOLD_BUNDLE_PRICE"),
    captureBudgetSemantics: z
      .object({
        succeeded: z.literal("PERMANENT_SPEND"),
        pendingOrUnknown: z.literal("RESERVE"),
        definitiveNonCollection: z.literal("RELEASE"),
        refundsAndDisputes: z.literal("NO_CAPACITY_RESTORE"),
        fixedAssessment: z.literal("NO_AUTOMATIC_TOP_UP"),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Numeric refinements can fail without aborting superRefine. Never throw on bad input.
    if (!Number.isSafeInteger(value.soldBundlePriceCents) || value.soldBundlePriceCents < 0) return;
    if (value.lifetimeCapCents !== calculatePackageLifetimeCaptureCap(value.soldBundlePriceCents)) {
      ctx.addIssue({
        code: "custom",
        path: ["lifetimeCapCents"],
        message: "Incorrect fixed lifetime cap",
      });
    }
  })
  .readonly();

export const acceptedActivationWindowSchema = z
  .object({ version, quoteId: id, batchId: id, notBefore: date, notAfterExclusive: date })
  .strict()
  .refine(
    (value) => value.notBefore < value.notAfterExclusive,
    "Empty or reversed activation window",
  )
  .readonly();

const validityCommon = {
  contractVersion: version,
  purchasedAt: date,
  activationId: id,
  batchId: id,
};

export const purchasedValidityContractSchema = z
  .discriminatedUnion("mode", [
    z
      .object({
        ...validityCommon,
        mode: z.literal("FINITE"),
        months,
        timezone,
        expiresAt: date,
        calculation: z.object({ version, provenanceRef: id }).strict().readonly(),
        activationWindow: acceptedActivationWindowSchema,
        expiryDisclosure: z
          .object({
            version,
            quoteId: id,
            acceptedTermsPayloadId: id,
            acceptedTermsHash: hash,
            guaranteedNotBeforeExpiry: date,
          })
          .strict()
          .readonly(),
      })
      .strict(),
    z.object({ ...validityCommon, mode: z.literal("FOREVER") }).strict(),
  ])
  .superRefine((value, ctx) => {
    if (value.mode !== "FINITE") return;
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (value.expiresAt <= value.purchasedAt) issue("Deadline must follow original purchase");
    if (
      value.purchasedAt < value.activationWindow.notBefore ||
      value.purchasedAt >= value.activationWindow.notAfterExclusive
    )
      issue("Purchase is outside the accepted activation window");
    if (
      value.expiryDisclosure.guaranteedNotBeforeExpiry <= value.purchasedAt ||
      value.expiryDisclosure.guaranteedNotBeforeExpiry > value.expiresAt
    )
      issue("Expiry disclosure ordering is inconsistent");
    if (!value.batchId.equals(value.activationWindow.batchId)) issue("Activation batch mismatch");
    if (!value.expiryDisclosure.quoteId.equals(value.activationWindow.quoteId))
      issue("Quote mismatch");
  })
  .readonly();

const acceptanceCommon = {
  version,
  contractVersion: version,
  acceptanceId: id,
  acceptedTermsPayloadId: id,
  acceptedTermsHash: hash,
  templateId: id,
  templateVersion: version,
  actorUserId: id,
  customerUserId: id,
  actorRole: z.literal("CUSTOMER"),
  acceptedAt: date,
  businessId: id,
  packageId: id,
  packageRevision: quantity,
  packageProgressId: id,
  batchId: id,
  quoteId: id,
  provenance: z.literal("CUSTOMER_ACCEPTANCE_RECORD"),
};

export const purchasedAcceptanceEvidenceSchema = z
  .discriminatedUnion("scope", [
    z
      .object({
        ...acceptanceCommon,
        scope: z.literal("PURCHASE"),
        items: z.array(purchasedItemIdentitySchema).min(1).readonly(),
      })
      .strict(),
    z
      .object({
        ...acceptanceCommon,
        scope: z.literal("APPOINTMENT"),
        bookingId: id,
        item: purchasedItemIdentitySchema,
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (!value.actorUserId.equals(value.customerUserId))
      ctx.addIssue({ code: "custom", message: "Customer acceptance actor mismatch" });
    if (value.scope === "PURCHASE") {
      for (const key of ["packageItemId", "definitionItemId", "serviceId"] as const) {
        if (new Set(value.items.map((item) => item[key].toHexString())).size !== value.items.length)
          ctx.addIssue({ code: "custom", path: ["items"], message: `Duplicate accepted ${key}` });
      }
    }
  })
  .readonly();

/** References the winning event; no boolean here can certify payment or activation. */
export const purchasedActivationEvidenceSchema = z
  .object({
    version,
    contractVersion: version,
    activationId: id,
    activationEventId: id,
    batchId: id,
    packageProgressId: id,
    businessId: id,
    customerUserId: id,
    packageId: id,
    packageRevision: quantity,
    acceptanceId: id,
    purchasedAt: date,
    provenance: z.literal("WINNING_BATCH_ACTIVATION_EVENT"),
  })
  .strict()
  .readonly();

/** Optional correlation validator for the fragments, NOT a persistence/create DTO.
 * In particular, plausible dates/hash/IDs can pass without any real-world purchase.
 * P3 still owes month/DST and quote-minimum proof, authentic evidence, exact owned
 * item membership and atomic authoritative activation. No Booking timing is inferred.
 */
export const purchasedPackageContractFragmentsSchema = z
  .object({
    contractVersion: version,
    definition: purchasedDefinitionReferenceSchema,
    validity: purchasedValidityContractSchema,
    penalty: purchasedPenaltyContractSchema,
    items: z.array(purchasedItemContractSchema).min(1).readonly(),
    acceptance: purchasedAcceptanceEvidenceSchema,
    activation: purchasedActivationEvidenceSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const { definition, validity, items, acceptance, activation } = value;
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    const same = (left: Types.ObjectId, right: Types.ObjectId) => left.equals(right);
    const terms = definition.contractTerms;
    const selected =
      terms.version === 1 ? { mode: "FINITE", months: terms.validityMonths } : terms.validity;
    if (
      selected.mode !== validity.mode ||
      (selected.mode === "FINITE" &&
        validity.mode === "FINITE" &&
        selected.months !== validity.months)
    )
      issue("Definition validity does not match the copied purchase selection");
    for (const key of ["packageItemId", "definitionItemId", "serviceId"] as const) {
      if (new Set(items.map((item) => item[key].toHexString())).size !== items.length)
        issue(`Duplicate purchased ${key}`);
    }
    if (
      items.reduce((total, item) => total + BigInt(item.totalSessions), 0n) >
      BigInt(Number.MAX_SAFE_INTEGER)
    )
      issue("Aggregate purchased quantity exceeds existing safe count bound");
    for (const item of items) {
      if (
        !same(item.packageId, definition.packageId) ||
        item.packageRevision !== definition.packageRevision
      )
        issue("Item definition provenance mismatch");
    }
    for (const evidence of [acceptance, activation]) {
      if (
        !same(evidence.packageId, definition.packageId) ||
        evidence.packageRevision !== definition.packageRevision
      )
        issue("Evidence definition mismatch");
      if (!same(evidence.batchId, validity.batchId)) issue("Evidence batch mismatch");
    }
    for (const key of [
      "businessId",
      "customerUserId",
      "packageProgressId",
      "acceptanceId",
    ] as const) {
      if (!same(acceptance[key], activation[key])) issue(`Activation ${key} mismatch`);
    }
    if (!same(validity.activationId, activation.activationId))
      issue("Activation reference mismatch");
    if (validity.purchasedAt.getTime() !== activation.purchasedAt.getTime())
      issue("Purchase time mismatch");
    if (acceptance.acceptedAt > activation.purchasedAt)
      issue("Acceptance follows purchase activation");
    if (acceptance.scope !== "PURCHASE") {
      issue("Purchase fragments require purchase-scope acceptance");
    } else {
      if (
        acceptance.items.length !== items.length ||
        items.some(
          (item) =>
            !acceptance.items.some((accepted) =>
              (["packageItemId", "definitionItemId", "serviceId"] as const).every((key) =>
                same(accepted[key], item[key]),
              ),
            ),
        )
      )
        issue("Accepted item membership mismatch");
    }
    if (validity.mode === "FINITE") {
      if (!same(acceptance.quoteId, validity.activationWindow.quoteId))
        issue("Accepted quote mismatch");
      if (
        !same(
          acceptance.acceptedTermsPayloadId,
          validity.expiryDisclosure.acceptedTermsPayloadId,
        ) ||
        acceptance.acceptedTermsHash !== validity.expiryDisclosure.acceptedTermsHash
      )
        issue("Accepted expiry disclosure payload mismatch");
    }
  })
  .readonly();

export type PurchasedDefinitionTerms = z.output<typeof purchasedDefinitionTermsSchema>;
export type PurchasedDefinitionReference = z.output<typeof purchasedDefinitionReferenceSchema>;
export type PurchasedItemIdentity = z.output<typeof purchasedItemIdentitySchema>;
export type PurchasedItemContract = z.output<typeof purchasedItemContractSchema>;
export type PurchasedPenaltyContract = z.output<typeof purchasedPenaltyContractSchema>;
export type AcceptedActivationWindow = z.output<typeof acceptedActivationWindowSchema>;
export type PurchasedValidityContract = z.output<typeof purchasedValidityContractSchema>;
export type PurchasedAcceptanceEvidence = z.output<typeof purchasedAcceptanceEvidenceSchema>;
export type PurchasedActivationEvidence = z.output<typeof purchasedActivationEvidenceSchema>;
export type PurchasedPackageContractFragments = z.output<
  typeof purchasedPackageContractFragmentsSchema
>;
