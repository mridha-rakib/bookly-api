import type { Types } from "mongoose";
import { z } from "zod";
import type { BookingPackageContext } from "./booking-package-foundation.js";
import {
  comparePackageCheckoutIds,
  packageCheckoutSeedSchema,
  safeCheckoutSum,
  selectPackageFinancialOrigin,
} from "./package-checkout-contract.js";
import { packageCheckoutRetentionSchema } from "./package-checkout-retention.js";

const identity = packageCheckoutSeedSchema.shape;
const planningInputSchema = z
  .object({
    retention: packageCheckoutRetentionSchema,
    claim: z
      .object({
        idempotencyKey: identity.idempotencyKey,
        businessId: identity.businessId,
        actorUserId: identity.actorUserId,
        bookingId: identity.quoteId,
      })
      .strict(),
  })
  .strict()
  .superRefine(({ claim, retention }, ctx) => {
    const quote = retention.quote.payload;
    if (
      claim.idempotencyKey !== quote.idempotencyKey ||
      !claim.businessId.equals(quote.businessId) ||
      !claim.actorUserId.equals(quote.customerUserId) ||
      !claim.bookingId.equals(quote.originBookingId) ||
      !selectPackageFinancialOrigin(quote.appointments).equals(claim.bookingId)
    )
      ctx.addIssue({ code: "custom", message: "Retained claim identity/origin mismatch" });
    for (const row of quote.appointments) {
      const item = quote.items.find((item) => item.packageItemId.equals(row.packageItemId));
      if (!item?.eligibleProviderIds.some((provider) => provider.equals(row.staffMembershipId)))
        ctx.addIssue({ code: "custom", message: "Provider absent from retained item eligibility" });
    }
  });

/** Detached JSON planning values, deliberately not a Booking/Progress persistence DTO. */
export type PackagePlanningSnapshot<T> = T extends Types.ObjectId | Date
  ? string
  : T extends readonly (infer Row)[]
    ? readonly PackagePlanningSnapshot<Row>[]
    : T extends object
      ? { readonly [Key in keyof T]: PackagePlanningSnapshot<T[Key]> }
      : T;

const freeze = (value: unknown): void => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
};
const snapshot = <T>(value: T): PackagePlanningSnapshot<T> => {
  // Only validated local contracts: ObjectId/Date JSON conversion preserves supplied values.
  const copy: PackagePlanningSnapshot<T> = JSON.parse(JSON.stringify(value));
  freeze(copy);
  return copy;
};

/** No I/O, new identities, wall-clock decisions or authority issuance. A future caller must
 * load the canonical claim and independently prove auth, strict consent deadline, current
 * eligibility, financial readiness and genuine winning activation. A hash is not provenance.
 */
export const planPackageBatchMaterialization = (input: unknown) => {
  const { retention } = planningInputSchema.parse(input);
  const quote = retention.quote.payload;
  const items = [...quote.items].sort((a, b) =>
    comparePackageCheckoutIds(a.packageItemId, b.packageItemId),
  );
  const appointments = [...quote.appointments].sort(
    (a, b) =>
      a.startAt.getTime() - b.startAt.getTime() ||
      comparePackageCheckoutIds(a.bookingId, b.bookingId),
  );
  const bookings = appointments.map((row) => {
    const item = items.find((item) => item.packageItemId.equals(row.packageItemId));
    const allocation = quote.financials.appointments.find((a) => a.bookingId.equals(row.bookingId));
    // The retained schema proves exact membership and financial allocation before this mapping.
    if (!item || !allocation) throw new Error("Missing retained materialization membership");
    const packageContext: BookingPackageContext = {
      packageId: quote.packageId,
      packageName: quote.packageName,
      definitionItemId: item.definitionItemId,
      role: "PURCHASE",
    };
    return {
      bookingId: row.bookingId,
      selectionId: row.selectionId,
      isFinancialOrigin: row.bookingId.equals(quote.originBookingId),
      schedule: { timezone: quote.businessTimezone, startAt: row.startAt, endAt: row.endAt },
      fulfilment: row.location,
      serviceLine: {
        serviceId: row.serviceId,
        responsibleStaffMembershipId: row.staffMembershipId,
        serviceSnapshot: {
          name: item.serviceName,
          pricingMode: "PACKAGE" as const,
          durationMin: item.baseDurationMin,
        },
        pricingInput: {
          packageProgressId: quote.packageProgressId,
          packageItemId: row.packageItemId,
        },
        packageContext,
        schedulingSnapshot: { ...row.timing, ...(row.group ? { group: row.group } : {}) },
        addons: [...row.addons].sort((a, b) => comparePackageCheckoutIds(a.addonId, b.addonId)),
        amountCents: allocation.includedBaseCents,
      },
      quotedAllocation: allocation,
      schedulingObservation: {
        source: row.schedulingSource,
        availabilityCheckedAt: row.availabilityCheckedAt,
        staffUpdatedAt: row.staffUpdatedAt,
      },
    };
  });
  const sessions = appointments.map((row) => ({
    bookingId: row.bookingId,
    packageItemId: row.packageItemId,
    serviceId: row.serviceId,
    status: "SCHEDULED" as const,
  }));
  const progressItems = items.map((item) => ({
    packageItemId: item.packageItemId,
    definitionItemId: item.definitionItemId,
    serviceId: item.serviceId,
    serviceSnapshot: {
      name: item.serviceName,
      pricingMode: item.group ? ("PER_PERSON" as const) : ("FIXED" as const),
      durationMin: item.baseDurationMin,
      ...(item.group ? { group: item.group } : {}),
    },
    referenceUnitPriceCents: item.referenceUnitPriceCents,
    penaltyBasisCents: item.penaltyBasisCents,
    totalSessions: item.totalSessions,
    remainingSessions:
      item.totalSessions -
      sessions.filter((row) => row.packageItemId.equals(item.packageItemId)).length,
    completedSessions: 0,
    expiredSessions: 0,
  }));
  return snapshot({
    version: 1 as const,
    state: "PREPARATION_ONLY_NOT_ACTIVATED" as const,
    authority: "UNVERIFIED_RETAINED_FACTS" as const,
    identity: {
      idempotencyKey: quote.idempotencyKey,
      quoteId: quote.quoteId,
      termsHash: retention.quote.termsHash,
      batchId: quote.batchId,
      businessId: quote.businessId,
      customerUserId: quote.customerUserId,
      actorUserId: quote.actorUserId,
      packageId: quote.packageId,
      definitionRevision: quote.definitionRevision,
      packageProgressId: quote.packageProgressId,
      originBookingId: quote.originBookingId,
    },
    offerWindow: { issuedAt: quote.issuedAt, expiresAt: quote.expiresAt },
    bookings,
    progress: {
      packageProgressId: quote.packageProgressId,
      originBookingId: quote.originBookingId,
      items: progressItems,
      sessions,
    },
    // Summary only; scheduled/forfeited counts remain derived from attempts, never stored counters.
    accountingSummary: {
      totalSessions: safeCheckoutSum(progressItems.map((item) => item.totalSessions)),
      remainingSessions: safeCheckoutSum(progressItems.map((item) => item.remainingSessions)),
      scheduledSessions: sessions.length,
      completedSessions: 0,
      forfeitedSessions: 0,
      expiredSessions: 0,
    },
    quotedFinancials: {
      ...quote.financials,
      appointments: bookings.map((booking) => booking.quotedAllocation),
    },
    retainedTerms: {
      packageName: quote.packageName,
      businessTimezone: quote.businessTimezone,
      definition: quote.definitionTerms,
      validityDisclosure: quote.validity,
      penalty: quote.penalty,
      policy: quote.policy,
      disclosure: quote.disclosure,
    },
    deferred: [
      "AUTHENTICATED_CUSTOMER_AND_CANONICAL_CONSENT_WITH_STRICT_DEADLINE",
      "CURRENT_DEFINITION_POLICY_STAFF_AND_SCHEDULE_ELIGIBILITY",
      "FINAL_FINANCIAL_CONTRACT_AND_PAYMENT_READINESS",
      "BUSINESS_CLIENT_CONTACT_AND_STAFF_DISPLAY_SNAPSHOTS",
      "BOOKING_REFERENCES_RESERVATIONS_AND_LIFECYCLE_INITIALIZATION",
      "PROGRESS_PURCHASE_SNAPSHOT_AND_TRAVEL_ENTITLEMENT",
      "WINNING_ACTIVATION_EVENT_PURCHASED_AT_AND_FINAL_EXPIRY",
      "ATOMIC_COMMIT_AND_RECOVERY",
    ] as const,
  });
};

export type PackageBatchMaterializationPlan = ReturnType<typeof planPackageBatchMaterialization>;
