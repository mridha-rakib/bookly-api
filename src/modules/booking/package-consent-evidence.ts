import { createHash } from "node:crypto";
import { type ClientSession, model, Schema, Types } from "mongoose";
import { z } from "zod";
import { hashCanonicalPackageCheckoutContent as digest } from "./package-checkout-binding.js";
import { packageCheckoutSeedSchema } from "./package-checkout-contract.js";
import { hostObservationSchema } from "./trusted-time/host-clock.js";

const id = z.instanceof(Types.ObjectId),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const binding = z
  .object({
    operationKey: z.string().min(1),
    businessId: id,
    customerUserId: id,
    businessClientId: id,
    linkGeneration: z.number().int().safe().nonnegative(),
    quoteId: id,
  })
  .strict();
export const issuanceEvidenceSchema = binding
  .extend({
    phase: z.literal("ISSUANCE"),
    seed: packageCheckoutSeedSchema,
    intentHash: hash,
    observation: hostObservationSchema,
    witnessHash: hash,
  })
  .strict();
export const acceptanceEvidenceSchema = binding
  .extend({
    phase: z.literal("ACCEPTANCE"),
    claimId: id,
    issuanceId: id,
    termsHash: hash,
    disclosureHash: hash,
    acceptanceHash: hash,
    eventId: z.uuid(),
    sessionFamilyId: z.string().min(1),
    sessionId: id,
    userVersion: z.string(),
    sessionExpiresAtMs: z.number().int().safe(),
    jwtExpiresAtMs: z.number().int().safe(),
  })
  .strict();
export const certificationEvidenceSchema = binding
  .extend({
    phase: z.literal("CERTIFICATION"),
    state: z.literal("CERTIFIED"),
    claimId: id,
    issuanceId: id,
    acceptanceId: id,
    observationId: id,
    acceptanceRecordHash: hash,
    termsHash: hash,
    disclosureHash: hash,
    acceptanceHash: hash,
    eventId: z.uuid(),
    deadlineMs: z.number().int().safe(),
    commitLatestMs: z.number().int().safe(),
  })
  .strict();
export const observationEvidenceSchema = binding
  .extend({
    phase: z.literal("OBSERVATION"),
    acceptanceId: id,
    acceptanceRecordHash: hash,
    nonce: hash,
    observation: hostObservationSchema,
  })
  .strict();
export const consentEvidencePayloadSchema = z.discriminatedUnion("phase", [
  issuanceEvidenceSchema,
  acceptanceEvidenceSchema,
  observationEvidenceSchema,
  certificationEvidenceSchema,
]);
export type ConsentEvidencePayload = z.infer<typeof consentEvidencePayloadSchema>;
export type ConsentEvidence = {
  _id: Types.ObjectId;
  operationKey: string;
  phase: ConsentEvidencePayload["phase"];
  payload: ConsentEvidencePayload;
  contentHash: string;
};
const schema = new Schema<ConsentEvidence>(
  {
    _id: { type: Schema.Types.ObjectId, required: true },
    operationKey: { type: String, required: true },
    phase: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    contentHash: { type: String, required: true },
  },
  { versionKey: false },
);
schema.index({ operationKey: 1, phase: 1 }, { unique: true });
const inserts = new WeakSet<object>();
schema.pre("save", function () {
  if (!this.isNew || !inserts.has(this))
    throw Error("Consent evidence is insert-only through its canonical repository");
  inserts.delete(this);
  verifyConsentEvidenceRecord(this.toObject());
});
schema.pre(
  [
    "updateOne",
    "updateMany",
    "findOneAndUpdate",
    "replaceOne",
    "findOneAndReplace",
    "deleteOne",
    "deleteMany",
    "findOneAndDelete",
    "bulkWrite",
    "insertMany",
  ],
  () => {
    throw Error("Consent evidence cannot be changed or erased");
  },
);
schema.pre("deleteOne", { document: true, query: false }, () => {
  throw Error("Consent evidence cannot be erased");
});
export const PackageConsentEvidenceModel = model<ConsentEvidence>("PackageConsentEvidence", schema);
export const consentEvidenceId = (operationKey: string, phase: ConsentEvidencePayload["phase"]) =>
  new Types.ObjectId(
    createHash("sha256")
      .update(`bookly:consent-evidence:v1:${operationKey}:${phase}`)
      .digest("hex")
      .slice(0, 24),
  );
export const consentIssuanceWitness = (
  seed: z.infer<typeof packageCheckoutSeedSchema>,
  intentHash: string,
  clientId: Types.ObjectId,
  generation: number,
) => {
  const { issuedAt: _issued, expiresAt: _expires, ...identity } = seed;
  return digest({ identity, intentHash, businessClientId: clientId, linkGeneration: generation });
};
export function verifyConsentEvidenceRecord(input: ConsentEvidence): ConsentEvidence {
  const payload = consentEvidencePayloadSchema.parse(input.payload);
  if (
    input.operationKey !== payload.operationKey ||
    input.phase !== payload.phase ||
    !input._id.equals(consentEvidenceId(payload.operationKey, payload.phase)) ||
    input.contentHash !== digest(payload)
  )
    throw Error("Consent evidence integrity mismatch");
  return {
    _id: input._id,
    operationKey: input.operationKey,
    phase: input.phase,
    payload,
    contentHash: input.contentHash,
  };
}
export async function readConsentEvidence(
  operationKey: string,
  phase: ConsentEvidencePayload["phase"],
  session?: ClientSession,
) {
  const query = PackageConsentEvidenceModel.findOne({ operationKey, phase })
    .session(session ?? null)
    .read("primary")
    .maxTimeMS(2000);
  if (!session) query.readConcern("majority");
  const row = await query;
  return row ? verifyConsentEvidenceRecord(row.toObject()) : null;
}
export async function insertConsentEvidence(
  input: ConsentEvidencePayload,
  session?: ClientSession,
): Promise<ConsentEvidence> {
  const payload = consentEvidencePayloadSchema.parse(input),
    contentHash = digest(payload);
  const record = {
    _id: consentEvidenceId(payload.operationKey, payload.phase),
    operationKey: payload.operationKey,
    phase: payload.phase,
    payload,
    contentHash,
  };
  try {
    const doc = new PackageConsentEvidenceModel(record);
    inserts.add(doc);
    await doc.save(session ? { session } : { w: "majority", j: true, wtimeout: 5000 });
    return record;
  } catch (error) {
    if (
      session ||
      !(typeof error === "object" && error !== null && "code" in error && error.code === 11000)
    )
      throw error;
    const winner = await readConsentEvidence(payload.operationKey, payload.phase);
    if (!winner || winner.contentHash !== contentHash)
      throw Error("Conflicting immutable consent evidence");
    return winner;
  }
}
