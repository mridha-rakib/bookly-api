import { z } from "zod";

import { bookingStatuses } from "./booking.types.js";

/** P4C-1 — Staff read-only appointments. Strict: no staffMembershipId, userId, role or other
 * identity can be supplied; the caller's own membership is derived from the session. */
const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const isoDateTime = z.string().datetime({ offset: true }).or(z.string().datetime());
const DAY_MS = 24 * 60 * 60 * 1000;
export const STAFF_APPOINTMENT_MAX_RANGE_DAYS = 93;
export const STAFF_APPOINTMENT_DEFAULT_RANGE_DAYS = 31;
export const STAFF_APPOINTMENT_MAX_LIMIT = 50;

export const staffAppointmentParamsSchema = z.object({ businessId: objectId }).strict();
export const staffAppointmentDetailParamsSchema = z
  .object({ businessId: objectId, bookingId: objectId })
  .strict();

export const staffAppointmentListQuerySchema = z
  .object({
    page: z.string().regex(/^\d+$/, "Invalid page").optional(),
    limit: z.string().regex(/^\d+$/, "Invalid limit").optional(),
    status: z.string().optional(),
    fromDate: isoDateTime.optional(),
    toDate: isoDateTime.optional(),
  })
  .strict()
  .transform((value, context) => {
    const status = value.status
      ? value.status
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : undefined;
    if (status?.some((entry) => !(bookingStatuses as readonly string[]).includes(entry))) {
      context.addIssue({ code: "custom", path: ["status"], message: "Unknown booking status" });
      return z.NEVER;
    }
    // Default window: from 24h ago (today's earlier appointments stay visible) for 31 days.
    const fromDate = value.fromDate ? new Date(value.fromDate) : new Date(Date.now() - DAY_MS);
    const toDate = value.toDate
      ? new Date(value.toDate)
      : new Date(fromDate.getTime() + STAFF_APPOINTMENT_DEFAULT_RANGE_DAYS * DAY_MS);
    if (
      toDate.getTime() <= fromDate.getTime() ||
      toDate.getTime() - fromDate.getTime() > STAFF_APPOINTMENT_MAX_RANGE_DAYS * DAY_MS
    ) {
      context.addIssue({
        code: "custom",
        path: ["toDate"],
        message: `The date range must be positive and at most ${STAFF_APPOINTMENT_MAX_RANGE_DAYS} days`,
      });
      return z.NEVER;
    }
    return {
      page: value.page ? Math.min(1000, Math.max(1, Number(value.page))) : 1,
      limit: value.limit
        ? Math.min(STAFF_APPOINTMENT_MAX_LIMIT, Math.max(1, Number(value.limit)))
        : 20,
      status: status as (typeof bookingStatuses)[number][] | undefined,
      fromDate,
      toDate,
    };
  });

export type StaffAppointmentListQueryInput = z.infer<typeof staffAppointmentListQuerySchema>;
