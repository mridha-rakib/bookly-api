import { Types } from "mongoose";
import { z } from "zod";
import { businessCities } from "../business/business.types.js";
import { putCancellationPolicyBodySchema } from "../business-cancellation-policy/business-cancellation-policy.schema.js";
import { clientPropertyTypes } from "../client/client.types.js";
import {
  purchasedDefinitionTermsSchema,
  purchasedItemContractSchema,
  purchasedPenaltyContractSchema,
} from "../package-progress/purchased-package-contract.js";
import { packageGroupSeatSchema } from "../packages/package-service-entitlement.js";
import { businessCategoryKeys } from "../platform-settings/business-category.js";
import { NO_SHOW_RESOLUTION_WINDOW_MINUTES } from "./booking.types.js";
import { calculateFirstUpfrontCents } from "./financial-contract.js";
import { prepareFinitePackageValidityV1 } from "./package-checkout-validity.js";

/** Internal quote vocabulary only. Parsing/hashing never proves authentication, retained
 * consent, provider success, reservation ownership or purchase activation. P3-B must re-read
 * and atomically establish the canonical claim, financial relationship and real batch.
 */
export const PACKAGE_CHECKOUT_VERSION = 1 as const;
const id = z.custom<Types.ObjectId>(
  (value) => value instanceof Types.ObjectId,
  "Expected ObjectId",
);
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = cents.min(1);
const version = z.literal(PACKAGE_CHECKOUT_VERSION);
const address = z
  .object({
    city: z.enum(businessCities),
    area: z.string().trim().min(1),
    streetName: z.string().trim().min(1),
    streetNumber: z.string().trim().min(1),
    floorUnit: z.string().optional(),
    aptRoom: z.string().optional(),
    location: z
      .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
      .strict()
      .readonly()
      .optional(),
  })
  .strict();
export const packageCheckoutLocationSchema = z
  .discriminatedUnion("mode", [
    z
      .object({ mode: z.literal("AT_BUSINESS_LOCATION"), businessLocation: address.readonly() })
      .strict(),
    z
      .object({
        mode: z.literal("TRAVEL_TO_CUSTOMER"),
        travelAddress: address
          .extend({
            propertyType: z.enum(clientPropertyTypes),
            additionalDirections: z.string().optional(),
          })
          .strict()
          .readonly(),
      })
      .strict(),
  ])
  .readonly();

export const packageCheckoutIntentSchema = z
  .object({
    packageId: id,
    expectedRevision: positive,
    selections: z
      .array(
        z
          .object({
            selectionId: id,
            definitionItemId: id,
            serviceId: id,
            staffMembershipId: id,
            startAt: z.date(),
            addonIds: z.array(id).max(50),
            // At-business location is resolved by the server; no writable business-address authority.
            travelAddress: address
              .omit({ location: true })
              .extend({
                propertyType: z.enum(clientPropertyTypes),
                additionalDirections: z.string().optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const packageCheckoutSeedSchema = z
  .object({
    version,
    quoteId: id,
    batchId: id,
    packageProgressId: id,
    idempotencyKey: z.string().trim().min(1).max(200),
    issuedAt: z.date(),
    expiresAt: z.date(),
    businessId: id,
    customerUserId: id,
    actorUserId: id,
    actorRole: z.literal("CUSTOMER"),
    items: z.array(z.object({ definitionItemId: id, packageItemId: id }).strict()).min(1),
    appointments: z.array(z.object({ selectionId: id, bookingId: id }).strict()).min(1),
    temporalProofRef: id.optional(),
    consentEvidenceId: id.optional(),
  })
  .strict()
  .refine(
    (value) => value.issuedAt < value.expiresAt && value.actorUserId.equals(value.customerUserId),
    "Invalid quote seed window/actor",
  );

/** Supplied finite data is not authority by itself; the preparer uses the separate
 * versioned calculator/proof, which P3-B must retain and reverify at activation. */
export const packageCheckoutValiditySchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("FOREVER") }).strict(),
    z
      .object({
        mode: z.literal("FINITE"),
        months: z.union([z.literal(6), z.literal(12)]),
        timezone: z.string().min(1),
        calculationVersion: version,
        estimatedExpiresAt: z.date(),
        guaranteedNotBeforeExpiry: z.date(),
        activationNotBefore: z.date(),
        activationNotAfterExclusive: z.date(),
        guaranteeProofRef: id,
        guaranteeMethod: z.literal("CONSERVATIVE_GREGORIAN_OFFSET_ENVELOPE_V1"),
      })
      .strict()
      .superRefine((value, ctx) => {
        try {
          const expected = prepareFinitePackageValidityV1({
            months: value.months,
            timezone: value.timezone,
            activationNotBefore: value.activationNotBefore,
            activationNotAfterExclusive: value.activationNotAfterExclusive,
            guaranteeProofRef: value.guaranteeProofRef,
          });
          if (
            expected.guaranteedNotBeforeExpiry.getTime() !==
              value.guaranteedNotBeforeExpiry.getTime() ||
            expected.estimatedExpiresAt.getTime() !== value.estimatedExpiresAt.getTime()
          )
            ctx.addIssue({ code: "custom", message: "Finite estimate/guarantee proof mismatch" });
        } catch {
          ctx.addIssue({ code: "custom", message: "Invalid finite calculation inputs" });
        }
        try {
          if (/^[+-]|^[Zz]$/.test(value.timezone)) throw new Error();
          new Intl.DateTimeFormat("en", { timeZone: value.timezone });
        } catch {
          ctx.addIssue({ code: "custom", message: "Invalid named timezone" });
        }
        if (
          value.activationNotBefore >= value.activationNotAfterExclusive ||
          value.guaranteedNotBeforeExpiry <= value.activationNotAfterExclusive ||
          value.estimatedExpiresAt < value.guaranteedNotBeforeExpiry
        )
          ctx.addIssue({ code: "custom", message: "Inconsistent provisional expiry disclosure" });
      }),
  ])
  .readonly();

const timing = z
  .object({
    version,
    baseDurationMin: positive,
    processingTimeMin: cents,
    bufferAfterMin: cents,
    occupiedDurationMin: positive,
  })
  .strict()
  .readonly();
const addon = z
  .object({ addonId: id, name: z.string().min(1), priceCents: cents })
  .strict()
  .readonly();
export const packageCheckoutAppointmentSchema = z
  .object({
    group: packageGroupSeatSchema.optional(),
    selectionId: id,
    bookingId: id,
    packageItemId: id,
    definitionItemId: id,
    serviceId: id,
    staffMembershipId: id,
    startAt: z.date(),
    endAt: z.date(),
    timing,
    location: packageCheckoutLocationSchema,
    addons: z.array(addon).readonly(),
    travelFeeCents: cents,
    schedulingSource: z.enum(["AUTO", "MANUAL"]),
    availabilityCheckedAt: z.date(),
    staffUpdatedAt: z.date(),
  })
  .strict()
  .readonly();

export const packageTravelEntitlementSchema = z
  .object({
    version: z.literal(1),
    mode: z.literal("TRAVEL_TO_CUSTOMER"),
    source: z.literal("ACTIVE_SERVICE_CITY_INTERSECTION"),
    cities: z.array(z.object({ city: z.enum(businessCities), feeCents: cents }).strict()).min(1),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.cities.map((c) => c.city)).size !== v.cities.length)
      ctx.addIssue({ code: "custom", message: "Duplicate purchased travel city" });
  });

export const packageCheckoutItemSchema = z
  .object({
    group: packageGroupSeatSchema.optional(),
    ...purchasedItemContractSchema.unwrap().shape,
    travelEntitlement: packageTravelEntitlementSchema.optional(),
    serviceName: z.string().min(1),
    baseDurationMin: positive,
    referenceUnitPriceCents: positive,
    serviceUpdatedAt: z.date(),
    eligibleProviderIds: z.array(id).min(1).readonly(),
  })
  .strict()
  .readonly();

export const packageCheckoutPolicySchema = z
  .object({
    cancellation: putCancellationPolicyBodySchema.nullable(),
    noShowWindow: z
      .object({
        categoryKey: z.enum(businessCategoryKeys),
        opensAfterMinutes: cents,
        closesAfterMinutes: positive,
      })
      .strict()
      .refine((row) => row.opensAfterMinutes < row.closesAfterMinutes)
      .nullable(),
    noShowResolutionMinutes: z.literal(NO_SHOW_RESOLUTION_WINDOW_MINUTES),
  })
  .strict()
  .readonly();

export const packageCheckoutDisclosureSchema = z
  .object({
    version,
    unusedCreditsExpireOnlyWhenFinite: z.literal(true),
    scheduledAttemptsSurviveExpiry: z.literal(true),
    expiryNeverChargesMoney: z.literal(true),
    qualifyingEventMayForfeitCreditAndChargeSeparately: z.literal(true),
    savedCardUseRequiresExplicitAcceptance: z.literal(true),
    purchaseDepositOffsetsPenalty: z.literal(false),
    normalDuesAreManual: z.literal(true),
    monetaryTermsProspectiveOnly: z.literal(true),
  })
  .strict()
  .readonly();

const money = z
  .object({
    classification: z.enum(["FIRST", "RETURNING"]),
    classificationAuthority: z.literal("RELATIONSHIP_ESTIMATE_REQUIRES_FINALIZE"),
    currency: z.literal("EUR"),
    bundlePriceCents: cents,
    addonsCents: cents,
    travelCents: cents,
    normalTotalCents: cents,
    requiredUpfrontCents: cents,
    manualVenueDuesCents: cents,
    upfrontOwner: z.enum(["PLATFORM_FEE", "NONE"]),
    appointments: z
      .array(
        z
          .object({
            bookingId: id,
            includedBaseCents: cents,
            addonsCents: cents,
            travelCents: cents,
            upfrontCents: cents,
            manualVenueDuesCents: cents,
          })
          .strict()
          .readonly(),
      )
      .min(1)
      .readonly(),
  })
  .strict()
  .readonly();

export const safeCheckoutSum = (values: readonly number[]): number => {
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
    throw new RangeError("Invalid checkout cents");
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Checkout aggregate overflow");
  return Number(total);
};

/** UTC start then stable planned Booking ObjectId; independent of input array order. */
export const comparePackageCheckoutIds = (left: Types.ObjectId, right: Types.ObjectId): number => {
  const a = left.toHexString(),
    b = right.toHexString();
  return a < b ? -1 : a > b ? 1 : 0;
};
export const selectPackageFinancialOrigin = (
  appointments: readonly { bookingId: Types.ObjectId; startAt: Date }[],
): Types.ObjectId => {
  if (!appointments.length || appointments.some((row) => !Number.isFinite(row.startAt.getTime())))
    throw new Error("Initial appointments required");
  const selected = [...appointments].sort(
    (left, right) =>
      left.startAt.getTime() - right.startAt.getTime() ||
      comparePackageCheckoutIds(left.bookingId, right.bookingId),
  )[0];
  if (!selected) throw new Error("Missing origin");
  return selected.bookingId;
};

export const quotePackageCheckoutMoney = (
  bundlePriceCents: number,
  classification: "FIRST" | "RETURNING",
  originBookingId: Types.ObjectId,
  appointments: readonly z.output<typeof packageCheckoutAppointmentSchema>[],
) => {
  safeCheckoutSum([bundlePriceCents]);
  if (!["FIRST", "RETURNING"].includes(classification))
    throw new Error("Unsupported relationship classification");
  if (appointments.filter((row) => row.bookingId.equals(originBookingId)).length !== 1)
    throw new Error("Missing unique origin");
  const requiredUpfrontCents =
    classification === "FIRST" ? calculateFirstUpfrontCents(bundlePriceCents) : 0;
  const rows = appointments.map((row) => {
    const includedBaseCents = row.bookingId.equals(originBookingId) ? bundlePriceCents : 0;
    const upfrontCents = row.bookingId.equals(originBookingId) ? requiredUpfrontCents : 0;
    const addonsCents = safeCheckoutSum(row.addons.map((addon) => addon.priceCents));
    return {
      bookingId: row.bookingId,
      includedBaseCents,
      addonsCents,
      travelCents: row.travelFeeCents,
      upfrontCents,
      manualVenueDuesCents:
        safeCheckoutSum([includedBaseCents, addonsCents, row.travelFeeCents]) - upfrontCents,
    };
  });
  const addonsCents = safeCheckoutSum(rows.map((row) => row.addonsCents));
  const travelCents = safeCheckoutSum(rows.map((row) => row.travelCents));
  const normalTotalCents = safeCheckoutSum([bundlePriceCents, addonsCents, travelCents]);
  return money.parse({
    classification,
    classificationAuthority: "RELATIONSHIP_ESTIMATE_REQUIRES_FINALIZE",
    currency: "EUR",
    bundlePriceCents,
    addonsCents,
    travelCents,
    normalTotalCents,
    requiredUpfrontCents,
    manualVenueDuesCents: normalTotalCents - requiredUpfrontCents,
    upfrontOwner: requiredUpfrontCents > 0 ? "PLATFORM_FEE" : "NONE",
    appointments: rows,
  });
};

export const packageCheckoutQuoteSchema = z
  .object({
    version,
    quoteId: id,
    batchId: id,
    packageProgressId: id,
    idempotencyKey: z.string().min(1).max(200),
    businessId: id,
    customerUserId: id,
    actorUserId: id,
    actorRole: z.literal("CUSTOMER"),
    packageId: id,
    definitionRevision: positive,
    definitionTerms: purchasedDefinitionTermsSchema,
    packageName: z.string().min(1),
    issuedAt: z.date(),
    expiresAt: z.date(),
    businessTimezone: z.string().min(1),
    source: z.literal("BOOKLY_MANAGED"),
    state: z.literal("INTERNAL_UNRETAINED_NOT_ACCEPTED"),
    items: z.array(packageCheckoutItemSchema).min(1).readonly(),
    appointments: z.array(packageCheckoutAppointmentSchema).min(1).readonly(),
    originBookingId: id,
    validity: packageCheckoutValiditySchema,
    financials: money,
    penalty: purchasedPenaltyContractSchema,
    policy: packageCheckoutPolicySchema,
    disclosure: packageCheckoutDisclosureSchema,
    savedCardStatus: z.enum(["LOCAL_REFERENCE_PRESENT", "MISSING"]),
    providerState: z.literal("NOT_DISPATCHED"),
  })
  .strict()
  .superRefine((quote, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (!quote.actorUserId.equals(quote.customerUserId) || quote.issuedAt >= quote.expiresAt)
      fail("Invalid actor/quote lifetime");
    const selectedValidity =
      quote.definitionTerms.version === 1
        ? { mode: "FINITE", months: quote.definitionTerms.validityMonths }
        : quote.definitionTerms.validity;
    if (
      selectedValidity.mode !== quote.validity.mode ||
      (selectedValidity.mode === "FINITE" &&
        quote.validity.mode === "FINITE" &&
        selectedValidity.months !== quote.validity.months)
    )
      fail("Definition validity mismatch");
    for (const key of ["packageItemId", "definitionItemId", "serviceId"] as const)
      if (new Set(quote.items.map((row) => row[key].toHexString())).size !== quote.items.length)
        fail(`Duplicate item ${key}`);
    for (const key of ["selectionId", "bookingId"] as const)
      if (
        new Set(quote.appointments.map((row) => row[key].toHexString())).size !==
        quote.appointments.length
      )
        fail(`Duplicate appointment ${key}`);
    if (
      quote.items.reduce((sum, item) => sum + BigInt(item.totalSessions), 0n) >
      BigInt(Number.MAX_SAFE_INTEGER)
    )
      fail("Purchased quantity overflow");
    for (const item of quote.items) {
      if (
        !item.packageId.equals(quote.packageId) ||
        item.packageRevision !== quote.definitionRevision
      )
        fail("Item definition mismatch");
      if (
        quote.appointments.filter((row) => row.packageItemId.equals(item.packageItemId)).length >
        item.totalSessions
      )
        fail("Selected quantity exceeds purchased item");
    }
    for (const row of quote.appointments) {
      const item = quote.items.find((item) => item.packageItemId.equals(row.packageItemId));
      if (
        !item?.definitionItemId.equals(row.definitionItemId) ||
        !item.serviceId.equals(row.serviceId) ||
        item.baseDurationMin !== row.timing.baseDurationMin ||
        JSON.stringify(item.group) !== JSON.stringify(row.group) ||
        (row.group !== undefined && row.timing.processingTimeMin !== 0)
      )
        fail("Foreign/mismatched appointment item");
      if (item?.travelEntitlement) {
        if (row.location.mode !== "TRAVEL_TO_CUSTOMER")
          fail("Travel rights on a venue appointment");
        else {
          const city = row.location.travelAddress.city;
          if (
            item.travelEntitlement.cities.find((c) => c.city === city)?.feeCents !==
            row.travelFeeCents
          )
            fail("Selected travel fee differs from accepted purchased rights");
        }
      }
      const timing = row.timing;
      const occupied =
        BigInt(timing.baseDurationMin) +
        BigInt(timing.processingTimeMin) +
        BigInt(timing.bufferAfterMin);
      if (
        occupied !== BigInt(timing.occupiedDurationMin) ||
        BigInt(row.endAt.getTime()) - BigInt(row.startAt.getTime()) !== occupied * 60000n
      )
        fail("Invalid occupied duration");
      if (
        row.startAt <= quote.issuedAt ||
        row.availabilityCheckedAt < quote.issuedAt ||
        row.availabilityCheckedAt >= quote.expiresAt
      )
        fail("Stale/future scheduling evidence");
      if (
        new Set(row.addons.map((addon) => addon.addonId.toHexString())).size !== row.addons.length
      )
        fail("Duplicate add-on");
      if (row.location.mode === "AT_BUSINESS_LOCATION" && row.travelFeeCents !== 0)
        fail("Unexpected travel fee");
      if (
        quote.validity.mode === "FINITE" &&
        (quote.issuedAt >= quote.validity.guaranteedNotBeforeExpiry ||
          row.startAt >= quote.validity.guaranteedNotBeforeExpiry ||
          quote.expiresAt > quote.validity.activationNotAfterExclusive ||
          quote.issuedAt < quote.validity.activationNotBefore ||
          quote.businessTimezone !== quote.validity.timezone)
      )
        fail("Finite quote/start outside disclosed bound");
    }
    for (let index = 0; index < quote.appointments.length; index++) {
      const row = quote.appointments[index];
      if (
        row &&
        quote.appointments
          .slice(index + 1)
          .some(
            (other) =>
              row.staffMembershipId.equals(other.staffMembershipId) &&
              row.startAt < other.endAt &&
              other.startAt < row.endAt,
          )
      )
        fail("Selected appointments overlap the same provider");
    }
    if (!selectPackageFinancialOrigin(quote.appointments).equals(quote.originBookingId))
      fail("Financial origin selection mismatch");
    if (quote.penalty.soldBundlePriceCents !== quote.financials.bundlePriceCents)
      fail("Penalty sold-price mismatch");
    try {
      const expected = quotePackageCheckoutMoney(
        quote.financials.bundlePriceCents,
        quote.financials.classification,
        quote.originBookingId,
        quote.appointments,
      );
      if (JSON.stringify(expected) !== JSON.stringify(quote.financials))
        fail("Financial quote mismatch");
    } catch {
      fail("Invalid financial aggregate");
    }
  })
  .readonly();

export type PackageCheckoutIntent = z.output<typeof packageCheckoutIntentSchema>;
export type PackageCheckoutValidity = z.output<typeof packageCheckoutValiditySchema>;
export type PackageCheckoutSeed = z.output<typeof packageCheckoutSeedSchema>;
export type PackageCheckoutQuote = z.output<typeof packageCheckoutQuoteSchema>;
export type PackageCheckoutAppointment = z.output<typeof packageCheckoutAppointmentSchema>;
