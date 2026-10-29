import { randomBytes } from "node:crypto";
import mongoose, { type Types } from "mongoose";
import type { z } from "zod";
import { AppError } from "../../common/errors/app-error.js";
import { BusinessModel } from "../business/business.model.js";
import { BusinessClientModel } from "../client/client.model.js";
import { ClientRepository } from "../client/client.repository.js";
import { SessionModel } from "../session/session.model.js";
import { UserModel } from "../user/user.model.js";
import { UserRepository } from "../user/user.repository.js";
import {
  BookingCreationClaimModel,
  commitPackageCheckoutClaimGrant,
} from "./booking-creation-claim.model.js";
import { resolveCustomerBusinessClient } from "./booking-customer-client.js";
import { assertPackageAccepted } from "./package-checkout-acceptance.js";
import { hashCanonicalPackageCheckoutContent as digest } from "./package-checkout-binding.js";
import type { packageCheckoutIntentSchema } from "./package-checkout-contract.js";
import { packageCheckoutSeedSchema } from "./package-checkout-contract.js";
import {
  type PackageCheckoutClaimGrant,
  type PackageCheckoutCustomer,
  readPackageCheckoutCustomer,
} from "./package-checkout-customer-authority.js";
import { verifyCertifiedPackageConsent } from "./package-consent-certification.js";
import {
  assessConsentCommitDeadline,
  PACKAGE_CONSENT_STRICT_LIFETIME_MS,
} from "./package-consent-commit-deadline.js";
import {
  acceptanceEvidenceSchema,
  consentEvidenceId,
  consentIssuanceWitness,
  insertConsentEvidence,
  issuanceEvidenceSchema,
  observationEvidenceSchema,
  readConsentEvidence,
} from "./package-consent-evidence.js";
import { observeConsentHost, verifyConsentHostObservation } from "./trusted-time/host-clock.js";
import { requireQualifiedConsentHost } from "./trusted-time/qualified-host.js";

const conflict = () =>
  new AppError("Consent identity, session or BusinessClient continuity changed", 409);

/** Approved P3B source protocol. The shipped clock registry still denies before sampling.
 * No timer/worker is added: exact-event HTTP retry runs recovery on the original operation. */
export class PackageConsentProtocol {
  async assertRetentionWindow(seedInput: unknown) {
    const profile = requireQualifiedConsentHost(),
      seed = packageCheckoutSeedSchema.parse(seedInput);
    if (!seed.consentEvidenceId) throw conflict();
    const observed = await observeConsentHost(digest({ phase: "RETENTION_ACKNOWLEDGED", seed }));
    if (seed.expiresAt.getTime() - observed.latestMs < profile.minRemainingMs) throw conflict();
  }
  async issue(seedInput: unknown, intent: z.infer<typeof packageCheckoutIntentSchema>) {
    const profile = requireQualifiedConsentHost(),
      proposed = packageCheckoutSeedSchema.parse(seedInput),
      intentHash = digest(intent);
    const existing = await readConsentEvidence(proposed.idempotencyKey, "ISSUANCE");
    if (existing) {
      const value = issuanceEvidenceSchema.parse(existing.payload);
      if (
        value.intentHash !== intentHash ||
        !value.customerUserId.equals(proposed.customerUserId) ||
        !value.businessId.equals(proposed.businessId)
      )
        throw conflict();
      verifyConsentHostObservation(value.observation, value.witnessHash);
      return value.seed;
    }
    const business = await BusinessModel.findById(proposed.businessId).orFail();
    if (!["APPROVED", "WARNING"].includes(business.status)) throw conflict();
    const address = intent.selections[0]?.travelAddress;
    const client = await resolveCustomerBusinessClient(
      new ClientRepository(),
      new UserRepository(),
      business,
      String(proposed.customerUserId),
      address
        ? { mode: "TRAVEL_TO_CUSTOMER", travelAddress: address }
        : { mode: "AT_BUSINESS_LOCATION" },
    );
    if (
      client.archivedAt ||
      client.linkState !== "LINKED" ||
      !client.linkedUserId?.equals(proposed.customerUserId)
    )
      throw conflict();
    const evidenceId = consentEvidenceId(proposed.idempotencyKey, "ISSUANCE"),
      generation = client.linkGeneration ?? 0;
    const draft = { ...proposed, consentEvidenceId: evidenceId };
    const witnessHash = consentIssuanceWitness(draft, intentHash, client._id, generation);
    const observation = await observeConsentHost(witnessHash);
    const anchor = Math.min(proposed.issuedAt.getTime(), observation.earliestMs);
    const seed = packageCheckoutSeedSchema.parse({
      ...draft,
      issuedAt: new Date(anchor),
      expiresAt: new Date(anchor + PACKAGE_CONSENT_STRICT_LIFETIME_MS),
    });
    if (seed.expiresAt.getTime() - observation.latestMs < profile.minRemainingMs) throw conflict();
    const payload = issuanceEvidenceSchema.parse({
      phase: "ISSUANCE",
      operationKey: seed.idempotencyKey,
      businessId: seed.businessId,
      customerUserId: seed.customerUserId,
      businessClientId: client._id,
      linkGeneration: generation,
      quoteId: seed.quoteId,
      seed,
      intentHash,
      observation,
      witnessHash,
    });
    try {
      await insertConsentEvidence(payload);
      return seed;
    } catch (error) {
      // Concurrent proposal or unknown insert: only the majority-visible original winner can
      // be adopted. Never slide its issuance or overwrite a different Customer/intent.
      const winner = await readConsentEvidence(seed.idempotencyKey, "ISSUANCE");
      if (!winner) throw error;
      const actual = issuanceEvidenceSchema.parse(winner.payload);
      if (
        actual.intentHash !== intentHash ||
        !actual.customerUserId.equals(seed.customerUserId) ||
        !actual.businessId.equals(seed.businessId)
      )
        throw conflict();
      verifyConsentHostObservation(actual.observation, actual.witnessHash);
      return actual.seed;
    }
  }

  async commit(
    grant: PackageCheckoutClaimGrant,
    proof: PackageCheckoutCustomer,
    businessId: Types.ObjectId,
    key: string,
  ) {
    const actor = readPackageCheckoutCustomer(proof);
    const issuance = await readConsentEvidence(key, "ISSUANCE");
    if (!issuance) throw conflict();
    const i = issuanceEvidenceSchema.parse(issuance.payload);
    verifyConsentHostObservation(i.observation, i.witnessHash);
    if (
      !i.businessId.equals(businessId) ||
      !i.customerUserId.equals(actor.userId) ||
      !Number.isSafeInteger(actor.jwtExpiresAtMs)
    )
      throw conflict();
    const session = await mongoose.startSession();
    // The opaque transition grant is single-use, so no automatic transaction callback retry.
    // A conflict/unknown commit is recovered by a new authenticated exact-event request.
    try {
      session.startTransaction({
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority", j: true, wtimeoutMS: 5000 },
      });
      const user = await UserModel.findOneAndUpdate(
        { _id: actor.userId, role: "CUSTOMER", status: "ACTIVE" },
        { $inc: { __v: 1 } },
        { session, returnDocument: "after" },
      );
      const live = await SessionModel.findOneAndUpdate(
        {
          tokenFamilyId: actor.sessionFamilyId,
          userId: actor.userId,
          revokedAt: { $exists: false },
          expiresAt: { $gt: new Date() },
        },
        { $inc: { __v: 1 } },
        { session, returnDocument: "after" },
      );
      const client = await BusinessClientModel.findOneAndUpdate(
        {
          _id: i.businessClientId,
          businessId,
          linkedUserId: actor.userId,
          linkState: "LINKED",
          archivedAt: { $exists: false },
          ...(i.linkGeneration === 0
            ? { $or: [{ linkGeneration: 0 }, { linkGeneration: { $exists: false } }] }
            : { linkGeneration: i.linkGeneration }),
        },
        { $inc: { consentFence: 1 } },
        { session, returnDocument: "after" },
      );
      if (!user || !live || !client) throw conflict();
      if (!(await commitPackageCheckoutClaimGrant(grant, session))) throw conflict();
      const row = await BookingCreationClaimModel.findOne({
        idempotencyKey: key,
        businessId,
        actorUserId: actor.userId,
      })
        .session(session)
        .orFail();
      const accepted = assertPackageAccepted(
        row.packageCheckoutRetention,
        row.packageCheckoutPresentation,
        row.packageCheckoutAcceptance,
      );
      if (
        !row.packageCheckoutRetention?.seed.consentEvidenceId?.equals(issuance._id) ||
        digest(row.packageCheckoutRetention.seed) !== digest(i.seed) ||
        accepted.sessionFamilyId !== actor.sessionFamilyId
      )
        throw conflict();
      const {
        seed: _seed,
        intentHash: _intent,
        observation: _obs,
        witnessHash: _witness,
        ...binding
      } = i;
      const payload = acceptanceEvidenceSchema.parse({
        ...binding,
        phase: "ACCEPTANCE",
        claimId: row._id,
        issuanceId: issuance._id,
        termsHash: row.packageCheckoutRetention.quote.termsHash,
        disclosureHash: accepted.disclosureHash,
        acceptanceHash: digest(accepted),
        eventId: accepted.event.eventId,
        sessionFamilyId: actor.sessionFamilyId,
        sessionId: live._id,
        userVersion: digest(user.security),
        sessionExpiresAtMs: live.expiresAt.getTime(),
        jwtExpiresAtMs: actor.jwtExpiresAtMs,
      });
      // Strict object: retain only canonical ACCEPTANCE fields, not the issuance sample/seed.
      await insertConsentEvidence(payload, session);
      await session.commitTransaction();
    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction().catch(() => undefined);
      // Unknown never becomes failure/abort authority. Recovery must positively majority-read
      // the original claim and ACCEPTANCE event; no second event is synthesized here.
      throw error;
    } finally {
      await session.endSession();
    }
    await this.certify(key);
  }

  async certify(key: string) {
    if (await readConsentEvidence(key, "CERTIFICATION")) {
      const original = await BookingCreationClaimModel.findOne({ idempotencyKey: key })
        .read("primary")
        .readConcern("majority")
        .maxTimeMS(2000)
        .orFail();
      await verifyCertifiedPackageConsent(original.toObject());
      return;
    }
    const profile = requireQualifiedConsentHost();
    // M: positive majority observation of the evidence committed in the SAME transaction as C.
    const acceptance = await readConsentEvidence(key, "ACCEPTANCE");
    const issuance = await readConsentEvidence(key, "ISSUANCE");
    if (!acceptance || !issuance) throw conflict();
    const a = acceptanceEvidenceSchema.parse(acceptance.payload),
      i = issuanceEvidenceSchema.parse(issuance.payload);
    const claim = await BookingCreationClaimModel.findOne({ _id: a.claimId, idempotencyKey: key })
      .read("primary")
      .readConcern("majority")
      .orFail();
    if (digest(claim.packageCheckoutAcceptance) !== a.acceptanceHash) throw conflict();
    const issue = verifyConsentHostObservation(i.observation, i.witnessHash);
    let stored = await readConsentEvidence(key, "OBSERVATION");
    if (!stored) {
      // O cannot be obtained until M completed. The sealed witness is the exact majority-read
      // immutable record hash; an old sample, pre-commit time or different event cannot match.
      const nonce = randomBytes(32).toString("hex");
      const observation = await observeConsentHost(
        digest({ acceptanceRecordHash: acceptance.contentHash, nonce }),
      );
      const payload = observationEvidenceSchema.parse({
        operationKey: key,
        businessId: a.businessId,
        customerUserId: a.customerUserId,
        businessClientId: a.businessClientId,
        linkGeneration: a.linkGeneration,
        quoteId: a.quoteId,
        phase: "OBSERVATION",
        acceptanceId: acceptance._id,
        acceptanceRecordHash: acceptance.contentHash,
        nonce,
        observation,
      });
      try {
        stored = await insertConsentEvidence(payload);
      } catch (error) {
        stored = await readConsentEvidence(key, "OBSERVATION");
        if (!stored) throw error;
      }
    }
    const o = observationEvidenceSchema.parse(stored.payload),
      commit = verifyConsentHostObservation(
        o.observation,
        digest({ acceptanceRecordHash: acceptance.contentHash, nonce: o.nonce }),
      );
    if (o.acceptanceRecordHash !== acceptance.contentHash || !o.acceptanceId.equals(acceptance._id))
      throw conflict();
    const result = assessConsentCommitDeadline(
      {
        retainedIssuedAtMs: i.seed.issuedAt.getTime(),
        retainedExpiresAtMs: i.seed.expiresAt.getTime(),
        issuanceAttestation: issue,
        postCommitObservation: commit,
      },
      [profile.authorityId],
    );
    if (
      result.kind !== "CERTIFIED" ||
      issue.bootId !== commit.bootId ||
      issue.latestMs > commit.latestMs ||
      commit.latestMs >= Math.min(a.jwtExpiresAtMs, a.sessionExpiresAtMs)
    )
      throw new AppError(
        "Consent commit could not be proven before its deadline/session expiry",
        503,
      );
    await insertConsentEvidence({
      phase: "CERTIFICATION",
      state: "CERTIFIED",
      operationKey: key,
      businessId: a.businessId,
      customerUserId: a.customerUserId,
      businessClientId: a.businessClientId,
      linkGeneration: a.linkGeneration,
      quoteId: a.quoteId,
      claimId: a.claimId,
      issuanceId: issuance._id,
      acceptanceId: acceptance._id,
      observationId: stored._id,
      acceptanceRecordHash: acceptance.contentHash,
      termsHash: a.termsHash,
      disclosureHash: a.disclosureHash,
      acceptanceHash: a.acceptanceHash,
      eventId: a.eventId,
      deadlineMs: result.deadlineMs,
      commitLatestMs: result.commitLatestMs,
    });
  }
}
