import { z } from "zod";

import { businessCities } from "../business/business.types.js";
import { clientPropertyTypes } from "../client/client.types.js";
import { bookingSources, bookingStatuses } from "./booking.types.js";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const isoDateTimeSchema = z.string().datetime({ offset: true }).or(z.string().datetime());

export const bookingBusinessParamsSchema = z.object({ businessId: objectIdSchema }).strict();

export const bookingIdParamsSchema = z
  .object({ businessId: objectIdSchema, bookingId: objectIdSchema })
  .strict();

export const bookingIdOnlyParamsSchema = z.object({ bookingId: objectIdSchema }).strict();

const pricingInputBodySchema = z
  .object({
    hours: z.coerce.number().positive().max(24).optional(),
    personCount: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict();

const serviceLineBodySchema = z
  .object({
    serviceId: objectIdSchema,
    staffMembershipId: objectIdSchema,
    addonIds: z.array(objectIdSchema).max(50).default([]),
    pricingInput: pricingInputBodySchema.default({}),
  })
  .strict();

const travelAddressBodySchema = z
  .object({
    city: z.enum(businessCities),
    propertyType: z.enum(clientPropertyTypes),
    area: z.string().trim().min(1).max(200),
    streetName: z.string().trim().min(1).max(200),
    streetNumber: z.string().trim().min(1).max(50),
    floorUnit: z.string().trim().max(50).optional(),
    aptRoom: z.string().trim().max(50).optional(),
    additionalDirections: z.string().trim().max(500).optional(),
  })
  .strict();

const createBookingBodyBase = z.object({
  serviceLines: z.array(serviceLineBodySchema).min(1).max(20),
  startAt: isoDateTimeSchema,
  travelAddress: travelAddressBodySchema.optional(),
  customerCity: z.enum(businessCities).optional(),
  notes: z.string().trim().max(2000).optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
  // Batch 13 — Customer checkout only; createManualBooking never reads this field.
  promoCode: z.string().trim().min(1).max(40).optional(),
});

export const createManualBookingBodySchema = createBookingBodyBase
  .extend({ businessClientId: objectIdSchema })
  .strict();

export const createCustomerBookingPreviewBodySchema = createBookingBodyBase.strict();

/**
 * Package purchase (preview + finalize) — reuses createBookingBodyBase's full shape (same
 * fields a normal Customer booking preview/finalize already sends: startAt, travelAddress,
 * customerCity, notes, idempotencyKey) but requires EXACTLY one service line, since a Package
 * purchase is always for one Package Deal Service (Type 1 — see package-progress.model.ts's own
 * doc comment). Whether that one line's Service actually IS a Package Deal is a database fact
 * the schema layer cannot see — enforced in BookingCreationService.finalizePackagePurchase.
 * Deliberately omits `promoCode` — Promo Code support for Package purchases is not built in
 * this phase (see the Package Deal audit's own "deferred" list).
 */
export const packagePurchaseBodySchema = createBookingBodyBase
  .omit({ promoCode: true })
  .extend({ serviceLines: z.array(serviceLineBodySchema).length(1) })
  .strict();

/**
 * Redeem one remaining session of an already-purchased Package — no service-line pricing input
 * at all (the base Service, price, and duration are already fixed by the entitlement itself;
 * see PackageProgressRepository.claimSession), just the appointment specifics a normal booking
 * needs: who provides it, when, (for a TRAVEL_TO_CUSTOMER business) where, and which valid
 * Add-ons to attach (approved rule: the Package base is $0, but Add-ons and any real travel fee
 * remain separately payable via the existing deposit/balance machinery — see
 * BookingCreationService.redeemPackageSession's own doc comment).
 */
export const redeemPackageSessionBodySchema = z
  .object({
    staffMembershipId: objectIdSchema,
    startAt: isoDateTimeSchema,
    addonIds: z.array(objectIdSchema).max(50).default([]),
    travelAddress: travelAddressBodySchema.optional(),
    customerCity: z.enum(businessCities).optional(),
    notes: z.string().trim().max(2000).optional(),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

/**
 * Whole-Package refund/void (approved rule) — the only body field is an optional customer-
 * supplied reason, passed through unmodified to the SAME cancellation path a normal
 * cancelBookingBodySchema request already uses (see BookingLifecycleService.voidUnusedPackage,
 * which reuses cancelByCustomer verbatim for the origin session when it is still UPCOMING).
 */
export const voidPackageBodySchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();

export const rescheduleBookingBodySchema = z.object({ startAt: isoDateTimeSchema }).strict();

export const cancelBookingBodySchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();

export const waiveFeeBodySchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
    internalNote: z.string().trim().max(2000).optional(),
  })
  .strict();

/**
 * Mark-no-show reason taxonomy — SEPARATE from waiveFeeBodySchema. Both optional and
 * internal-only (never surfaced in a customer-facing DTO).
 */
export const markNoShowBodySchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
    internalNote: z.string().trim().max(2000).optional(),
  })
  .strict();

/**
 * Complete-booking venue settlement — explicit 3-state discriminator. FULL/NOT_PAID carry no
 * amount; PARTIAL requires a positive integer `amountCents` (the service additionally checks it
 * is strictly below the booking's remaining balance). No saved-card charge is ever triggered.
 */
export const completeBookingBodySchema = z
  .object({
    venuePayment: z
      .discriminatedUnion("settlement", [
        z
          .object({
            settlement: z.literal("FULL"),
            note: z.string().trim().max(2000).optional(),
          })
          .strict(),
        z
          .object({
            settlement: z.literal("PARTIAL"),
            amountCents: z.number().int().positive().max(10_000_000),
            note: z.string().trim().max(2000).optional(),
          })
          .strict(),
        z
          .object({
            settlement: z.literal("NOT_PAID"),
            note: z.string().trim().max(2000).optional(),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();

const paginationQuerySchema = z.object({
  page: z.string().regex(/^\d+$/, "Invalid page").optional(),
  limit: z.string().regex(/^\d+$/, "Invalid limit").optional(),
});

export const listBusinessBookingsQuerySchema = paginationQuerySchema
  .extend({
    status: z.string().optional(),
    staffMembershipId: objectIdSchema.optional(),
    businessClientId: objectIdSchema.optional(),
    fromDate: isoDateTimeSchema.optional(),
    toDate: isoDateTimeSchema.optional(),
  })
  .strict()
  .transform((value) => ({
    page: value.page ? Math.max(1, Number(value.page)) : 1,
    limit: value.limit ? Math.min(100, Math.max(1, Number(value.limit))) : 20,
    status: value.status
      ? (value.status
          .split(",")
          .filter((s) =>
            (bookingStatuses as readonly string[]).includes(s),
          ) as (typeof bookingStatuses)[number][])
      : undefined,
    staffMembershipId: value.staffMembershipId,
    businessClientId: value.businessClientId,
    fromDate: value.fromDate ? new Date(value.fromDate) : undefined,
    toDate: value.toDate ? new Date(value.toDate) : undefined,
  }));

export const listCustomerBookingsQuerySchema = paginationQuerySchema
  .extend({
    status: z.string().optional(),
    // Batch 16 — Book Again's own real-history query narrows to BOOKLY_MANAGED (a Business
    // Owner's MANUAL entry was never something the Customer themselves booked). Optional,
    // same comma-split-and-filter convention as `status` immediately above.
    source: z.string().optional(),
    fromDate: isoDateTimeSchema.optional(),
    toDate: isoDateTimeSchema.optional(),
  })
  .strict()
  .transform((value) => ({
    page: value.page ? Math.max(1, Number(value.page)) : 1,
    limit: value.limit ? Math.min(100, Math.max(1, Number(value.limit))) : 20,
    status: value.status
      ? (value.status
          .split(",")
          .filter((s) =>
            (bookingStatuses as readonly string[]).includes(s),
          ) as (typeof bookingStatuses)[number][])
      : undefined,
    source: value.source
      ? (value.source
          .split(",")
          .filter((s) =>
            (bookingSources as readonly string[]).includes(s),
          ) as (typeof bookingSources)[number][])
      : undefined,
    fromDate: value.fromDate ? new Date(value.fromDate) : undefined,
    toDate: value.toDate ? new Date(value.toDate) : undefined,
  }));

export const calendarQuerySchema = z
  .object({ fromDate: isoDateTimeSchema, toDate: isoDateTimeSchema })
  .strict();

export type BookingBusinessParams = z.infer<typeof bookingBusinessParamsSchema>;
export type BookingIdParams = z.infer<typeof bookingIdParamsSchema>;
export type BookingIdOnlyParams = z.infer<typeof bookingIdOnlyParamsSchema>;
export type CreateManualBookingBody = z.infer<typeof createManualBookingBodySchema>;
export type CreateCustomerBookingPreviewBody = z.infer<
  typeof createCustomerBookingPreviewBodySchema
>;
export type PackagePurchaseBody = z.infer<typeof packagePurchaseBodySchema>;
export type RedeemPackageSessionBody = z.infer<typeof redeemPackageSessionBodySchema>;
export type VoidPackageBody = z.infer<typeof voidPackageBodySchema>;
export type RescheduleBookingBody = z.infer<typeof rescheduleBookingBodySchema>;
export type CancelBookingBody = z.infer<typeof cancelBookingBodySchema>;
export type WaiveFeeBody = z.infer<typeof waiveFeeBodySchema>;
export type MarkNoShowBody = z.infer<typeof markNoShowBodySchema>;
export type CompleteBookingBody = z.infer<typeof completeBookingBodySchema>;
export type ListBusinessBookingsQuery = z.infer<typeof listBusinessBookingsQuerySchema>;
export type ListCustomerBookingsQuery = z.infer<typeof listCustomerBookingsQuerySchema>;
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;
