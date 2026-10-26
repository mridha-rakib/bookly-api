import { isDeepStrictEqual } from "node:util";
import { type ClientSession, model, Schema, type SchemaDefinition } from "mongoose";
import { packageGroupSeatMongooseSchema } from "../packages/package-service-entitlement.js";
import { PackageProgressModel } from "./package-progress.model.js";
import { packageProgressV2InputSchema } from "./package-progress-v2.rules.js";
import type {
  PackageProgressV2Document,
  ProspectivePackageProgressV2Document,
} from "./package-progress-v2.types.js";

const number = {
  type: Number,
  required: true,
  min: 0,
  max: Number.MAX_SAFE_INTEGER,
  validate: Number.isSafeInteger,
};
const objectId = { type: Schema.Types.ObjectId, required: true };
const nested = (fields: SchemaDefinition) => new Schema(fields, { _id: false, strict: "throw" });
const requiredDate = { type: Date, required: true };
const requiredString = { type: String, required: true };
const version = { type: Number, required: true, enum: [1] };
const identity = { packageItemId: objectId, definitionItemId: objectId, serviceId: objectId };
const definitionValidity = nested({ mode: requiredString, months: Number });
const contract = nested({
  contractVersion: version,
  definition: {
    type: nested({
      packageId: objectId,
      packageRevision: number,
      contractTerms: {
        type: nested({
          version: { type: Number, required: true },
          validityMonths: Number,
          validity: { type: definitionValidity },
          penaltyPolicyVersion: version,
        }),
        required: true,
      },
    }),
    required: true,
  },
  validity: {
    type: nested({
      contractVersion: version,
      mode: requiredString,
      purchasedAt: requiredDate,
      activationId: objectId,
      batchId: objectId,
      months: Number,
      timezone: String,
      expiresAt: Date,
      calculation: { type: nested({ version, provenanceRef: objectId }) },
      activationWindow: {
        type: nested({
          version,
          quoteId: objectId,
          batchId: objectId,
          notBefore: requiredDate,
          notAfterExclusive: requiredDate,
        }),
      },
      expiryDisclosure: {
        type: nested({
          version,
          quoteId: objectId,
          acceptedTermsPayloadId: objectId,
          acceptedTermsHash: requiredString,
          guaranteedNotBeforeExpiry: requiredDate,
        }),
      },
    }),
    required: true,
  },
  penalty: {
    type: nested({
      policyVersion: version,
      currency: requiredString,
      soldBundlePriceCents: number,
      appointmentCapCents: number,
      lifetimeCapCents: number,
      noPurchaseDepositOffset: { type: Boolean, required: true },
      scope: requiredString,
      provenance: requiredString,
      captureBudgetSemantics: {
        type: nested({
          succeeded: requiredString,
          pendingOrUnknown: requiredString,
          definitiveNonCollection: requiredString,
          refundsAndDisputes: requiredString,
          fixedAssessment: requiredString,
        }),
        required: true,
      },
    }),
    required: true,
  },
  acceptance: {
    type: nested({
      version,
      contractVersion: version,
      acceptanceId: objectId,
      acceptedTermsPayloadId: objectId,
      acceptedTermsHash: requiredString,
      templateId: objectId,
      templateVersion: version,
      actorUserId: objectId,
      customerUserId: objectId,
      actorRole: requiredString,
      acceptedAt: requiredDate,
      businessId: objectId,
      packageId: objectId,
      packageRevision: number,
      packageProgressId: objectId,
      batchId: objectId,
      quoteId: objectId,
      provenance: requiredString,
      scope: requiredString,
      items: { type: [nested(identity)], required: true, default: undefined },
    }),
    required: true,
  },
  activation: {
    type: nested({
      version,
      contractVersion: version,
      activationId: objectId,
      activationEventId: objectId,
      batchId: objectId,
      packageProgressId: objectId,
      businessId: objectId,
      customerUserId: objectId,
      packageId: objectId,
      packageRevision: number,
      acceptanceId: objectId,
      purchasedAt: requiredDate,
      provenance: requiredString,
    }),
    required: true,
  },
});
const item = new Schema(
  {
    packageItemId: objectId,
    definitionItemId: objectId,
    serviceId: objectId,
    serviceSnapshot: {
      type: new Schema(
        {
          name: { type: String, required: true },
          pricingMode: { type: String, enum: ["FIXED", "PER_PERSON"], required: true },
          group: { type: packageGroupSeatMongooseSchema, required: false },
          durationMin: { ...number, min: 1 },
        },
        { _id: false, strict: "throw" },
      ),
      required: true,
    },
    totalSessions: { ...number, min: 1 },
    remainingSessions: number,
    completedSessions: number,
    penaltyBasisCents: { ...number, required: false, max: 5000 },
    expiredSessions: { ...number, required: false },
    expiryEvent: {
      type: nested({
        eventKey: requiredString,
        packageProgressId: objectId,
        packageItemId: objectId,
        cutoff: requiredDate,
        quantity: number,
        reason: requiredString,
        processedAt: requiredDate,
      }),
    },
    referenceUnitPriceCents: { ...number, min: 1 },
    travelCities: {
      type: [
        new Schema(
          { city: { type: String, required: true }, feeCents: number },
          { _id: false, strict: "throw" },
        ),
      ],
      default: undefined,
    },
  },
  { _id: false, strict: "throw" },
);
const snapshot = new Schema(
  {
    name: { type: String, required: true },
    packageRevision: { ...number, min: 1 },
    bundlePriceCents: number,
    referenceTotalCents: { ...number, min: 1 },
    discountPercent: { type: Number, required: true, min: 0, max: 100 },
    currency: { type: String, enum: ["EUR"], required: true },
    fulfilmentMode: {
      type: String,
      enum: ["AT_BUSINESS_LOCATION", "TRAVEL_TO_CUSTOMER"],
      required: true,
    },
  },
  { _id: false, strict: "throw" },
);
const attempt = new Schema(
  {
    bookingId: objectId,
    packageItemId: objectId,
    serviceId: objectId,
    sessionIndex: { ...number, required: false, min: 1 },
    status: {
      type: String,
      enum: ["SCHEDULED", "COMPLETED", "CANCELLED", "FORFEITED"],
      required: true,
    },
    resolution: {
      type: nested({
        eventKey: requiredString,
        resolvedAt: requiredDate,
        outcome: requiredString,
        restorationDisposition: String,
      }),
    },
  },
  { _id: false, strict: "throw" },
);
export const packageProgressV2Schema = new Schema<PackageProgressV2Document>(
  {
    schemaVersion: { type: Number, enum: [2], required: true },
    creditAccountingVersion: { type: Number, enum: [1, 2] },
    purchasedContract: { type: contract },
    expiryReconciledAt: Date,
    businessId: objectId,
    customerUserId: objectId,
    businessClientId: objectId,
    packageId: objectId,
    originBookingId: objectId,
    purchaseSnapshot: { type: snapshot, required: true },
    items: { type: [item], required: true },
    sessions: { type: [attempt], required: true, default: [] },
    voidedAt: Date,
    voidRefundSettlement: {
      type: new Schema(
        {
          status: { type: String, enum: ["PENDING", "SUCCEEDED", "FAILED"], required: true },
          amountCents: { ...number, min: 1 },
          refundOperationId: Schema.Types.ObjectId,
          providerRefundId: String,
        },
        { _id: false, strict: "throw" },
      ),
    },
  },
  { collection: "packageprogresses", timestamps: true, versionKey: false, strict: "throw" },
);

packageProgressV2Schema.pre("validate", function () {
  const { createdAt: _created, updatedAt: _updated, ...input } = this.toObject();
  const parsed = packageProgressV2InputSchema.safeParse(input);
  if (!parsed.success) this.invalidate("items", parsed.error.message);
});
packageProgressV2Schema.pre("save", function () {
  if (!this.isNew)
    throw new Error("Purchased terms are immutable; use guarded v2 repository operations");
  const { createdAt: _created, updatedAt: _updated, ...input } = this.toObject();
  packageProgressV2InputSchema.parse(input);
});
const guardedTransitions = new WeakSet<object>();
packageProgressV2Schema.pre(
  [
    "find",
    "findOne",
    "countDocuments",
    "findOneAndUpdate",
    "updateOne",
    "updateMany",
    "deleteOne",
    "deleteMany",
    "replaceOne",
    "findOneAndReplace",
    "findOneAndDelete",
  ],
  function () {
    this.and([{ schemaVersion: 2 }]);
    const update = this.getUpdate();
    if (guardedTransitions.has(this)) return;
    // Old low-level writes cannot touch a prospective row. New transitions use the
    // private query capability below, after strict invariant and immutable-term checks.
    if (update) this.and([{ creditAccountingVersion: { $ne: 2 } }]);
    if (this.getOptions().upsert) throw new Error("v2 query upserts are not permitted");
    if (update) {
      if (Array.isArray(update)) throw new Error("v2 pipeline replacement is not permitted");
      for (const [operator, fields] of Object.entries(update)) {
        if (operator === "$setOnInsert") {
          if (Object.keys(fields).some((path) => path !== "createdAt"))
            throw new Error("Purchased terms are immutable");
          continue;
        }
        for (const path of Object.keys(fields)) {
          const allowed =
            operator === "$inc"
              ? /^items\.\$\[item\]\.(remainingSessions|completedSessions)$/.test(path)
              : operator === "$push"
                ? path === "sessions"
                : operator === "$set" &&
                  (/^sessions\.\$\[attempt\]\.status$/.test(path) ||
                    path === "voidedAt" ||
                    path === "updatedAt" ||
                    path === "voidRefundSettlement" ||
                    path.startsWith("voidRefundSettlement."));
          if (!allowed)
            throw new Error("Purchased terms are immutable; use guarded repository operations");
        }
      }
    }
  },
);
packageProgressV2Schema.pre(["deleteOne", "deleteMany", "findOneAndDelete"], function () {
  this.and([{ creditAccountingVersion: { $ne: 2 } }]);
});
packageProgressV2Schema.pre("insertMany", () => {
  throw new Error("Use validated v2 creation");
});
packageProgressV2Schema.pre("bulkWrite", () => {
  throw new Error("Use guarded v2 repository operations");
});
// Both typed models address ONE collection. Identical index declarations prevent a model's
// isolated-test syncIndexes from dropping the other version's indexes.
for (const [keys, options] of PackageProgressModel.schema.indexes())
  packageProgressV2Schema.index(keys, options);

export const PackageProgressV2Model = model<PackageProgressV2Document>(
  "PackageProgressV2",
  packageProgressV2Schema,
);

/** Internal persistence bridge, not a public mutation API. Numeric counter/event paths
 * are derived here; neither callers nor query options can authorize arbitrary paths.
 * Caller must hold the Business fence and compose the real lifecycle in its transaction.
 */
export const commitProspectivePackageTransition = async (
  before: ProspectivePackageProgressV2Document,
  after: ProspectivePackageProgressV2Document,
  session: ClientSession,
): Promise<void> => {
  if (!session.inTransaction()) throw new Error("Package transaction required");
  const { createdAt: _created, updatedAt: _updated, ...input } = after;
  packageProgressV2InputSchema.parse(input);
  const immutable = (progress: ProspectivePackageProgressV2Document) => ({
    ...progress,
    updatedAt: undefined,
    voidedAt: undefined,
    expiryReconciledAt: undefined,
    items: progress.items.map(
      ({
        remainingSessions: _r,
        completedSessions: _c,
        expiredSessions: _x,
        expiryEvent: _event,
        ...item
      }) => item,
    ),
    sessions: undefined,
  });
  if (!isDeepStrictEqual(immutable(before), immutable(after)))
    throw new Error("Purchased terms are immutable");
  if (before.voidedAt && !isDeepStrictEqual(before.voidedAt, after.voidedAt))
    throw new Error("Void restriction is immutable");
  if (
    before.expiryReconciledAt &&
    !isDeepStrictEqual(before.expiryReconciledAt, after.expiryReconciledAt)
  )
    throw new Error("Expiry boundary is immutable");
  const set: Record<string, unknown> = {};
  for (const [index, item] of after.items.entries()) {
    const old = before.items[index];
    if (!old) throw new Error("Purchased membership is immutable");
    if (old.expiryEvent && !isDeepStrictEqual(old.expiryEvent, item.expiryEvent))
      throw new Error("Expiry event is immutable");
    for (const key of [
      "remainingSessions",
      "completedSessions",
      "expiredSessions",
      "expiryEvent",
    ] as const)
      if (!isDeepStrictEqual(old[key], item[key])) set[`items.${index}.${key}`] = item[key];
  }
  for (const [index, old] of before.sessions.entries()) {
    const current = after.sessions[index];
    if (
      !current ||
      !old.bookingId.equals(current.bookingId) ||
      !old.packageItemId.equals(current.packageItemId) ||
      !old.serviceId.equals(current.serviceId) ||
      old.sessionIndex !== current.sessionIndex
    )
      throw new Error("Attempt identity is immutable");
    if (old.status !== "SCHEDULED" && !isDeepStrictEqual(old, current))
      throw new Error("Terminal outcome is immutable");
    if (!isDeepStrictEqual(old, current)) {
      set[`sessions.${index}.status`] = current.status;
      set[`sessions.${index}.resolution`] = current.resolution;
    }
  }
  const additions = after.sessions.slice(before.sessions.length);
  if (
    additions.length > 1 ||
    additions.some((attempt) => attempt.status !== "SCHEDULED" || attempt.resolution)
  )
    throw new Error("Invalid new attempt");
  for (const key of ["expiryReconciledAt", "voidedAt"] as const)
    if (!isDeepStrictEqual(before[key], after[key])) set[key] = after[key];
  const query = PackageProgressV2Model.updateOne(
    {
      _id: before._id,
      businessId: before.businessId,
      customerUserId: before.customerUserId,
      creditAccountingVersion: 2,
      updatedAt: before.updatedAt,
    },
    { $set: set, ...(additions.length ? { $push: { sessions: additions[0] } } : {}) },
    { session },
  );
  guardedTransitions.add(query);
  const result = await query;
  if (result.matchedCount !== 1) throw new Error("Concurrent Package transition conflict");
};
