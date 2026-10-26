import { createHash, randomBytes, randomUUID } from "node:crypto";
import mongoose, { type ClientSession, model, Schema, Types } from "mongoose";
import { z } from "zod";
import {
  formatDateInTimezone,
  formatMoney,
  formatTimeInTimezone,
} from "../email/templates/components/email-format.js";
import { acquirePackageEligibilityFence } from "../package-progress/package-eligibility.js";
import { verifyPackageBatchActivation } from "./package-batch-authority.js";
import { batchConflict } from "./package-batch-contract.js";
import { hashCanonicalPackageCheckoutContent as digest } from "./package-checkout-binding.js";
import { packageCheckoutIntentSchema } from "./package-checkout-contract.js";
import {
  type PackageCheckoutCustomer,
  readPackageCheckoutCustomer,
} from "./package-checkout-customer-authority.js";
import {
  deriveLifecycleSessionTerms,
  lifecycleSessionAcceptanceSchema,
  lifecycleSessionQuoteSchema,
} from "./package-lifecycle-session-terms.js";

const id = z.instanceof(Types.ObjectId);
export const lifecycleIntentSchema = z
  .object({
    version: z.literal(1),
    key: z.string().min(1).max(200),
    action: z.enum([
      "REDEEM",
      "RESCHEDULE",
      "CANCEL",
      "COMPLETE",
      "MARK_NO_SHOW",
      "NO_SHOW",
      "REVERSE_NO_SHOW",
      "EXPIRE",
      "VENUE_SETTLEMENT",
    ]),
    actorUserId: id,
    actorRole: z.enum(["CUSTOMER", "BUSINESS_OWNER", "SUPERVISOR"]),
    customerUserId: id,
    businessId: id,
    businessClientId: id,
    packageProgressId: id,
    packageItemId: id.optional(),
    bookingId: id.optional(),
    staffMembershipId: id.optional(),
    startAt: z.date().optional(),
    dues: z
      .object({
        addonIds: z.array(id).max(50),
        paymentMethod: z.enum(["VENUE", "ONLINE"]),
        travelAddress: packageCheckoutIntentSchema.shape.selections.element.shape.travelAddress,
      })
      .strict()
      .optional(),
    venuePayment: z
      .object({
        settlement: z.enum(["FULL", "PARTIAL", "NOT_PAID"]),
        amountCents: z.number().int().safe().positive().optional(),
        note: z.string().trim().min(1).max(1000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type LifecycleIntent = z.infer<typeof lifecycleIntentSchema>;
export const lifecycleAssessmentSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["CANCELLATION_FEE", "NO_SHOW_FEE", "SESSION_DUES"]),
    basisCents: z.number().int().safe().nonnegative(),
    requestedCents: z.number().int().safe().nonnegative(),
    amountCents: z.number().int().safe().nonnegative(),
    lifetimeCapCents: z.number().int().safe().nonnegative(),
    assessedAt: z.date(),
    bookingStartAt: z.date(),
    bookingEndAt: z.date(),
    timezone: z.string().min(1),
    serviceId: id,
    staffMembershipId: id,
    bookingStatus: z.enum(["UPCOMING", "PENDING"]),
    eventVersion: z.number().int().nonnegative(),
    state: z.enum(["RESERVED", "CAPTURED", "RELEASED"]),
  })
  .strict();
export type LifecycleAssessment = z.infer<typeof lifecycleAssessmentSchema>;
const resultSchema = z
  .object({
    version: z.literal(1),
    bookingId: id.optional(),
    reservationKey: z.string().optional(),
    reservationId: id.optional(),
    staffMembershipId: id.optional(),
    endAt: z.date().optional(),
    startAt: z.date().optional(),
    effectState: z.enum(["APPLIED", "RELEASED"]).optional(),
    status: z.string(),
    committedAt: z.date(),
    money: z
      .object({
        attemptId: id,
        ledgerId: id,
        amountCents: z.number().int().safe().positive(),
        paymentIntentId: z.string().min(1),
      })
      .strict()
      .optional(),
    venue: z
      .object({
        amountCents: z.number().int().safe().nonnegative(),
        cumulativeCents: z.number().int().safe().nonnegative(),
        ledgerId: id.optional(),
      })
      .strict()
      .optional(),
    emails: z.array(id),
    reminders: z.array(id),
    tasks: z.array(
      z
        .object({
          port: z.enum(["CALENDAR", "OWNER_EMAIL", "CUSTOMER_EMAIL"]),
          state: z.enum(["BLOCKED_UNVERIFIED", "PLANNED"]),
          bookingId: id,
          lifecycleVersion: z.number().int().nonnegative(),
          eventVersion: z.number().int().positive().optional(),
          bookingStatus: z.string().optional(),
          existingEventId: z.string().min(1).optional(),
          outboxId: id.optional(),
          startAt: z.date(),
          endAt: z.date(),
        })
        .strict(),
    ),
  })
  .strict();
export type LifecycleResult = z.infer<typeof resultSchema>;
const operationSchema = new Schema(
  {
    _id: { type: Schema.Types.ObjectId, required: true },
    intent: { type: Schema.Types.Mixed, required: true },
    bookingId: { type: Schema.Types.ObjectId },
    phase: {
      type: String,
      enum: ["PREPARED", "PERSISTING", "COMPLETE", "FAILED_FINAL"],
      required: true,
    },
    token: String,
    result: Schema.Types.Mixed,
    assessment: Schema.Types.Mixed,
    sessionQuote: Schema.Types.Mixed,
    sessionAcceptance: Schema.Types.Mixed,
    delivery: { type: [Schema.Types.Mixed], default: undefined },
  },
  { strict: "throw", versionKey: false },
);
const grants = new WeakSet<object>();
operationSchema.pre("deleteOne", { document: true, query: false }, () => {
  throw batchConflict();
});
operationSchema.pre("save", () => {
  throw batchConflict();
});
for (const hook of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
] as const)
  operationSchema.pre(hook, function () {
    if (!grants.delete(this)) throw batchConflict();
  });
operationSchema.pre("insertMany", () => {
  throw batchConflict();
});
operationSchema.pre("bulkWrite", () => {
  throw batchConflict();
});
/** This record owns operation identity/results only. V2 remains the only credit authority.
 * No scan/TTL/index declaration; hashed built-in _id elects one globally scoped key winner. */
export const PackageLifecycleOperationModel = model("PackageLifecycleOperation", operationSchema);
export class PackageLifecycleOperations {
  public async prepare(input: LifecycleIntent) {
    await verifyPackageBatchActivation();
    const intent = lifecycleIntentSchema.parse(input);
    const _id = new Types.ObjectId(
      createHash("sha256").update(`bookly:lifecycle:v1:${intent.key}`).digest("hex").slice(0, 24),
    );
    const query = PackageLifecycleOperationModel.findOneAndUpdate(
      { _id },
      {
        $setOnInsert: {
          intent,
          phase: "PREPARED",
          ...(intent.action === "REDEEM"
            ? { bookingId: new Types.ObjectId() }
            : intent.bookingId
              ? { bookingId: intent.bookingId }
              : {}),
        },
      },
      { upsert: true, returnDocument: "after" },
    );
    grants.add(query);
    // An actual duplicate-key race propagates. Never read an invalidated transaction.
    const row = await query;
    if (!row || digest(row.intent) !== digest(intent)) throw batchConflict();
    return row;
  }
  public async presentSession(
    customer: PackageCheckoutCustomer,
    input: LifecycleIntent,
    now: Date,
  ) {
    await verifyPackageBatchActivation();
    const actor = readPackageCheckoutCustomer(customer),
      intent = lifecycleIntentSchema.parse(input);
    if (
      intent.action !== "REDEEM" ||
      intent.actorRole !== "CUSTOMER" ||
      !actor.userId.equals(intent.actorUserId) ||
      !actor.userId.equals(intent.customerUserId) ||
      !intent.dues ||
      !Number.isFinite(now.getTime())
    )
      throw batchConflict();
    const row = await this.prepare(intent);
    if (row.sessionQuote) return lifecycleSessionQuoteSchema.parse(row.sessionQuote);
    const quoteId = new Types.ObjectId(),
      challenge = randomBytes(32).toString("hex");
    const session = await mongoose.startSession();
    let winner: z.infer<typeof lifecycleSessionQuoteSchema> | undefined;
    try {
      await session.withTransaction(async () => {
        await acquirePackageEligibilityFence(intent.businessId, session);
        const current = await PackageLifecycleOperationModel.findOne({
          _id: row._id,
          phase: "PREPARED",
        })
          .session(session)
          .orFail();
        if (digest(current.intent) !== digest(intent) || !current.bookingId) throw batchConflict();
        if (current.sessionQuote) {
          winner = lifecycleSessionQuoteSchema.parse(current.sessionQuote);
          return;
        }
        const terms = await deriveLifecycleSessionTerms(intent, current.bookingId, session, now);
        const address =
          terms.fulfilment.mode === "TRAVEL_TO_CUSTOMER"
            ? terms.fulfilment.travelAddress
            : terms.fulfilment.businessLocation;
        const location = [
          address.streetNumber,
          address.streetName,
          address.area,
          address.city,
          address.floorUnit,
          address.aptRoom,
          "additionalDirections" in address ? address.additionalDirections : undefined,
        ]
          .filter(Boolean)
          .join(", ");
        const selectedAddons = terms.addons.length
          ? terms.addons.map((a) => `${a.name}: ${formatMoney(a.priceCents, "EUR")}`).join("; ")
          : "None";
        const disclosure = [
          `${terms.serviceName}: included Package base ${formatMoney(0, "EUR")}.`,
          `Appointment: ${formatDateInTimezone(terms.startAt, terms.timezone)} at ${formatTimeInTimezone(terms.startAt, terms.timezone)} (${terms.timezone}).`,
          `Add-ons: ${selectedAddons}. Travel: ${formatMoney(terms.travelCents, "EUR")}. Total session dues: ${formatMoney(terms.totalCents, "EUR")}.`,
          terms.paymentMethod === "VENUE"
            ? "Payment at the venue; this acceptance does not certify payment received."
            : "Online payment; acceptance alone does not certify a successful charge.",
          terms.group
            ? `One credit allocates one person and one seat. Original Group capacity: ${terms.group.capacityMax}.`
            : "One credit allocates this included appointment.",
          `Location: ${location}.`,
        ].join("\n");
        winner = lifecycleSessionQuoteSchema.parse({
          version: 1,
          quoteId,
          sessionFamilyId: actor.sessionFamilyId,
          issuedAt: now,
          challenge,
          terms,
          termsHash: digest(terms),
          disclosure,
          disclosureHash: digest(disclosure),
        });
        const query = PackageLifecycleOperationModel.updateOne(
          { _id: row._id, phase: "PREPARED", sessionQuote: { $exists: false } },
          { $set: { sessionQuote: winner } },
          { session },
        );
        grants.add(query);
        if ((await query).modifiedCount !== 1) throw batchConflict();
      });
    } finally {
      await session.endSession();
    }
    if (!winner) throw batchConflict();
    return winner;
  }
  public async acceptSession(
    customer: PackageCheckoutCustomer,
    input: LifecycleIntent,
    action: {
      quoteId: Types.ObjectId;
      termsHash: string;
      disclosureHash: string;
      challenge: string;
      action: "ACCEPT_SESSION_DUES";
    },
    now: Date,
  ) {
    await verifyPackageBatchActivation();
    const actor = readPackageCheckoutCustomer(customer),
      intent = lifecycleIntentSchema.parse(input);
    if (
      intent.actorRole !== "CUSTOMER" ||
      !actor.userId.equals(intent.actorUserId) ||
      !actor.userId.equals(intent.customerUserId) ||
      !Number.isFinite(now.getTime())
    )
      throw batchConflict();
    const row = await this.prepare(intent);
    if (row.sessionAcceptance) {
      const q = lifecycleSessionQuoteSchema.parse(row.sessionQuote),
        accepted = lifecycleSessionAcceptanceSchema.parse(row.sessionAcceptance);
      if (
        q.sessionFamilyId !== actor.sessionFamilyId ||
        !q.quoteId.equals(action.quoteId) ||
        q.termsHash !== action.termsHash ||
        q.disclosureHash !== action.disclosureHash ||
        q.challenge !== action.challenge ||
        action.action !== "ACCEPT_SESSION_DUES" ||
        !accepted.customerUserId.equals(actor.userId) ||
        !accepted.quoteId.equals(q.quoteId) ||
        accepted.termsHash !== q.termsHash ||
        accepted.disclosureHash !== q.disclosureHash ||
        accepted.sessionFamilyId !== q.sessionFamilyId
      )
        throw batchConflict();
      return accepted;
    }
    const session = await mongoose.startSession();
    let winner: z.infer<typeof lifecycleSessionAcceptanceSchema> | undefined;
    try {
      await session.withTransaction(async () => {
        await acquirePackageEligibilityFence(intent.businessId, session);
        const current = await PackageLifecycleOperationModel.findOne({
          _id: row._id,
          phase: "PREPARED",
        })
          .session(session)
          .orFail();
        const quote = lifecycleSessionQuoteSchema.parse(current.sessionQuote);
        if (
          !current.bookingId ||
          digest(current.intent) !== digest(intent) ||
          quote.sessionFamilyId !== actor.sessionFamilyId ||
          !quote.quoteId.equals(action.quoteId) ||
          quote.termsHash !== action.termsHash ||
          quote.disclosureHash !== action.disclosureHash ||
          quote.challenge !== action.challenge ||
          action.action !== "ACCEPT_SESSION_DUES" ||
          quote.termsHash !== digest(quote.terms) ||
          quote.disclosureHash !== digest(quote.disclosure) ||
          now < quote.issuedAt
        )
          throw batchConflict();
        if (current.sessionAcceptance) {
          winner = lifecycleSessionAcceptanceSchema.parse(current.sessionAcceptance);
          return;
        }
        if (
          digest(await deriveLifecycleSessionTerms(intent, current.bookingId, session, now)) !==
          quote.termsHash
        )
          throw batchConflict();
        winner = lifecycleSessionAcceptanceSchema.parse({
          version: 1,
          acceptanceId: new Types.ObjectId(),
          quoteId: quote.quoteId,
          termsHash: quote.termsHash,
          disclosureHash: quote.disclosureHash,
          customerUserId: actor.userId,
          sessionFamilyId: actor.sessionFamilyId,
          acceptedAt: now,
          action: "ACCEPT_SESSION_DUES",
        });
        const query = PackageLifecycleOperationModel.updateOne(
          {
            _id: row._id,
            phase: "PREPARED",
            sessionAcceptance: { $exists: false },
            sessionQuote: current.sessionQuote,
          },
          {
            $set: {
              sessionAcceptance: winner,
              ...(quote.terms.paymentMethod === "ONLINE"
                ? {
                    assessment: {
                      version: 1,
                      kind: "SESSION_DUES",
                      basisCents: 0,
                      requestedCents: quote.terms.totalCents,
                      amountCents: quote.terms.totalCents,
                      lifetimeCapCents: 0,
                      assessedAt: now,
                      bookingStartAt: quote.terms.startAt,
                      bookingEndAt: quote.terms.endAt,
                      timezone: quote.terms.timezone,
                      serviceId: quote.terms.serviceId,
                      staffMembershipId: quote.terms.staffMembershipId,
                      bookingStatus: "UPCOMING",
                      eventVersion: 0,
                      state: "RESERVED",
                    },
                  }
                : {}),
            },
          },
          { session },
        );
        grants.add(query);
        if ((await query).modifiedCount !== 1) throw batchConflict();
      });
    } finally {
      await session.endSession();
    }
    if (!winner) throw batchConflict();
    return winner;
  }
  public async reservePenalty(id: Types.ObjectId, intent: LifecycleIntent, now: Date) {
    await verifyPackageBatchActivation();
    const { deriveLifecyclePenalty } = await import("./package-lifecycle-penalty.js");
    const session = await mongoose.startSession();
    let winner: LifecycleAssessment | undefined;
    try {
      await session.withTransaction(async () => {
        const decision = await deriveLifecyclePenalty(id, intent, now, session);
        winner = decision.assessment;
        if (decision.existing) return;
        const query = PackageLifecycleOperationModel.updateOne(
          { _id: id, phase: "PREPARED", assessment: { $exists: false } },
          { $set: { assessment: decision.assessment } },
          { session },
        );
        grants.add(query);
        if ((await query).modifiedCount !== 1) throw batchConflict();
      });
    } finally {
      await session.endSession();
    }
    if (!winner) throw batchConflict();
    return winner;
  }
  public async claim(id: Types.ObjectId) {
    await verifyPackageBatchActivation();
    const token = randomUUID();
    const query = PackageLifecycleOperationModel.findOneAndUpdate(
      { _id: id, phase: "PREPARED" },
      { $set: { phase: "PERSISTING", token } },
      { returnDocument: "after" },
    );
    grants.add(query);
    return query;
  }
  public async reset(id: Types.ObjectId, token: string) {
    await verifyPackageBatchActivation();
    const current = await PackageLifecycleOperationModel.findById(id)
      .read("primary")
      .maxTimeMS(2000);
    if (current?.assessment && lifecycleAssessmentSchema.parse(current.assessment).amountCents > 0)
      throw batchConflict();
    const query = PackageLifecycleOperationModel.updateOne(
      { _id: id, phase: "PERSISTING", token },
      { $set: { phase: "PREPARED" }, $unset: { token: "" } },
    );
    grants.add(query);
    await query;
  }
  public async complete(
    id: Types.ObjectId,
    token: string,
    result: LifecycleResult,
    session: ClientSession,
  ) {
    await verifyPackageBatchActivation();
    if (!session.inTransaction()) throw batchConflict();
    const valid = resultSchema.parse(result);
    const row = await PackageLifecycleOperationModel.findById(id).session(session).orFail();
    if (valid.reservationKey) {
      const intent = lifecycleIntentSchema.parse(row.intent);
      if (
        !valid.bookingId ||
        !valid.reservationId ||
        !valid.staffMembershipId ||
        !valid.startAt ||
        !valid.endAt ||
        !valid.effectState ||
        (intent.action === "CANCEL"
          ? valid.effectState !== "RELEASED"
          : valid.effectState !== "APPLIED")
      )
        throw batchConflict();
      const { BookingModel } = await import("./booking.model.js");
      const { BookingSlotReservationClaimModel } = await import(
        "../booking-slot-reservation/booking-slot-reservation-claim.model.js"
      );
      const booking = await BookingModel.findOne({
        _id: valid.bookingId,
        businessId: intent.businessId,
        "customer.customerUserId": intent.customerUserId,
        "customer.businessClientId": intent.businessClientId,
      })
        .session(session)
        .orFail();
      const line = booking.serviceLines[0];
      if (!line) throw batchConflict();
      const effect = await BookingSlotReservationClaimModel.findOne({
        idempotencyKey: valid.reservationKey,
        businessId: intent.businessId,
        serviceId: line.serviceId,
        staffMembershipId: valid.staffMembershipId,
        partySize: 1,
      }).session(session);
      if (
        !effect?.effect ||
        effect.effect.state !== valid.effectState ||
        !effect.effect.actualReservationId.equals(valid.reservationId) ||
        effect.originalIntent?.startAt.getTime() !== valid.startAt.getTime() ||
        effect.originalIntent?.endAt.getTime() !== valid.endAt.getTime() ||
        effect.originalIntent?.timezone !== booking.schedule.timezone ||
        effect.originalIntent?.capacityMax !== (line.schedulingSnapshot?.group?.capacityMax ?? 1)
      )
        throw batchConflict();
    }

    if (row.assessment) {
      const a = lifecycleAssessmentSchema.parse(row.assessment);
      if (
        a.amountCents > 0 !== !!valid.money ||
        (valid.money && valid.money.amountCents !== a.amountCents)
      )
        throw batchConflict();
    } else if (valid.money) throw batchConflict();
    const query = PackageLifecycleOperationModel.updateOne(
      { _id: id, phase: "PERSISTING", token },
      {
        $set: {
          phase: "COMPLETE",
          result: valid,
          ...(row.assessment
            ? {
                assessment: {
                  ...lifecycleAssessmentSchema.parse(row.assessment),
                  state: "CAPTURED",
                },
              }
            : {}),
          delivery: valid.tasks.map((task, index) => ({
            index,
            state: task.outboxId
              ? "DONE"
              : task.port === "CALENDAR" && task.eventVersion
                ? "PENDING"
                : "BLOCKED_UNVERIFIED",
            attempts: 0,
            completionStage: task.outboxId ? "OUTBOX_PLANNED" : "NOT_VERIFIED",
            externalDelivery: "NOT_ATTESTED",
          })),
        },
      },
      { session },
    );
    grants.add(query);
    if ((await query).modifiedCount !== 1) throw batchConflict();
  }
  public async releaseUncollected(attemptId: Types.ObjectId) {
    await verifyPackageBatchActivation();
    const { PaymentAttemptModel, isProviderCreationClosed } = await import(
      "../payment/payment-attempt.model.js"
    );
    const { inspectLifecyclePaymentAuthority } = await import(
      "./package-lifecycle-payment-recovery.js"
    );
    const first = await PaymentAttemptModel.findById(attemptId)
      .read("primary")
      .maxTimeMS(2000)
      .orFail();
    const binding = first.packageLifecycleBinding;
    if (!binding) throw batchConflict();
    const session = await mongoose.startSession();
    let released = false;
    try {
      await session.withTransaction(async () => {
        await acquirePackageEligibilityFence(new Types.ObjectId(binding.businessId), session);
        const attempt = await PaymentAttemptModel.findById(attemptId).session(session).orFail();
        const authority = await inspectLifecyclePaymentAuthority(attempt, session);
        if (
          !authority ||
          authority.kind === "COMPLETE" ||
          authority.row.phase !== "PREPARED" ||
          attempt.persistenceStatus !== "NOT_STARTED" ||
          attempt.compensationStatus !== "NOT_REQUIRED" ||
          !(attempt.providerStatus === "CANCELED" || isProviderCreationClosed(attempt))
        )
          throw batchConflict();
        const fence = await PaymentAttemptModel.updateOne(
          {
            _id: attempt._id,
            providerStatus: attempt.providerStatus,
            persistenceStatus: "NOT_STARTED",
            compensationStatus: "NOT_REQUIRED",
          },
          { $inc: { __v: 1 } },
          { session, timestamps: false },
        );
        if (fence.modifiedCount !== 1) throw batchConflict();
        const query = PackageLifecycleOperationModel.updateOne(
          { _id: authority.row._id, phase: "PREPARED", assessment: authority.row.assessment },
          { $set: { phase: "FAILED_FINAL", "assessment.state": "RELEASED" } },
          { session },
        );
        grants.add(query);
        if ((await query).modifiedCount !== 1) throw batchConflict();
        released = true;
      });
    } finally {
      await session.endSession();
    }
    return released;
  }
  public async failPaid(id: Types.ObjectId, token: string) {
    await verifyPackageBatchActivation();
    const { PaymentAttemptModel } = await import("../payment/payment-attempt.model.js");
    const attempt = await PaymentAttemptModel.findOne({
      "packageLifecycleBinding.operationId": String(id),
      providerStatus: "SUCCEEDED",
      persistenceStatus: "FAILED",
      compensationStatus: {
        $in: ["REQUIRED", "REFUND_PENDING", "REFUNDED", "RECONCILIATION_REQUIRED"],
      },
    })
      .read("primary")
      .maxTimeMS(2000);
    if (!attempt) throw batchConflict();
    const query = PackageLifecycleOperationModel.updateOne(
      { _id: id, phase: "PERSISTING", token },
      { $set: { phase: "FAILED_FINAL", "assessment.state": "CAPTURED" }, $unset: { token: "" } },
    );
    grants.add(query);
    return (await query).modifiedCount === 1;
  }
  public async claimDelivery(
    id: Types.ObjectId,
    intent: LifecycleIntent,
    index: number,
    now: Date,
  ) {
    await verifyPackageBatchActivation();
    if (!Number.isSafeInteger(index) || index < 0 || !Number.isFinite(now.getTime()))
      throw batchConflict();
    const row = await PackageLifecycleOperationModel.findById(id).read("primary").maxTimeMS(2000);
    if (
      row?.phase !== "COMPLETE" ||
      digest(row.intent) !== digest(lifecycleIntentSchema.parse(intent))
    )
      throw batchConflict();
    const result = readLifecycleResult(row.result);
    if (!result.tasks[index]) throw batchConflict();
    const token = randomUUID();
    const query = PackageLifecycleOperationModel.findOneAndUpdate(
      {
        _id: id,
        phase: "COMPLETE",
        delivery: {
          $elemMatch: {
            index,
            attempts: { $lt: 10 },
            $or: [
              { state: { $in: ["PENDING", "RETRY"] }, nextDue: { $lte: now } },
              { state: "PENDING", nextDue: { $exists: false } },
              { state: "PROCESSING", expiresAt: { $lte: now } },
            ],
          },
        },
      },
      {
        $set: {
          "delivery.$.state": "PROCESSING",
          "delivery.$.token": token,
          "delivery.$.expiresAt": new Date(now.getTime() + 60000),
        },
        $inc: { "delivery.$.attempts": 1 },
      },
      { returnDocument: "after" },
    );
    grants.add(query);
    return (await query) ? { token, task: result.tasks[index] } : null;
  }
  public async settleDelivery(
    id: Types.ObjectId,
    index: number,
    token: string,
    state: "DONE" | "SKIPPED" | "RETRY" | "BLOCKED_UNVERIFIED",
    now: Date,
  ) {
    await verifyPackageBatchActivation();
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !token ||
      !["DONE", "SKIPPED", "RETRY", "BLOCKED_UNVERIFIED"].includes(state) ||
      !Number.isFinite(now.getTime())
    )
      throw batchConflict();
    const query = PackageLifecycleOperationModel.updateOne(
      {
        _id: id,
        phase: "COMPLETE",
        delivery: { $elemMatch: { index, state: "PROCESSING", token, expiresAt: { $gt: now } } },
      },
      {
        $set: {
          "delivery.$.state": state,
          "delivery.$.completionStage":
            state === "DONE"
              ? "EXISTING_EVENT_RECONCILED"
              : state === "SKIPPED"
                ? "STALE_EVENT_SKIPPED"
                : "NOT_VERIFIED",
          "delivery.$.externalDelivery": "NOT_ATTESTED",
          "delivery.$.nextDue": new Date(now.getTime() + 60000),
        },
        $unset: { "delivery.$.token": "", "delivery.$.expiresAt": "" },
      },
    );
    grants.add(query);
    return (await query).modifiedCount === 1;
  }
}
export const readLifecycleResult = (input: unknown) => resultSchema.parse(input);
