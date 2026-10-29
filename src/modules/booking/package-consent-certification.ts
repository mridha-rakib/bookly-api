import { type ClientSession, Error as MongooseError, mongo } from "mongoose";
import { AppError } from "../../common/errors/app-error.js";
import type { BookingCreationClaimDocument } from "./booking-creation-claim.model.js";
import { BookingCreationClaimModel } from "./booking-creation-claim.model.js";
import { verifyPackageBatchActivation } from "./package-batch-authority.js";
import { canonicalPackageBatch } from "./package-batch-contract.js";
import { hashCanonicalPackageCheckoutContent as digest } from "./package-checkout-binding.js";
import { assessConsentCommitDeadline } from "./package-consent-commit-deadline.js";
import {
  acceptanceEvidenceSchema,
  certificationEvidenceSchema,
  consentIssuanceWitness,
  issuanceEvidenceSchema,
  observationEvidenceSchema,
  readConsentEvidence,
} from "./package-consent-evidence.js";
import { verifyConsentHostObservation } from "./trusted-time/host-clock.js";

export async function readPackageConsentPublicState(operationKey: string) {
  const claim = await BookingCreationClaimModel.findOne({ idempotencyKey: operationKey })
    .read("primary")
    .readConcern("majority")
    .maxTimeMS(2000);
  if (!claim?.packageCheckoutAcceptance)
    return { certification: "UNRESOLVED" as const, purchaseAvailable: false };
  try {
    await verifyCertifiedPackageConsent(claim.toObject());
  } catch (error) {
    if (
      error instanceof mongo.MongoError ||
      error instanceof MongooseError.MongooseServerSelectionError
    )
      throw error;
    return { certification: "UNRESOLVED" as const, purchaseAvailable: false };
  }
  try {
    await verifyPackageBatchActivation();
    return { certification: "CERTIFIED" as const, purchaseAvailable: true };
  } catch {
    return { certification: "CERTIFIED" as const, purchaseAvailable: false };
  }
}

const unavailable = () =>
  new AppError("Exact durable consent is not certified", 503, {
    details: [
      {
        code: "PACKAGE_CONSENT_CERTIFICATION_UNAVAILABLE",
        message: "No entitlement or charge is authorized",
      },
    ],
  });
/** Pure record binding/clock checks plus immutable evidence reads. No browser DTO can certify.
 * Read-time validation preserves the acceptance facts at C; later logout does not erase C. */
export async function verifyCertifiedPackageConsent(
  claim: BookingCreationClaimDocument,
  session?: ClientSession,
) {
  const { retention, accepted, quote: q } = canonicalPackageBatch(claim);
  if (!retention.seed.consentEvidenceId) throw unavailable();
  const issuance = await readConsentEvidence(claim.idempotencyKey, "ISSUANCE", session);
  const acceptance = await readConsentEvidence(claim.idempotencyKey, "ACCEPTANCE", session);
  const observation = await readConsentEvidence(claim.idempotencyKey, "OBSERVATION", session);
  const certificate = await readConsentEvidence(claim.idempotencyKey, "CERTIFICATION", session);
  if (
    !issuance ||
    !acceptance ||
    !observation ||
    !certificate ||
    !issuance._id.equals(retention.seed.consentEvidenceId)
  )
    throw unavailable();
  const i = issuanceEvidenceSchema.parse(issuance.payload),
    a = acceptanceEvidenceSchema.parse(acceptance.payload),
    o = observationEvidenceSchema.parse(observation.payload),
    c = certificationEvidenceSchema.parse(certificate.payload);
  const binding = (p: typeof i | typeof a | typeof o | typeof c) =>
    p.operationKey === claim.idempotencyKey &&
    p.businessId.equals(claim.businessId) &&
    p.customerUserId.equals(claim.actorUserId) &&
    p.quoteId.equals(q.quoteId) &&
    p.businessClientId.equals(i.businessClientId) &&
    p.linkGeneration === i.linkGeneration;
  if (
    ![i, a, o, c].every(binding) ||
    digest(i.seed) !== digest(retention.seed) ||
    digest(retention.intent) !== i.intentHash ||
    !a.claimId.equals(claim._id) ||
    !c.claimId.equals(claim._id) ||
    !a.issuanceId.equals(issuance._id) ||
    !c.issuanceId.equals(issuance._id) ||
    !o.acceptanceId.equals(acceptance._id) ||
    !c.acceptanceId.equals(acceptance._id) ||
    !c.observationId.equals(observation._id) ||
    o.acceptanceRecordHash !== acceptance.contentHash ||
    c.acceptanceRecordHash !== acceptance.contentHash ||
    a.termsHash !== retention.quote.termsHash ||
    c.termsHash !== a.termsHash ||
    a.disclosureHash !== accepted.disclosureHash ||
    c.disclosureHash !== a.disclosureHash ||
    a.acceptanceHash !== digest(accepted) ||
    c.acceptanceHash !== a.acceptanceHash ||
    a.eventId !== accepted.event.eventId ||
    c.eventId !== a.eventId ||
    a.sessionFamilyId !== accepted.sessionFamilyId
  )
    throw unavailable();
  if (
    i.witnessHash !==
    consentIssuanceWitness(i.seed, i.intentHash, i.businessClientId, i.linkGeneration)
  )
    throw unavailable();
  const issue = verifyConsentHostObservation(i.observation, i.witnessHash);
  const commit = verifyConsentHostObservation(
    o.observation,
    digest({ acceptanceRecordHash: acceptance.contentHash, nonce: o.nonce }),
  );
  if (
    issue.bootId !== commit.bootId ||
    issue.latestMs > commit.latestMs ||
    commit.latestMs >= Math.min(a.jwtExpiresAtMs, a.sessionExpiresAtMs)
  )
    throw unavailable();
  const result = assessConsentCommitDeadline(
    {
      retainedIssuedAtMs: q.issuedAt.getTime(),
      retainedExpiresAtMs: q.expiresAt.getTime(),
      issuanceAttestation: issue,
      postCommitObservation: commit,
    },
    [issue.authorityId],
  );
  if (
    result.kind !== "CERTIFIED" ||
    result.deadlineMs !== c.deadlineMs ||
    result.commitLatestMs !== c.commitLatestMs
  )
    throw unavailable();
  return { certificateId: certificate._id, certificateHash: certificate.contentHash, binding: c };
}
