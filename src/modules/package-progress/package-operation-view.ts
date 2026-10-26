import mongoose from "mongoose";
import { z } from "zod";
import type { PackageProgressV2Document } from "./package-progress-v2.types.js";

const operation = z.object({
  phase: z.enum(["PREPARED", "PERSISTING", "COMPLETE", "FAILED_FINAL"]),
  intent: z.object({
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
  }),
  result: z
    .object({
      status: z.enum([
        "UPCOMING",
        "COMPLETED",
        "PENDING",
        "NO_SHOW_CHARGED",
        "NO_SHOW_WAIVED",
        "NO_SHOW_CANCELLED",
        "CANCELLED_BY_CUSTOMER",
        "CANCELLED_BY_BUSINESS",
        "LATE_CANCELLATION",
        "EXPIRED",
      ]),
      committedAt: z.date(),
    })
    .optional(),
  assessment: z.object({ amountCents: z.number().int().nonnegative() }).optional(),
  sessionQuote: z
    .object({
      disclosure: z.string(),
      terms: z.object({
        totalCents: z.number().int().nonnegative(),
      }),
    })
    .optional(),
  delivery: z.array(z.object({ state: z.string() })).optional(),
});
const acceptedSession = z.object({
  quoteId: z.instanceof(mongoose.Types.ObjectId),
  termsHash: z.string(),
  disclosureHash: z.string(),
  sessionFamilyId: z.string(),
  customerUserId: z.instanceof(mongoose.Types.ObjectId),
  acceptedAt: z.date(),
  action: z.literal("ACCEPT_SESSION_DUES"),
});
const quotedSession = acceptedSession.pick({
  quoteId: true,
  termsHash: true,
  disclosureHash: true,
  sessionFamilyId: true,
});

/** Existing collection reads, with an inclusion projection, avoid registering guarded kernels
 * or their indexes/workers. Receipt presence is not purchase/payment authority. */
export async function readPackageOperationViews(progress: PackageProgressV2Document) {
  const scope = {
    businessId: progress.businessId,
    customerUserId: progress.customerUserId,
    businessClientId: progress.businessClientId,
    packageProgressId: progress._id,
  };
  const [receipts, attempts] = await Promise.all([
    mongoose.connection
      .collection("packagelifecycleoperations")
      .find(
        {
          "intent.businessId": scope.businessId,
          "intent.customerUserId": scope.customerUserId,
          "intent.businessClientId": scope.businessClientId,
          "intent.packageProgressId": scope.packageProgressId,
        },
        {
          projection: {
            _id: 0,
            phase: 1,
            "intent.action": 1,
            "result.status": 1,
            "result.committedAt": 1,
            "assessment.amountCents": 1,
            "sessionQuote.disclosure": 1,
            "sessionQuote.terms.totalCents": 1,
            "sessionQuote.quoteId": 1,
            "sessionQuote.termsHash": 1,
            "sessionQuote.disclosureHash": 1,
            "sessionQuote.sessionFamilyId": 1,
            "sessionAcceptance.quoteId": 1,
            "sessionAcceptance.termsHash": 1,
            "sessionAcceptance.disclosureHash": 1,
            "sessionAcceptance.sessionFamilyId": 1,
            "sessionAcceptance.customerUserId": 1,
            "sessionAcceptance.acceptedAt": 1,
            "sessionAcceptance.action": 1,
            "delivery.state": 1,
          },
          maxTimeMS: 2000,
        },
      )
      .limit(100)
      .toArray(),
    mongoose.connection
      .collection("paymentattempts")
      .find(
        {
          ...scope,
          purpose: "PACKAGE_LIFECYCLE_MONEY",
          "packageLifecycleBinding.businessId": String(scope.businessId),
          "packageLifecycleBinding.customerUserId": String(scope.customerUserId),
          "packageLifecycleBinding.businessClientId": String(scope.businessClientId),
          "packageLifecycleBinding.packageProgressId": String(scope.packageProgressId),
        },
        {
          projection: {
            _id: 0,
            "packageLifecycleBinding.kind": 1,
            expectedAmountCents: 1,
            currency: 1,
            providerStatus: 1,
            persistenceStatus: 1,
            compensationStatus: 1,
          },
          maxTimeMS: 2000,
        },
      )
      .limit(100)
      .toArray(),
  ]);
  return {
    operations: receipts.map((row) => {
      const parsed = operation.safeParse(row);
      if (!parsed.success)
        return {
          action: "UNKNOWN",
          state: "UNKNOWN",
          resultStatus: null,
          disclosure: null,
          amountCents: null,
          notificationStates: [] as string[],
        };
      const value = parsed.data;
      const accepted = acceptedSession.safeParse(row["sessionAcceptance"]);
      const quoted = quotedSession.safeParse(row["sessionQuote"]);
      const acceptedAt =
        accepted.success &&
        quoted.success &&
        accepted.data.customerUserId.equals(progress.customerUserId) &&
        accepted.data.quoteId.equals(quoted.data.quoteId) &&
        accepted.data.termsHash === quoted.data.termsHash &&
        accepted.data.disclosureHash === quoted.data.disclosureHash &&
        accepted.data.sessionFamilyId === quoted.data.sessionFamilyId
          ? accepted.data.acceptedAt.toISOString()
          : null;
      return {
        action: value.intent.action,
        state: value.phase,
        resultStatus: value.phase === "COMPLETE" && value.result ? value.result.status : null,
        disclosure: value.sessionQuote?.disclosure ?? null,
        sessionAcceptanceRecordedAt: acceptedAt,
        amountCents: value.assessment?.amountCents ?? value.sessionQuote?.terms.totalCents ?? null,
        notificationStates: value.delivery?.map((d) => d.state) ?? [],
      };
    }),
    payments: attempts.map((row) => {
      const parsed = z
        .object({
          packageLifecycleBinding: z.object({
            kind: z.enum(["SESSION_DUES", "CANCELLATION_FEE", "NO_SHOW_FEE"]),
          }),
          expectedAmountCents: z.number().int().nonnegative(),
          currency: z.literal("EUR"),
          providerStatus: z.string(),
          persistenceStatus: z.string(),
          compensationStatus: z.string(),
        })
        .safeParse(row);
      return parsed.success
        ? {
            kind: parsed.data.packageLifecycleBinding.kind,
            amountCents: parsed.data.expectedAmountCents,
            providerState: parsed.data.providerStatus,
            persistenceState: parsed.data.persistenceStatus,
            compensationState: parsed.data.compensationStatus,
          }
        : {
            kind: "UNKNOWN",
            amountCents: null,
            providerState: "UNKNOWN",
            persistenceState: "UNKNOWN",
            compensationState: "UNKNOWN",
          };
    }),
    historyLimit: 100,
  };
}
