import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { type ClientSession, model, Schema, Types } from "mongoose";
import { BusinessClientModel } from "../client/client.model.js";
import { generateBookingReference } from "./booking.utils.js";
import type { FinancialContract } from "./financial-contract.js";
import { financialContractSchema } from "./financial-contract.model.js";
import { verifyPackageBatchActivation } from "./package-batch-authority.js";
import {
  type BatchCompletion,
  type BatchDeliveryTask,
  type BatchFinance,
  batchCompletionSchema,
  batchDeliveryTaskSchema,
  batchFinanceSchema,
} from "./package-batch-completion-contract.js";
import {
  assertBatchMaterialization,
  assertBatchPreparation,
  batchConflict,
  canonicalPackageBatch,
  type PackageBatchControl,
  type PackageBatchMaterialization,
  type PackageBatchPreparation,
  packageBatchControlSchema,
} from "./package-batch-contract.js";
import { verifyPackageBatchMembers } from "./package-batch-membership.js";
import {
  assertPackageAccepted,
  assertPackagePresentation,
  type PackageCheckoutAccepted,
  type PackageCheckoutPresentation,
} from "./package-checkout-acceptance.js";
import { hashCanonicalPackageCheckoutContent } from "./package-checkout-binding.js";
import {
  type PackageCheckoutClaimGrant,
  type PackageCheckoutCustomer,
  readPackageCheckoutClaimGrant,
  readPackageCheckoutCustomer,
} from "./package-checkout-customer-authority.js";
import {
  type PackageCheckoutRetention,
  packageCheckoutRetentionSchema,
} from "./package-checkout-retention.js";
import {
  type PackageRequestBinding,
  packageRequestBindingMongooseSchema,
  packageRequestBindingSchema,
} from "./package-request-binding.js";

/**
 * Booking-creation idempotency contract (Batch 3) — mirrors
 * booking-slot-reservation-claim.model.ts's proven design exactly: a flat, single-level unique
 * index is the only reliably-enforced form of MongoDB uniqueness (see that model's own doc
 * comment for the empirical finding this is based on), so idempotency for the much larger
 * Booking-creation operation reuses the same primitive rather than inventing a second scheme.
 *
 * `bookingId` is populated with a client-generated (`new Types.ObjectId()`) id BEFORE the
 * Booking document itself is written — the claim is inserted first, outside the creation
 * transaction (see BookingCreationService.createManualBooking), so a losing concurrent request
 * with the same key can immediately resolve to the winner's `bookingId` without waiting on or
 * inspecting the transaction. If the subsequent transactional creation fails for any reason
 * (a genuine validation error, a reservation conflict, a transient transaction error), a
 * no-payment flow deletes the claim. A charge-bearing flow deliberately retains it and links
 * the same logical key/booking id through PaymentAttempt so an ambiguous retry cannot create a
 * second provider operation.
 */
export type BookingCreationClaimDocument = {
  packageBatchFinance?: BatchFinance | undefined;
  packageBatchCompletion?: BatchCompletion | undefined;
  packageBatchDelivery?: BatchDeliveryTask[] | undefined;
  packageBatchPreparation?: PackageBatchPreparation | undefined;
  packageBatchControl?: PackageBatchControl | undefined;
  packageBatchMaterialization?: PackageBatchMaterialization | undefined;
  packageCheckoutPresentation?: PackageCheckoutPresentation | undefined;
  packageCheckoutAcceptance?: PackageCheckoutAccepted | undefined;
  /** P3-B1: durable unaccepted offer only; excluded from ordinary release/payment paths. */
  packageCheckoutRetention?: PackageCheckoutRetention | undefined;
  packageRequestBinding?: PackageRequestBinding | undefined;
  _id: Types.ObjectId;
  idempotencyKey: string;
  businessId: Types.ObjectId;
  actorUserId: Types.ObjectId;
  bookingId: Types.ObjectId;
  /** P1 — the immutable Financial Contract V2 for a customer booking/package purchase, recorded
   * once (set-if-absent) BEFORE any provider charge. Absent for manual bookings, package
   * Session 2+ redemptions, and claims created before P1. */
  financialContract?: FinancialContract | undefined;
  createdAt: Date;
};

const bookingCreationClaimSchema = new Schema<BookingCreationClaimDocument>(
  {
    packageBatchFinance: { type: Schema.Types.Mixed },
    packageBatchCompletion: { type: Schema.Types.Mixed },
    packageBatchDelivery: { type: Schema.Types.Mixed },
    packageBatchPreparation: { type: Schema.Types.Mixed },
    packageBatchControl: { type: Schema.Types.Mixed },
    packageBatchMaterialization: { type: Schema.Types.Mixed },
    packageCheckoutPresentation: { type: Schema.Types.Mixed },
    packageCheckoutAcceptance: { type: Schema.Types.Mixed },
    packageCheckoutRetention: { type: Schema.Types.Mixed },
    packageRequestBinding: { type: packageRequestBindingMongooseSchema },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 200 },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    financialContract: { type: financialContractSchema },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

bookingCreationClaimSchema.index({ idempotencyKey: 1 }, { unique: true });
const checkoutTransitions = new WeakSet<object>();
const batchTransitions = new WeakSet<object>();
const freshBatchMaterializations = new WeakMap<
  ClientSession,
  {
    transactionNumber: number;
    claims: Map<string, { token: string; proofHash: string }>;
  }
>();
/** Read-only assertion, never an activation issuer or an option bypass. The driver constructs
 * a fresh transaction number on each attempt. Call only after a session command has applied
 * that number; both guarded callers perform an authoritative same-session read first. */
export function assertFreshPackageBatchMaterialization(
  session: ClientSession,
  claimId: Types.ObjectId | string,
) {
  const grant = freshBatchMaterializations.get(session);
  if (
    !session.inTransaction() ||
    !grant ||
    grant.transactionNumber !== session.serverSession.txnNumber ||
    !grant.claims.has(String(claimId))
  )
    throw batchConflict();
}
const batchRoots = [
  "packageBatchFinance",
  "packageBatchCompletion",
  "packageBatchDelivery",
  "packageBatchPreparation",
  "packageBatchControl",
  "packageBatchMaterialization",
];
// Save guards also run when a caller disables Mongoose validation.
bookingCreationClaimSchema.pre("save", function () {
  if (
    batchRoots.some((key) => this.isModified(key)) ||
    (this.isNew && (this.packageCheckoutPresentation || this.packageCheckoutAcceptance)) ||
    (!this.isNew &&
      [
        "packageCheckoutRetention",
        "packageCheckoutPresentation",
        "packageCheckoutAcceptance",
        "idempotencyKey",
        "businessId",
        "actorUserId",
        "bookingId",
      ].some((key) => this.isModified(key))) ||
    (this.packageCheckoutRetention && (this.financialContract || this.packageRequestBinding))
  )
    throw new Error(
      "Checkout claim identity/evidence is immutable; use verified canonical transition",
    );
});
bookingCreationClaimSchema.pre("validate", function () {
  if (this.packageBatchFinance) batchFinanceSchema.parse(this.packageBatchFinance);
  if (this.packageBatchCompletion) batchCompletionSchema.parse(this.packageBatchCompletion);
  if (this.packageBatchDelivery)
    this.packageBatchDelivery.forEach((t) => {
      batchDeliveryTaskSchema.parse(t);
    });
  if (
    this.packageBatchPreparation ||
    this.packageBatchControl ||
    this.packageBatchMaterialization
  ) {
    try {
      const p = assertBatchPreparation(this.toObject(), this.packageBatchPreparation);
      const control = packageBatchControlSchema.parse(this.packageBatchControl);
      if (this.packageBatchMaterialization)
        assertBatchMaterialization(p, this.packageBatchMaterialization);
      if (
        ["INTERNAL_MATERIALIZED", "PREPARATION_COMPLETE"].includes(control.phase) !==
          Boolean(this.packageBatchMaterialization) ||
        (control.phase === "PREPARATION_COMPLETE") !== Boolean(this.packageBatchCompletion)
      )
        throw batchConflict();
    } catch (error) {
      this.invalidate("packageBatchPreparation", String(error));
    }
  }
  if (
    (this.isNew && (this.packageCheckoutPresentation || this.packageCheckoutAcceptance)) ||
    (!this.isNew &&
      ["packageCheckoutPresentation", "packageCheckoutAcceptance"].some((key) =>
        this.isModified(key),
      ))
  )
    this.invalidate("packageCheckoutAcceptance", "Use verified canonical checkout transition");
  if (this.packageCheckoutPresentation || this.packageCheckoutAcceptance) {
    try {
      assertPackagePresentation(this.packageCheckoutRetention, this.packageCheckoutPresentation);
      if (this.packageCheckoutAcceptance)
        assertPackageAccepted(
          this.packageCheckoutRetention,
          this.packageCheckoutPresentation,
          this.packageCheckoutAcceptance,
        );
    } catch (error) {
      this.invalidate("packageCheckoutAcceptance", String(error));
    }
  }
  if (
    !this.isNew &&
    ["packageCheckoutRetention", "idempotencyKey", "businessId", "actorUserId", "bookingId"].some(
      (key) => this.isModified(key),
    )
  )
    this.invalidate("packageCheckoutRetention", "Creation claim identity/retention is immutable");
  if (this.packageCheckoutRetention) {
    const result = packageCheckoutRetentionSchema.safeParse(
      this.toObject().packageCheckoutRetention,
    );
    if (!result.success) this.invalidate("packageCheckoutRetention", result.error.message);
    else {
      const quote = result.data.quote.payload;
      if (
        this.packageRequestBinding ||
        this.financialContract ||
        this.idempotencyKey !== quote.idempotencyKey ||
        !this.businessId.equals(quote.businessId) ||
        !this.actorUserId.equals(quote.actorUserId) ||
        !this.bookingId.equals(quote.originBookingId)
      )
        this.invalidate(
          "packageCheckoutRetention",
          "Unaccepted checkout claim scope/authority mismatch",
        );
    }
  }
  if (!this.isNew && this.isModified("packageRequestBinding"))
    this.invalidate("packageRequestBinding", "Accepted request binding is immutable");
  if (this.packageRequestBinding) {
    const result = packageRequestBindingSchema.safeParse(this.toObject().packageRequestBinding);
    if (!result.success) {
      this.invalidate("packageRequestBinding", result.error.message);
      return;
    }
    const binding = result.data;
    if (
      binding.operation === "PURCHASE" &&
      binding.acceptedPurchaseSnapshot &&
      (!binding.acceptedPurchaseSnapshot.businessId.equals(this.businessId) ||
        !binding.acceptedPurchaseSnapshot.customerUserId.equals(this.actorUserId) ||
        !binding.acceptedPurchaseSnapshot.originBookingId.equals(this.bookingId))
    ) {
      this.invalidate("packageRequestBinding", "Accepted snapshot does not belong to this claim");
    }
  }
});
bookingCreationClaimSchema.pre(["replaceOne", "findOneAndReplace"], () => {
  throw new Error("Creation claim identity/retention is immutable");
});
bookingCreationClaimSchema.pre(["updateOne", "updateMany", "findOneAndUpdate"], function () {
  if (batchTransitions.has(this)) {
    batchTransitions.delete(this);
    return;
  }
  if (checkoutTransitions.has(this)) return;
  const update = this.getUpdate();
  const protectedRoots = [
    ...batchRoots,
    "packageCheckoutPresentation",
    "packageCheckoutAcceptance",
    "packageCheckoutRetention",
    "idempotencyKey",
    "businessId",
    "actorUserId",
    "bookingId",
  ];
  const touchesIdentity = (fields: object) =>
    Object.keys(fields).some((key) =>
      protectedRoots.some((root) => key === root || key.startsWith(`${root}.`)),
    );
  if (
    update &&
    (Array.isArray(update) ||
      touchesIdentity(update) ||
      Object.entries(update).some(
        ([operator, fields]) =>
          operator.startsWith("$") &&
          fields &&
          typeof fields === "object" &&
          (touchesIdentity(fields) ||
            Object.values(fields).some(
              (target) =>
                typeof target === "string" &&
                protectedRoots.some((root) => target === root || target.startsWith(`${root}.`)),
            )),
      ))
  )
    throw new Error("Creation claim identity/retention is immutable");
  // An unaccepted retained checkout must never acquire money authority through a generic writer.
  const touchesFinancialContract = (fields: object) =>
    Object.keys(fields).some(
      (key) => key === "financialContract" || key.startsWith("financialContract."),
    ) ||
    Object.values(fields).some(
      (target) =>
        typeof target === "string" &&
        (target === "financialContract" || target.startsWith("financialContract.")),
    );
  if (
    update &&
    (touchesFinancialContract(update) ||
      Object.values(update).some(
        (fields) => fields && typeof fields === "object" && touchesFinancialContract(fields),
      ))
  )
    this.where({ packageCheckoutRetention: { $exists: false } });
  if (
    update &&
    (Array.isArray(update) ||
      Object.hasOwn(update, "packageRequestBinding") ||
      Object.values(update).some(
        (fields) =>
          (fields &&
            typeof fields === "object" &&
            Object.keys(fields).some(
              (key) => key === "packageRequestBinding" || key.startsWith("packageRequestBinding."),
            )) ||
          (fields &&
            typeof fields === "object" &&
            Object.values(fields).some(
              (target) =>
                typeof target === "string" &&
                (target === "packageRequestBinding" || target.startsWith("packageRequestBinding.")),
            )),
      ))
  ) {
    throw new Error("Accepted request binding is immutable");
  }
});

bookingCreationClaimSchema.pre("bulkWrite", () => {
  throw new Error("Use canonical single-claim operations");
});
bookingCreationClaimSchema.pre("insertMany", () => {
  throw new Error("Use validated canonical claim creation");
});
bookingCreationClaimSchema.pre(["deleteOne", "deleteMany", "findOneAndDelete"], function () {
  this.and([
    {
      packageCheckoutPresentation: { $exists: false },
      packageCheckoutAcceptance: { $exists: false },
      packageBatchPreparation: { $exists: false },
      packageBatchControl: { $exists: false },
      packageBatchMaterialization: { $exists: false },
    },
  ]);
});
bookingCreationClaimSchema.pre("deleteOne", { document: true, query: false }, function () {
  if (
    this.packageCheckoutPresentation ||
    this.packageCheckoutAcceptance ||
    this.packageBatchPreparation ||
    this.packageBatchControl ||
    this.packageBatchMaterialization
  )
    throw new Error("Checkout evidence is immutable");
});

export const BookingCreationClaimModel = model<BookingCreationClaimDocument>(
  "BookingCreationClaim",
  bookingCreationClaimSchema,
);

export type PackageBatchScope = {
  customer: PackageCheckoutCustomer;
  businessId: Types.ObjectId;
  businessClientId: Types.ObjectId;
  idempotencyKey: string;
};

/** Separate from A1's single-Booking reader. Runtime Customer capability precedes every lookup. */
export async function loadOwnedPackageBatch(scope: PackageBatchScope, session?: ClientSession) {
  const customer = readPackageCheckoutCustomer(scope.customer);
  if (session && !session.inTransaction()) throw batchConflict();
  const row = await BookingCreationClaimModel.findOne({
    idempotencyKey: scope.idempotencyKey,
    businessId: scope.businessId,
    actorUserId: customer.userId,
  })
    .session(session ?? null)
    .read("primary")
    .maxTimeMS(2000);
  if (!row) throw batchConflict();
  canonicalPackageBatch(row.toObject());
  if (row.packageBatchPreparation || row.packageBatchControl || row.packageBatchMaterialization) {
    const p = assertBatchPreparation(row.toObject(), row.packageBatchPreparation);
    const control = packageBatchControlSchema.parse(row.packageBatchControl);
    if (
      !p.businessClientId.equals(scope.businessClientId) ||
      ["INTERNAL_MATERIALIZED", "PREPARATION_COMPLETE"].includes(control.phase) !==
        Boolean(row.packageBatchMaterialization) ||
      (control.phase === "PREPARATION_COMPLETE") !== Boolean(row.packageBatchCompletion)
    )
      throw batchConflict();
    if (row.packageBatchMaterialization)
      assertBatchMaterialization(p, row.packageBatchMaterialization);
  }
  return row;
}

/** Fixed-shape, activation-denied, set-once preparation. No update document or bypass option
 * supplied by callers. The opaque Customer capability does not grant activation. */
export async function prepareInternalPackageBatch(scope: PackageBatchScope, at: Date) {
  await verifyPackageBatchActivation();
  const row = await loadOwnedPackageBatch(scope);
  if (row.packageBatchPreparation)
    return assertBatchPreparation(row.toObject(), row.packageBatchPreparation);
  const client = await BusinessClientModel.exists({
    _id: scope.businessClientId,
    businessId: scope.businessId,
    linkedUserId: row.actorUserId,
  });
  if (!client) throw batchConflict();
  const { quote: q, retention, accepted } = canonicalPackageBatch(row.toObject());
  const preparation = assertBatchPreparation(row.toObject(), {
    version: 1,
    protocol: "PACKAGE_INTERNAL_MATERIALIZATION",
    claimId: row._id,
    idempotencyKey: row.idempotencyKey,
    businessId: row.businessId,
    customerUserId: row.actorUserId,
    businessClientId: scope.businessClientId,
    quoteId: q.quoteId,
    batchId: q.batchId,
    packageProgressId: q.packageProgressId,
    originBookingId: q.originBookingId,
    termsHash: retention.quote.termsHash,
    disclosureHash: accepted.disclosureHash,
    acceptanceId: accepted.evidence.acceptanceId,
    materializedAt: new Date(at.getTime()),
    activationId: new Types.ObjectId(),
    activationEventId: new Types.ObjectId(),
    members: [...q.appointments]
      .sort(
        (a, b) =>
          a.startAt.getTime() - b.startAt.getTime() ||
          a.bookingId.toHexString().localeCompare(b.bookingId.toHexString()),
      )
      .map((m) => ({
        bookingId: m.bookingId,
        selectionId: m.selectionId,
        packageItemId: m.packageItemId,
        definitionItemId: m.definitionItemId,
        serviceId: m.serviceId,
        staffMembershipId: m.staffMembershipId,
        startAt: m.startAt,
        endAt: m.endAt,
        ...(m.group ? { group: m.group } : {}),
        reference: generateBookingReference(),
      })),
  });
  const query = BookingCreationClaimModel.updateOne(
    {
      _id: row._id,
      idempotencyKey: row.idempotencyKey,
      businessId: row.businessId,
      actorUserId: row.actorUserId,
      bookingId: row.bookingId,
      "packageCheckoutRetention.quote.termsHash": preparation.termsHash,
      "packageCheckoutAcceptance.evidence.acceptanceId": preparation.acceptanceId,
      packageBatchPreparation: { $exists: false },
      packageBatchControl: { $exists: false },
      packageBatchMaterialization: { $exists: false },
    },
    {
      $set: {
        packageBatchPreparation: preparation,
        packageBatchControl: { version: 1, phase: "PREPARED" },
      },
    },
  );
  batchTransitions.add(query);
  await query;
  const winner = await loadOwnedPackageBatch(scope);
  return assertBatchPreparation(winner.toObject(), winner.packageBatchPreparation);
}

export async function claimInternalPackageBatch(
  scope: PackageBatchScope,
  preparation: PackageBatchPreparation,
) {
  await verifyPackageBatchActivation();
  const row = await loadOwnedPackageBatch(scope);
  const p = assertBatchPreparation(row.toObject(), row.packageBatchPreparation);
  if (!isDeepStrictEqual(p, preparation)) throw batchConflict();
  const token = randomUUID();
  const query = BookingCreationClaimModel.updateOne(
    {
      _id: row._id,
      packageBatchPreparation: p,
      "packageBatchControl.phase": "PREPARED",
      packageBatchMaterialization: { $exists: false },
    },
    { $set: { packageBatchControl: { version: 1, phase: "PERSISTING", token } } },
  );
  batchTransitions.add(query);
  return (await query).modifiedCount === 1 ? token : null;
}

/** Only the transaction owner calls this after a definite callback abort; never from absence,
 * lease expiry or an unknown commit. Exact token CAS cannot reopen another attempt. */
export async function releaseKnownAbortedPackageBatch(scope: PackageBatchScope, token: string) {
  await verifyPackageBatchActivation();
  const row = await loadOwnedPackageBatch(scope);
  const { quote } = canonicalPackageBatch(row.toObject());
  if (quote.financials.requiredUpfrontCents !== 0) throw batchConflict();
  const { PaymentAttemptModel } = await import("../payment/payment-attempt.model.js");
  if (
    await PaymentAttemptModel.exists({ logicalIdempotencyKey: row.idempotencyKey })
      .read("primary")
      .maxTimeMS(2000)
  )
    throw batchConflict();
  const query = BookingCreationClaimModel.updateOne(
    {
      _id: row._id,
      packageBatchPreparation: assertBatchPreparation(row.toObject(), row.packageBatchPreparation),
      "packageBatchControl.phase": "PERSISTING",
      "packageBatchControl.token": token,
      packageBatchMaterialization: { $exists: false },
    },
    { $set: { packageBatchControl: { version: 1, phase: "PREPARED" } } },
  );
  batchTransitions.add(query);
  return (await query).modifiedCount === 1;
}

export async function commitInternalPackageBatch(
  scope: PackageBatchScope,
  token: string,
  proofInput: unknown,
  session: ClientSession,
) {
  await verifyPackageBatchActivation();
  if (!session.inTransaction()) throw batchConflict();
  const row = await loadOwnedPackageBatch(scope, session);
  const p = assertBatchPreparation(row.toObject(), row.packageBatchPreparation);
  if (row.packageBatchControl?.phase !== "PERSISTING" || row.packageBatchControl.token !== token)
    throw batchConflict();
  const proof = assertBatchMaterialization(p, proofInput);
  await verifyPackageBatchMembers(row.toObject(), proof, session, true);
  const query = BookingCreationClaimModel.updateOne(
    {
      _id: row._id,
      packageBatchPreparation: p,
      "packageBatchControl.phase": "PERSISTING",
      "packageBatchControl.token": token,
      packageBatchMaterialization: { $exists: false },
    },
    {
      $set: {
        packageBatchMaterialization: proof,
        packageBatchControl: { version: 1, phase: "INTERNAL_MATERIALIZED", token },
      },
    },
    { session },
  );
  batchTransitions.add(query);
  if ((await query).modifiedCount !== 1) throw batchConflict();
  let grant = freshBatchMaterializations.get(session);
  if (!grant || grant.transactionNumber !== session.serverSession.txnNumber) {
    grant = { transactionNumber: session.serverSession.txnNumber, claims: new Map() };
    freshBatchMaterializations.set(session, grant);
  }
  grant.claims.set(String(row._id), {
    token,
    proofHash: hashCanonicalPackageCheckoutContent(proof),
  });
}

export async function readOwnedPackageBatchMaterialization(scope: PackageBatchScope) {
  const row = await loadOwnedPackageBatch(scope);
  if (!row.packageBatchMaterialization) return null;
  const control = packageBatchControlSchema.parse(row.packageBatchControl);
  if (!["INTERNAL_MATERIALIZED", "PREPARATION_COMPLETE"].includes(control.phase))
    throw batchConflict();
  return verifyPackageBatchMembers(row.toObject(), row.packageBatchMaterialization);
}

/** The only query capability for appending presentation/acceptance. No caller-supplied
 * mutation/options can bypass the hook. The grant is issued by verified Customer authority.
 * The original retention remains intact, so all existing financial exclusions still apply.
 */
export const commitPackageCheckoutClaimGrant = async (
  grant: PackageCheckoutClaimGrant,
): Promise<boolean> => {
  const authorized = readPackageCheckoutClaimGrant(grant);
  const { retention, presentation } = authorized;
  assertPackagePresentation(retention, presentation);
  if (authorized.kind === "ACCEPT")
    assertPackageAccepted(retention, presentation, authorized.accepted);
  const q = retention.quote.payload;
  const filter = {
    idempotencyKey: q.idempotencyKey,
    businessId: q.businessId,
    actorUserId: q.actorUserId,
    bookingId: q.originBookingId,
    "packageCheckoutRetention.quote.termsHash": retention.quote.termsHash,
    financialContract: { $exists: false },
    packageRequestBinding: { $exists: false },
    packageCheckoutAcceptance: { $exists: false },
    ...(authorized.kind === "PRESENT"
      ? { packageCheckoutPresentation: { $exists: false } }
      : {
          "packageCheckoutPresentation.presentationId": presentation.presentationId,
          "packageCheckoutPresentation.challenge": presentation.challenge,
          "packageCheckoutPresentation.sessionFamilyId": presentation.sessionFamilyId,
          "packageCheckoutPresentation.disclosure.contentHash": presentation.disclosure.contentHash,
        }),
  };
  const query = BookingCreationClaimModel.updateOne(
    filter,
    {
      $set:
        authorized.kind === "PRESENT"
          ? { packageCheckoutPresentation: presentation }
          : { packageCheckoutAcceptance: authorized.accepted },
    },
    { runValidators: true },
  );
  checkoutTransitions.add(query);
  return (await query).matchedCount === 1;
};

/** Set-once financial contract generated from canonical quote and authoritative relationship.
 * No generic contract attach can adopt a retained checkout. */
export async function retainBatchFinance(scope: PackageBatchScope, input: BatchFinance) {
  await verifyPackageBatchActivation();
  const row = await loadOwnedPackageBatch(scope);
  const { assertCanonicalBatchFinance } = await import("./package-batch-completion.js");
  const finance = assertCanonicalBatchFinance(row.toObject(), input);
  if (row.packageBatchFinance) {
    if (!isDeepStrictEqual(row.packageBatchFinance, finance)) throw batchConflict();
    return finance;
  }
  if (row.packageBatchMaterialization) throw batchConflict();
  const query = BookingCreationClaimModel.updateOne(
    {
      _id: row._id,
      packageBatchPreparation: assertBatchPreparation(row.toObject(), row.packageBatchPreparation),
      packageBatchFinance: { $exists: false },
      packageBatchMaterialization: { $exists: false },
    },
    { $set: { packageBatchFinance: finance } },
  );
  batchTransitions.add(query);
  if ((await query).modifiedCount !== 1) {
    const winner = await loadOwnedPackageBatch(scope);
    if (!isDeepStrictEqual(winner.packageBatchFinance, finance)) throw batchConflict();
  }
  return finance;
}

export async function appendBatchCompletion(
  scope: PackageBatchScope,
  token: string,
  input: BatchCompletion,
  tasks: BatchDeliveryTask[],
  session: ClientSession,
) {
  await verifyPackageBatchActivation();
  if (!session.inTransaction()) throw batchConflict();
  const row = await loadOwnedPackageBatch(scope, session);
  if (
    row.packageBatchControl?.phase !== "INTERNAL_MATERIALIZED" ||
    row.packageBatchControl.token !== token ||
    !row.packageBatchFinance ||
    row.packageBatchCompletion
  )
    throw batchConflict();
  assertFreshPackageBatchMaterialization(session, row._id);
  const fresh = freshBatchMaterializations.get(session)?.claims.get(String(row._id));
  if (
    fresh?.token !== token ||
    fresh.proofHash !== hashCanonicalPackageCheckoutContent(row.packageBatchMaterialization)
  )
    throw batchConflict();
  const completion = batchCompletionSchema.parse(input);
  const delivery = tasks.map((t) => batchDeliveryTaskSchema.parse(t));
  const { verifyBatchCompletion } = await import("./package-batch-completion.js");
  await verifyBatchCompletion(
    {
      ...row.toObject(),
      packageBatchCompletion: completion,
      packageBatchDelivery: delivery,
      packageBatchControl: { version: 1, phase: "PREPARATION_COMPLETE", token },
    },
    session,
    true,
  );
  const query = BookingCreationClaimModel.updateOne(
    {
      _id: row._id,
      packageBatchFinance: row.packageBatchFinance,
      "packageBatchControl.token": token,
      "packageBatchControl.phase": "INTERNAL_MATERIALIZED",
      packageBatchCompletion: { $exists: false },
    },
    {
      $set: {
        packageBatchCompletion: completion,
        packageBatchDelivery: delivery,
        packageBatchControl: { version: 1, phase: "PREPARATION_COMPLETE", token },
      },
    },
    { session },
  );
  batchTransitions.add(query);
  if ((await query).modifiedCount !== 1) throw batchConflict();
  freshBatchMaterializations.get(session)?.claims.delete(String(row._id));
}

/** Exact-array CAS preserves independent sibling tasks. Calendar processing reconciles a
 * deterministic existing provider event only; elapsed task time never reopens a purchase. */
export async function claimBatchDeliveryTask(scope: PackageBatchScope, key: string, now: Date) {
  await verifyPackageBatchActivation();
  const row = await loadOwnedPackageBatch(scope);
  if (!row.packageBatchCompletion || !row.packageBatchDelivery) throw batchConflict();
  const old = row.packageBatchDelivery;
  const task = old.find((t) => t.key === key && t.port === "CALENDAR");
  if (
    !task ||
    !["PENDING", "RETRY", "BLOCKED_UNVERIFIED", "PROCESSING"].includes(task.state) ||
    task.nextDue > now
  )
    return null;
  const claimed = batchDeliveryTaskSchema.parse({
    ...task,
    state: "PROCESSING",
    token: randomUUID(),
    attempts: task.attempts + 1,
    nextDue: new Date(now.getTime() + 120000),
  });
  const query = BookingCreationClaimModel.updateOne(
    { _id: row._id, packageBatchCompletion: row.packageBatchCompletion, packageBatchDelivery: old },
    { $set: { packageBatchDelivery: old.map((t) => (t.key === key ? claimed : t)) } },
  );
  batchTransitions.add(query);
  return (await query).modifiedCount === 1 ? claimed : null;
}

export async function settleBatchDeliveryTask(
  scope: PackageBatchScope,
  key: string,
  token: string,
  state: "DONE" | "SKIPPED" | "RETRY" | "BLOCKED_UNVERIFIED",
  now: Date,
) {
  await verifyPackageBatchActivation();
  const row = await loadOwnedPackageBatch(scope);
  if (!row.packageBatchCompletion || !row.packageBatchDelivery) throw batchConflict();
  const old = row.packageBatchDelivery;
  const task = old.find((t) => t.key === key && t.state === "PROCESSING" && t.token === token);
  if (!task) return false;
  const next = batchDeliveryTaskSchema.parse({
    ...task,
    state,
    nextDue: new Date(now.getTime() + 120000),
  });
  const query = BookingCreationClaimModel.updateOne(
    { _id: row._id, packageBatchDelivery: old },
    { $set: { packageBatchDelivery: old.map((t) => (t.key === key ? next : t)) } },
  );
  batchTransitions.add(query);
  return (await query).modifiedCount === 1;
}

/** Terminal failure only from exact full, durably confirmed compensation. Never from missing
 * members, elapsed time, failed reads or an unknown transaction. Canonical IDs are retained. */
export async function markBatchCompensatedFailure(
  scope: PackageBatchScope,
  attemptId: Types.ObjectId | string,
) {
  await verifyPackageBatchActivation();
  const row = await loadOwnedPackageBatch(scope);
  if (row.packageBatchMaterialization || row.packageBatchCompletion) throw batchConflict();
  const { PaymentAttemptModel } = await import("../payment/payment-attempt.model.js");
  const { readExactBatchCompensation } = await import("./package-batch-payment-recovery.js");
  const attempt = await PaymentAttemptModel.findById(attemptId)
    .read("primary")
    .maxTimeMS(2000)
    .orFail();
  const proof = await readExactBatchCompensation(attempt);
  if (!proof?.authority.claim._id.equals(row._id)) throw batchConflict();
  const control = packageBatchControlSchema.parse(row.packageBatchControl);
  if (control.phase === "FAILED_FINAL")
    return (
      control.paymentAttemptId.equals(attempt._id) &&
      control.refundOperationId.equals(proof.refund._id)
    );
  if (control.phase !== "PERSISTING") throw batchConflict();
  const query = BookingCreationClaimModel.updateOne(
    {
      _id: row._id,
      packageBatchControl: control,
      packageBatchMaterialization: { $exists: false },
      packageBatchCompletion: { $exists: false },
    },
    {
      $set: {
        packageBatchControl: {
          version: 1,
          phase: "FAILED_FINAL",
          token: control.token,
          reason: "DEFINITIVE_COMPENSATED_ABORT",
          paymentAttemptId: attempt._id,
          refundOperationId: proof.refund._id,
        },
      },
    },
  );
  batchTransitions.add(query);
  return (await query).modifiedCount === 1;
}
