import { z } from "zod";
import { staffCreatableRoles } from "./staff.types.js";
import { daysOfWeek } from "./staff-schedule.types.js";
import { isValidCanonicalTime } from "./staff-schedule.utils.js";
import { staffTimeOffTypes } from "./staff-time-off.types.js";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const staffBusinessParamsSchema = z
  .object({
    businessId: objectIdSchema,
  })
  .strict();

export const staffIdParamsSchema = z
  .object({
    businessId: objectIdSchema,
    staffId: objectIdSchema,
  })
  .strict();

export const staffTimeOffParamsSchema = z
  .object({
    businessId: objectIdSchema,
    staffId: objectIdSchema,
    timeOffId: objectIdSchema,
  })
  .strict();

// Strict role allowlist — BUSINESS_OWNER/SUPER_ADMIN/CUSTOMER are not valid values here at
// all, so a client sending role=BUSINESS_OWNER (or any other role) fails schema validation
// before it ever reaches the service/repository layer.
const staffRoleSchema = z.enum(staffCreatableRoles);

export const createStaffBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.email(),
    role: staffRoleSchema,
    phone: z.string().trim().max(30).optional(),
  })
  .strict();

export const updateStaffBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.email().optional(),
    role: staffRoleSchema.optional(),
    phone: z.string().trim().max(30).optional(),
    employmentActive: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value).length === 0) {
      context.addIssue({ code: "custom", message: "At least one field must be provided" });
    }
  });

// --- Schedule ---------------------------------------------------------------------------

const canonicalTimeSchema = z
  .string()
  .refine(isValidCanonicalTime, "Time must be a valid 24-hour HH:mm value");

const scheduleDaySchema = z
  .object({
    dayOfWeek: z.enum(daysOfWeek),
    startTime: canonicalTimeSchema,
    endTime: canonicalTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.startTime >= value.endTime) {
      context.addIssue({
        code: "custom",
        path: ["endTime"],
        message: "End time must be after start time",
      });
    }
  });

export const putStaffScheduleBodySchema = z
  .object({
    // At most one entry per day (enforced further by the service, which also dedupes) —
    // 7 is the maximum meaningful length since there are 7 days in a week.
    days: z.array(scheduleDaySchema).max(7),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();

    for (const [index, day] of value.days.entries()) {
      if (seen.has(day.dayOfWeek)) {
        context.addIssue({
          code: "custom",
          path: ["days", index, "dayOfWeek"],
          message: `Duplicate schedule entry for ${day.dayOfWeek} — only one shift per day is allowed`,
        });
      }
      seen.add(day.dayOfWeek);
    }
  });

// --- Time off ---------------------------------------------------------------------------

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
  .refine((value) => !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime()), {
    message: "Invalid calendar date",
  });

export const createStaffTimeOffBodySchema = z
  .object({
    type: z.enum(staffTimeOffTypes),
    startDate: isoDateSchema,
    // Omit for a single-day entry — the service defaults endDate to startDate.
    endDate: isoDateSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endDate && value.endDate < value.startDate) {
      context.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "End date must be on or after the start date",
      });
    }
  });

export type StaffBusinessParams = z.infer<typeof staffBusinessParamsSchema>;
export type StaffIdParams = z.infer<typeof staffIdParamsSchema>;
export type StaffTimeOffParams = z.infer<typeof staffTimeOffParamsSchema>;
export type CreateStaffBody = z.infer<typeof createStaffBodySchema>;
export type UpdateStaffBody = z.infer<typeof updateStaffBodySchema>;
export type PutStaffScheduleBody = z.infer<typeof putStaffScheduleBodySchema>;
export type CreateStaffTimeOffBody = z.infer<typeof createStaffTimeOffBodySchema>;
