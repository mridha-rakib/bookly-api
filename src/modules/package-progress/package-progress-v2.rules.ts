import { Types } from "mongoose";
import { z } from "zod";
import { businessCities, businessVisitTypes } from "../business/business.types.js";
import { calculatePackagePricing } from "../packages/package-pricing.js";
import type { PackageProgressV2Document } from "./package-progress-v2.types.js";
import {
  purchasedItemContractSchema,
  purchasedPackageContractFragmentsSchema,
} from "./purchased-package-contract.js";

const id = z.custom<Types.ObjectId>(
  (value) => value instanceof Types.ObjectId,
  "Expected ObjectId",
);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const purchasedPackageItemSchema = z
  .object({
    packageItemId: id,
    definitionItemId: id,
    serviceId: id,
    serviceSnapshot: z
      .object({
        name: z.string().trim().min(1),
        pricingMode: z.literal("FIXED"),
        durationMin: count.min(1),
      })
      .strict(),
    totalSessions: count.min(1),
    remainingSessions: count,
    completedSessions: count,
    referenceUnitPriceCents: count.min(1),
    travelCities: z
      .array(z.object({ city: z.enum(businessCities), feeCents: count }).strict())
      .min(1)
      .optional(),
  })
  .strict();
export const purchasedPackageSnapshotSchema = z
  .object({
    name: z.string().trim().min(1),
    packageRevision: count.min(1),
    bundlePriceCents: count,
    referenceTotalCents: count.min(1),
    discountPercent: z.number().min(0).max(100),
    currency: z.literal("EUR"),
    fulfilmentMode: z.enum(businessVisitTypes),
  })
  .strict();
const historicalInputSchema = z
  .object({
    _id: id,
    schemaVersion: z.literal(2),
    creditAccountingVersion: z.literal(1).optional(),
    businessId: id,
    customerUserId: id,
    businessClientId: id,
    packageId: id,
    originBookingId: id,
    purchaseSnapshot: purchasedPackageSnapshotSchema,
    items: z.array(purchasedPackageItemSchema).min(1),
    sessions: z.array(
      z
        .object({
          bookingId: id,
          packageItemId: id,
          serviceId: id,
          sessionIndex: count.min(1).optional(),
          status: z.enum(["SCHEDULED", "COMPLETED", "CANCELLED", "FORFEITED"]),
        })
        .strict(),
    ),
    voidedAt: z.date().optional(),
    voidRefundSettlement: z
      .object({
        status: z.enum(["PENDING", "SUCCEEDED", "FAILED"]),
        amountCents: count.min(1),
        refundOperationId: id.optional(),
        providerRefundId: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const { items: _contractItems, ...contractHeader } =
  purchasedPackageContractFragmentsSchema.unwrap().shape;
export const purchasedContractHeaderSchema = z.object(contractHeader).strict();
export const packageExpiryEventSchema = z
  .object({
    eventKey: z.string().min(1),
    packageProgressId: id,
    packageItemId: id,
    cutoff: z.date(),
    quantity: count,
    reason: z.literal("VALIDITY_EXPIRED"),
    processedAt: z.date(),
  })
  .strict();
export const prospectivePurchasedItemSchema = purchasedPackageItemSchema
  .extend({
    penaltyBasisCents: purchasedItemContractSchema.unwrap().shape.penaltyBasisCents,
    expiredSessions: count,
    expiryEvent: packageExpiryEventSchema.optional(),
  })
  .strict();
export const purchasedAttemptResolutionSchema = z
  .object({
    eventKey: z.string().min(1),
    resolvedAt: z.date(),
    outcome: z.enum(["COMPLETED", "CANCELLED", "FORFEITED"]),
    restorationDisposition: z.enum(["AVAILABLE", "EXPIRED"]).optional(),
  })
  .strict();
const prospectiveInputSchema = historicalInputSchema
  .extend({
    creditAccountingVersion: z.literal(2),
    purchasedContract: purchasedContractHeaderSchema,
    items: z.array(prospectivePurchasedItemSchema).min(1),
    sessions: z.array(
      historicalInputSchema.shape.sessions.element
        .extend({
          resolution: purchasedAttemptResolutionSchema.optional(),
        })
        .strict(),
    ),
    expiryReconciledAt: z.date().optional(),
  })
  .strict();

export const packageProgressV2InputSchema = z
  .union([historicalInputSchema, prospectiveInputSchema])
  .superRefine((progress, context) => {
    const fail = (message: string) => context.addIssue({ code: "custom", message });
    if (progress.voidedAt && progress.sessions.some((attempt) => attempt.status === "SCHEDULED")) {
      fail("Voided Package cannot retain unresolved scheduled attempts");
    }
    for (const key of ["packageItemId", "definitionItemId", "serviceId"] as const) {
      if (new Set(progress.items.map((item) => String(item[key]))).size !== progress.items.length)
        fail(`Duplicate ${key}`);
    }
    if (
      new Set(progress.sessions.map((attempt) => String(attempt.bookingId))).size !==
      progress.sessions.length
    )
      fail("Duplicate Booking attempt");
    for (const attempt of progress.sessions) {
      if (
        !progress.items.some(
          (item) =>
            item.packageItemId.equals(attempt.packageItemId) &&
            item.serviceId.equals(attempt.serviceId),
        )
      )
        fail("Attempt item/Service mismatch");
    }
    for (const item of progress.items) {
      const attempts = progress.sessions.filter((attempt) =>
        item.packageItemId.equals(attempt.packageItemId),
      );
      const scheduled = attempts.filter((attempt) => attempt.status === "SCHEDULED").length;
      const completed = attempts.filter((attempt) => attempt.status === "COMPLETED").length;
      const forfeited = attempts.filter((attempt) => attempt.status === "FORFEITED").length;
      const expired =
        progress.creditAccountingVersion === 2
          ? (progress.items.find((row) => row.packageItemId.equals(item.packageItemId))
              ?.expiredSessions ?? 0)
          : 0;
      if (
        item.completedSessions !== completed ||
        BigInt(item.totalSessions) !==
          BigInt(item.remainingSessions) +
            BigInt(scheduled) +
            BigInt(completed) +
            BigInt(forfeited) +
            BigInt(expired)
      )
        fail("Purchased item credit invariant violated");
      const travel = progress.purchaseSnapshot.fulfilmentMode === "TRAVEL_TO_CUSTOMER";
      if (travel !== (item.travelCities !== undefined))
        fail("Purchased fulfilment terms do not match Business mode");
      if (
        item.travelCities &&
        new Set(item.travelCities.map((city) => city.city)).size !== item.travelCities.length
      )
        fail("Duplicate travel city");
    }
    if (progress.creditAccountingVersion === 2) {
      const header = progress.purchasedContract;
      const parsed = purchasedPackageContractFragmentsSchema.safeParse({
        ...header,
        items: progress.items.map((item) => ({
          version: 1,
          packageId: progress.packageId,
          packageRevision: progress.purchaseSnapshot.packageRevision,
          packageItemId: item.packageItemId,
          definitionItemId: item.definitionItemId,
          serviceId: item.serviceId,
          totalSessions: item.totalSessions,
          penaltyBasisCents: item.penaltyBasisCents,
          provenance: "ACCEPTED_DEFINITION_ITEM",
        })),
      });
      if (!parsed.success) fail(`Purchased contract invalid: ${parsed.error.message}`);
      const { activation, validity, penalty, definition } = header;
      if (
        !activation.packageProgressId.equals(progress._id) ||
        !activation.businessId.equals(progress.businessId) ||
        !activation.customerUserId.equals(progress.customerUserId) ||
        !definition.packageId.equals(progress.packageId) ||
        definition.packageRevision !== progress.purchaseSnapshot.packageRevision ||
        penalty.soldBundlePriceCents !== progress.purchaseSnapshot.bundlePriceCents ||
        penalty.currency !== progress.purchaseSnapshot.currency
      )
        fail("Purchased contract root correlation mismatch");
      const finite = validity.mode === "FINITE" ? validity : undefined;
      if (
        progress.expiryReconciledAt &&
        (!finite || progress.expiryReconciledAt < finite.expiresAt)
      )
        fail("Invalid expiry boundary marker");
      for (const item of progress.items) {
        const event = item.expiryEvent;
        if (
          event &&
          (!finite ||
            !progress.expiryReconciledAt ||
            !event.packageProgressId.equals(progress._id) ||
            !event.packageItemId.equals(item.packageItemId) ||
            event.cutoff.getTime() !== finite.expiresAt.getTime() ||
            event.processedAt.getTime() !== progress.expiryReconciledAt.getTime() ||
            event.processedAt < event.cutoff ||
            event.eventKey !== `expiry:${progress._id}:${item.packageItemId}`)
        )
          fail("Invalid bulk expiry provenance");
        if (progress.expiryReconciledAt && (!event || item.remainingSessions !== 0))
          fail("Reconciled expiry requires every item event and zero R");
        const expiredRestores = progress.sessions.filter(
          (attempt) =>
            attempt.packageItemId.equals(item.packageItemId) &&
            attempt.resolution?.restorationDisposition === "EXPIRED",
        ).length;
        if (BigInt(item.expiredSessions) !== BigInt(event?.quantity ?? 0) + BigInt(expiredRestores))
          fail("Expired quantity provenance mismatch");
        if (!finite && (item.expiredSessions !== 0 || event))
          fail("FOREVER cannot time-expire credits");
      }
      for (const attempt of progress.sessions) {
        const resolution = attempt.resolution;
        if (attempt.status === "SCHEDULED") {
          if (resolution) fail("Scheduled attempt has terminal evidence");
          continue;
        }
        if (
          !resolution ||
          resolution.outcome !== attempt.status ||
          resolution.eventKey !== `resolution:${attempt.bookingId}` ||
          resolution.resolvedAt < validity.purchasedAt
        ) {
          fail("Missing or inconsistent terminal evidence");
          continue;
        }
        if (attempt.status === "CANCELLED") {
          if (
            !resolution.restorationDisposition ||
            (!finite && resolution.restorationDisposition !== "AVAILABLE") ||
            (finite &&
              resolution.resolvedAt >= finite.expiresAt &&
              resolution.restorationDisposition !== "EXPIRED") ||
            (finite &&
              resolution.resolvedAt < finite.expiresAt &&
              resolution.restorationDisposition === "EXPIRED")
          )
            fail("Invalid restoration disposition");
        } else if (resolution.restorationDisposition)
          fail("Non-restoration has a restoration disposition");
      }
    }
    try {
      const pricing = calculatePackagePricing(
        progress.items.map((item) => ({
          includedSessions: item.totalSessions,
          referenceUnitPriceCents: item.referenceUnitPriceCents,
        })),
        progress.purchaseSnapshot.bundlePriceCents,
      );
      if (
        pricing.referenceTotalCents !== progress.purchaseSnapshot.referenceTotalCents ||
        pricing.discountPercent !== progress.purchaseSnapshot.discountPercent
      )
        fail("Purchased reference calculation mismatch");
    } catch (error) {
      fail((error as Error).message);
    }
  });

export const derivePackageProgressV2Totals = (
  progress: Pick<PackageProgressV2Document, "items" | "voidedAt"> &
    Partial<
      Pick<
        PackageProgressV2Document,
        "creditAccountingVersion" | "purchasedContract" | "expiryReconciledAt" | "sessions"
      >
    >,
  now: Date = new Date(),
  originSettlement: "SETTLED" | "LOCKED" | "UNKNOWN" = "UNKNOWN",
) => {
  const sum = (key: "totalSessions" | "remainingSessions" | "completedSessions") => {
    if (progress.items.some((item) => !Number.isSafeInteger(item[key]) || item[key] < 0))
      throw new RangeError("Invalid Package counter");
    const total = progress.items.reduce((value, item) => value + BigInt(item[key]), 0n);
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Package aggregate overflow");
    return Number(total);
  };
  const remainingSessions = sum("remainingSessions");
  const historical = {
    totalSessions: sum("totalSessions"),
    remainingSessions,
    completedSessions: sum("completedSessions"),
    availableSessions: progress.voidedAt ? 0 : remainingSessions,
  };
  if (progress.creditAccountingVersion === undefined || progress.creditAccountingVersion === 1)
    return historical;
  if (progress.creditAccountingVersion !== 2)
    throw new RangeError("Unsupported credit accounting version");
  if (!progress.purchasedContract || !progress.sessions)
    throw new RangeError("Missing prospective context");
  purchasedContractHeaderSchema.parse(progress.purchasedContract);
  const validity = progress.purchasedContract.validity;
  if (!Number.isFinite(now.getTime())) throw new RangeError("Invalid projection time");
  const expired =
    validity.mode === "FINITE" && (now >= validity.expiresAt || !!progress.expiryReconciledAt);
  const rawExpired = progress.items.reduce((sum, item) => {
    if (
      !("expiredSessions" in item) ||
      !Number.isSafeInteger(item.expiredSessions) ||
      (item.expiredSessions as number) < 0
    )
      throw new RangeError("Invalid expired counter");
    return sum + BigInt(item.expiredSessions as number);
  }, 0n);
  if (rawExpired + BigInt(expired ? remainingSessions : 0) > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError("Package aggregate overflow");
  return {
    ...historical,
    availableSessions: progress.voidedAt || expired ? 0 : remainingSessions,
    redeemableSessions:
      originSettlement === "SETTLED" && !progress.voidedAt && !expired ? remainingSessions : 0,
    originSettlement,
    voided: !!progress.voidedAt,
    scheduledSessions: progress.sessions.filter((attempt) => attempt.status === "SCHEDULED").length,
    forfeitedSessions: progress.sessions.filter((attempt) => attempt.status === "FORFEITED").length,
    expiredSessions: Number(rawExpired) + (expired ? remainingSessions : 0),
    materializedExpiredSessions: Number(rawExpired),
    validityExpired: expired,
  };
};
