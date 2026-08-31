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
export type RescheduleBookingBody = z.infer<typeof rescheduleBookingBodySchema>;
export type CancelBookingBody = z.infer<typeof cancelBookingBodySchema>;
export type WaiveFeeBody = z.infer<typeof waiveFeeBodySchema>;
export type MarkNoShowBody = z.infer<typeof markNoShowBodySchema>;
export type CompleteBookingBody = z.infer<typeof completeBookingBodySchema>;
export type ListBusinessBookingsQuery = z.infer<typeof listBusinessBookingsQuerySchema>;
export type ListCustomerBookingsQuery = z.infer<typeof listCustomerBookingsQuerySchema>;
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;
