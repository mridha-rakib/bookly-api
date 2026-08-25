import { z } from "zod";

import { bookingStatuses } from "../booking/booking.types.js";
import { businessStatuses, businessVisitTypes } from "../business/business.types.js";
import { userStatuses } from "../user/user.types.js";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const isoDateTimeSchema = z.string().datetime({ offset: true }).or(z.string().datetime());

const paginationQuerySchema = z.object({
  page: z.string().regex(/^\d+$/, "Invalid page").optional(),
  limit: z.string().regex(/^\d+$/, "Invalid limit").optional(),
});

// --- Businesses ------------------------------------------------------------------------------

export const superAdminBusinessIdParamsSchema = z.object({ businessId: objectIdSchema }).strict();

export const superAdminListBusinessesQuerySchema = paginationQuerySchema
  .extend({
    status: z.enum(businessStatuses).optional(),
    visitType: z.enum(businessVisitTypes).optional(),
    city: z.string().trim().max(100).optional(),
    category: z.string().trim().max(100).optional(),
    q: z.string().trim().max(200).optional(),
  })
  .strict()
  .transform((value) => ({
    status: value.status,
    visitType: value.visitType,
    city: value.city,
    category: value.category,
    q: value.q,
    page: value.page ? Math.max(1, Number(value.page)) : 1,
    limit: value.limit ? Math.min(100, Math.max(1, Number(value.limit))) : 20,
  }));

export const superAdminRejectBusinessBodySchema = z
  .object({ reason: z.string().trim().max(2000).optional() })
  .strict();

export const superAdminSuspendBusinessBodySchema = z
  .object({ reason: z.string().trim().max(2000).optional() })
  .strict();

// --- Global Bookings ---------------------------------------------------------------------------

export const superAdminBookingIdParamsSchema = z.object({ bookingId: objectIdSchema }).strict();

export const superAdminListBookingsQuerySchema = paginationQuerySchema
  .extend({
    businessId: objectIdSchema.optional(),
    status: z
      .string()
      .transform((value) => value.split(","))
      .pipe(z.array(z.enum(bookingStatuses)))
      .optional(),
    q: z.string().trim().max(200).optional(),
    fromDate: isoDateTimeSchema.optional(),
    toDate: isoDateTimeSchema.optional(),
  })
  .strict()
  .transform((value) => ({
    businessId: value.businessId,
    status: value.status,
    q: value.q,
    fromDate: value.fromDate ? new Date(value.fromDate) : undefined,
    toDate: value.toDate ? new Date(value.toDate) : undefined,
    page: value.page ? Math.max(1, Number(value.page)) : 1,
    limit: value.limit ? Math.min(100, Math.max(1, Number(value.limit))) : 20,
  }));

// --- Global Customers ----------------------------------------------------------------------

export const superAdminUserIdParamsSchema = z.object({ userId: objectIdSchema }).strict();

export const superAdminListCustomersQuerySchema = paginationQuerySchema
  .extend({
    status: z.enum(userStatuses).optional(),
    q: z.string().trim().max(200).optional(),
  })
  .strict()
  .transform((value) => ({
    status: value.status,
    q: value.q,
    page: value.page ? Math.max(1, Number(value.page)) : 1,
    limit: value.limit ? Math.min(100, Math.max(1, Number(value.limit))) : 20,
  }));

// --- Analytics --------------------------------------------------------------------------------

/** Batch 12 — every period-bounded Analytics endpoint accepts the same optional `fromDate`/
 * `toDate`. When both are omitted, the SERVICE layer (not this schema) defaults to a rolling
 * 365-day window ending now — the same "no real selectable value yet, default to a sane bounded
 * window" precedent BusinessFinanceTab.tsx's own last-90-days default already established; never
 * a fabricated data value, only a query boundary. `toDate` must be strictly after `fromDate`. */
const analyticsPeriodShape = {
  fromDate: isoDateTimeSchema.optional(),
  toDate: isoDateTimeSchema.optional(),
};

const validatePeriodShape = (value: {
  fromDate?: string | undefined;
  toDate?: string | undefined;
}) => Boolean(value.fromDate) === Boolean(value.toDate);

const periodMessage = { message: "fromDate and toDate must be provided together" };

export const superAdminAnalyticsPeriodQuerySchema = z
  .object(analyticsPeriodShape)
  .strict()
  .refine(validatePeriodShape, periodMessage)
  .transform((value) => ({
    fromDate: value.fromDate ? new Date(value.fromDate) : undefined,
    toDate: value.toDate ? new Date(value.toDate) : undefined,
  }))
  .refine((value) => !(value.fromDate && value.toDate && value.fromDate >= value.toDate), {
    message: "fromDate must be before toDate",
  });

export const superAdminTopServicesQuerySchema = z
  .object({ ...analyticsPeriodShape, limit: z.string().regex(/^\d+$/, "Invalid limit").optional() })
  .strict()
  .refine(validatePeriodShape, periodMessage)
  .transform((value) => ({
    fromDate: value.fromDate ? new Date(value.fromDate) : undefined,
    toDate: value.toDate ? new Date(value.toDate) : undefined,
    limit: value.limit ? Math.min(50, Math.max(1, Number(value.limit))) : 10,
  }))
  .refine((value) => !(value.fromDate && value.toDate && value.fromDate >= value.toDate), {
    message: "fromDate must be before toDate",
  });

export const superAdminRecentActivityQuerySchema = z
  .object({ limit: z.string().regex(/^\d+$/, "Invalid limit").optional() })
  .strict()
  .transform((value) => ({
    limit: value.limit ? Math.min(50, Math.max(1, Number(value.limit))) : 20,
  }));

export type SuperAdminBusinessIdParams = z.infer<typeof superAdminBusinessIdParamsSchema>;
export type SuperAdminListBusinessesQuery = z.infer<typeof superAdminListBusinessesQuerySchema>;
export type SuperAdminRejectBusinessBody = z.infer<typeof superAdminRejectBusinessBodySchema>;
export type SuperAdminSuspendBusinessBody = z.infer<typeof superAdminSuspendBusinessBodySchema>;
export type SuperAdminBookingIdParams = z.infer<typeof superAdminBookingIdParamsSchema>;
export type SuperAdminListBookingsQuery = z.infer<typeof superAdminListBookingsQuerySchema>;
export type SuperAdminUserIdParams = z.infer<typeof superAdminUserIdParamsSchema>;
export type SuperAdminListCustomersQuery = z.infer<typeof superAdminListCustomersQuerySchema>;
export type SuperAdminAnalyticsPeriodQuery = z.infer<typeof superAdminAnalyticsPeriodQuerySchema>;
export type SuperAdminTopServicesQuery = z.infer<typeof superAdminTopServicesQuerySchema>;
export type SuperAdminRecentActivityQuery = z.infer<typeof superAdminRecentActivityQuerySchema>;
