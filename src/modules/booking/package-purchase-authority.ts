import { isDeepStrictEqual } from "node:util";
import type { ClientSession } from "mongoose";
import { AppError } from "../../common/errors/app-error.js";
import { BusinessClientModel } from "../client/client.model.js";
import {
  type BookingCreationClaimDocument,
  loadOwnedPackageBatch,
  type PackageBatchScope,
} from "./booking-creation-claim.model.js";
import { verifyBatchCompletion } from "./package-batch-completion.js";
import { verifyCertifiedPackageConsent } from "./package-consent-certification.js";
import { requireQualifiedConsentHost } from "./trusted-time/qualified-host.js";

/** Independent of rollout. ACCEPTED_IMMUTABLE is not a timely durable-commit certificate.
 * Re-verifies the approved P3B source protocol with the qualified host registry. No flag, posted evidence or injected predicate
 * grants certification. Isolated engineering tests mock this module, as they do B1c. */
export async function verifyPackagePurchaseConsentCertification(scope: PackageBatchScope) {
  requireQualifiedConsentHost();
  const claim = await loadOwnedPackageBatch(scope);
  const certified = await verifyCertifiedPackageConsent(claim.toObject());
  const binding = certified.binding;
  const client = await BusinessClientModel.findOne({
    _id: binding.businessClientId,
    businessId: scope.businessId,
    linkedUserId: binding.customerUserId,
    linkState: "LINKED",
    archivedAt: { $exists: false },
    ...(binding.linkGeneration === 0
      ? { $or: [{ linkGeneration: 0 }, { linkGeneration: { $exists: false } }] }
      : { linkGeneration: binding.linkGeneration }),
  }).maxTimeMS(2000);
  if (!client || !client._id.equals(scope.businessClientId))
    throw new AppError("Original BusinessClient continuity changed", 409);
  return certified;
}

/** Historical v1 proof remains explicitly synthetic; it is never promoted. */
const productionCompletionUnavailable = () =>
  new AppError("Production Package completion authority is unavailable", 503, {
    details: [
      {
        code: "PACKAGE_PURCHASE_COMPLETION_AUTHORITY_UNAVAILABLE",
        message: "Internal batch completion is not production activation",
      },
    ],
  });

/** Shared public-ownership boundary. The existing F2 verifier establishes payment, ledger,
 * members, Progress and effects; it deliberately accepts engineering proof. Public ownership
 * adds version-2 certification binding and cannot inherit engineering success. */
export async function verifyPackagePurchaseClaimCompletion(
  claim: BookingCreationClaimDocument,
  session?: ClientSession,
) {
  const committed = await verifyBatchCompletion(claim, session);
  if (committed.completion.version !== 2) throw productionCompletionUnavailable();
  const certified = await verifyCertifiedPackageConsent(claim, session);
  if (
    !committed.completion.consentCertificateId.equals(certified.certificateId) ||
    committed.completion.consentCertificateHash !== certified.certificateHash
  )
    throw productionCompletionUnavailable();
  return committed;
}

export async function verifyPackagePurchaseProductionCompletion(
  scope: PackageBatchScope,
  completion: unknown,
): Promise<void> {
  if (!completion || typeof completion !== "object" || !("completion" in completion))
    throw productionCompletionUnavailable();
  // The public signature accepts a previously read result for compatibility, but that DTO
  // never grants authority. Re-read the owned canonical claim and compare the full result.
  const claim = await loadOwnedPackageBatch(scope);
  const committed = await verifyBatchCompletion(claim.toObject());
  if (!isDeepStrictEqual(committed, completion))
    throw new AppError("Purchase completion observation changed", 409);
  await verifyPackagePurchaseClaimCompletion(claim.toObject());
  // The same exact consent certificate is independently reverified before returning.
}
