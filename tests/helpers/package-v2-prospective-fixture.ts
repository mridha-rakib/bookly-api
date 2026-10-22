/** Synthetic contract data only. Never imported by application code; not activation authority. */
import { Types } from "mongoose";
import { packageProgressV2InputSchema } from "../../src/modules/package-progress/package-progress-v2.rules.js";
import type {
  CreatePackageProgressV2Input,
  ProspectivePackageProgressV2Document,
} from "../../src/modules/package-progress/package-progress-v2.types.js";

export const PURCHASE = new Date("2026-01-01T10:00:00Z");
export const CUTOFF = new Date("2026-07-01T10:00:00Z");
export const BEFORE = new Date(CUTOFF.getTime() - 1);
export const AFTER = new Date(CUTOFF.getTime() + 1);

export const prospectiveFixture = (
  input: CreatePackageProgressV2Input,
  mode: "FINITE" | "FOREVER" = "FINITE",
  months: 6 | 12 = 6,
): Omit<ProspectivePackageProgressV2Document, "createdAt" | "updatedAt"> => {
  const activationId = new Types.ObjectId();
  const batchId = new Types.ObjectId();
  const quoteId = new Types.ObjectId();
  const acceptanceId = new Types.ObjectId();
  const payloadId = new Types.ObjectId();
  const contractTerms = {
    version: 2 as const,
    validity: mode === "FINITE" ? { mode, months } : { mode },
    penaltyPolicyVersion: 1 as const,
  };
  const validity = {
    contractVersion: 1 as const,
    mode,
    purchasedAt: PURCHASE,
    activationId,
    batchId,
    ...(mode === "FINITE"
      ? {
          months,
          timezone: "Asia/Dhaka",
          expiresAt: CUTOFF,
          calculation: { version: 1, provenanceRef: new Types.ObjectId() },
          activationWindow: {
            version: 1,
            quoteId,
            batchId,
            notBefore: new Date(PURCHASE.getTime() - 60000),
            notAfterExclusive: new Date(PURCHASE.getTime() + 60000),
          },
          expiryDisclosure: {
            version: 1,
            quoteId,
            acceptedTermsPayloadId: payloadId,
            acceptedTermsHash: "a".repeat(64),
            guaranteedNotBeforeExpiry: CUTOFF,
          },
        }
      : {}),
  };
  const parsed = packageProgressV2InputSchema.parse({
    ...input,
    creditAccountingVersion: 2,
    items: input.items.map((item) => ({ ...item, penaltyBasisCents: 5000, expiredSessions: 0 })),
    purchasedContract: {
      contractVersion: 1,
      definition: {
        packageId: input.packageId,
        packageRevision: input.purchaseSnapshot.packageRevision,
        contractTerms,
      },
      validity,
      penalty: {
        policyVersion: 1,
        currency: "EUR",
        soldBundlePriceCents: input.purchaseSnapshot.bundlePriceCents,
        appointmentCapCents: 2500,
        lifetimeCapCents: Number(
          BigInt(input.purchaseSnapshot.bundlePriceCents) / 2n > 10000n
            ? 10000n
            : BigInt(input.purchaseSnapshot.bundlePriceCents) / 2n,
        ),
        noPurchaseDepositOffset: true,
        scope: "INCLUDED_SESSION_ONLY",
        provenance: "ACCEPTED_SOLD_BUNDLE_PRICE",
        captureBudgetSemantics: {
          succeeded: "PERMANENT_SPEND",
          pendingOrUnknown: "RESERVE",
          definitiveNonCollection: "RELEASE",
          refundsAndDisputes: "NO_CAPACITY_RESTORE",
          fixedAssessment: "NO_AUTOMATIC_TOP_UP",
        },
      },
      acceptance: {
        version: 1,
        contractVersion: 1,
        acceptanceId,
        acceptedTermsPayloadId: payloadId,
        acceptedTermsHash: "a".repeat(64),
        templateId: new Types.ObjectId(),
        templateVersion: 1,
        actorUserId: input.customerUserId,
        customerUserId: input.customerUserId,
        actorRole: "CUSTOMER",
        acceptedAt: new Date(PURCHASE.getTime() - 1000),
        businessId: input.businessId,
        packageId: input.packageId,
        packageRevision: input.purchaseSnapshot.packageRevision,
        packageProgressId: input._id,
        batchId,
        quoteId,
        provenance: "CUSTOMER_ACCEPTANCE_RECORD",
        scope: "PURCHASE",
        items: input.items.map(({ packageItemId, definitionItemId, serviceId }) => ({
          packageItemId,
          definitionItemId,
          serviceId,
        })),
      },
      activation: {
        version: 1,
        contractVersion: 1,
        activationId,
        activationEventId: new Types.ObjectId(),
        batchId,
        packageProgressId: input._id,
        businessId: input.businessId,
        customerUserId: input.customerUserId,
        packageId: input.packageId,
        packageRevision: input.purchaseSnapshot.packageRevision,
        acceptanceId,
        purchasedAt: PURCHASE,
        provenance: "WINNING_BATCH_ACTIVATION_EVENT",
      },
    },
  });
  if (parsed.creditAccountingVersion !== 2) throw new Error("Expected prospective fixture");
  return parsed;
};
