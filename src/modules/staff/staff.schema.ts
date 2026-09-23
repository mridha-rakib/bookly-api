import { z } from "zod";
import { staffCreatableRoles } from "./staff.types.js";
import { daysOfWeek } from "./staff-schedule.types.js";
import { intervalsOverlap, isValidCanonicalTime } from "./staff-schedule.utils.js";
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

export const staffInvitationParamsSchema = z
  .object({
    businessId: objectIdSchema,
    invitationId: objectIdSchema,
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

const scheduleIntervalSchema = z
  .object({
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

// A day may be submitted with zero intervals ("no hours configured") up to a generous cap —
// there is no meaningful product limit on split-shift count, but an unbounded array is still
// rejected as a defensive input-size guard.
const scheduleDaySchema = z
  .object({
    dayOfWeek: z.enum(daysOfWeek),
    intervals: z.array(scheduleIntervalSchema).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    // Sort a local copy purely to detect overlaps in the raw client input — this is NOT the
    // authoritative normalization (that happens server-side in staff.service.ts via
    // normalizeScheduleIntervals); it only decides whether to reject here.
    const sorted = [...value.intervals].sort((a, b) => (a.startTime < b.startTime ? -1 : 1));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const first = sorted[i];
        const second = sorted[j];
        if (!first || !second) {
          continue;
        }
        if (intervalsOverlap(first, second)) {
          context.addIssue({
            code: "custom",
            path: ["intervals"],
            message: `Overlapping intervals for ${value.dayOfWeek}: ${first.startTime}-${first.endTime} and ${second.startTime}-${second.endTime}`,
          });
        }
      }
    }
  });

export const putStaffScheduleBodySchema = z
  .object({
    // At most one entry per weekday (each entry may carry multiple intervals — enforced
    // further by the service, which also dedupes) — 7 is the maximum meaningful length since
    // there are 7 days in a week.
    days: z.array(scheduleDaySchema).max(7),
    // Explicit recurring weekly Weekend/Off days — distinct from a weekday simply not yet
    // configured. Defaults to [] so every existing caller (every current test included) that
    // only sends `days` keeps behaving exactly as before this field existed.
    offDays: z.array(z.enum(daysOfWeek)).max(7).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const seenEntries = new Set<string>();
    // Only days with at least one actual working interval conflict with `offDays` — an entry
    // with an empty `intervals[]` just means "no hours configured yet" (rule 6: never
    // implicitly Off), so it must NOT block that same weekday from also being listed as an
    // explicit Weekend/Off day.
    const seenWorking = new Set<string>();

    for (const [index, day] of value.days.entries()) {
      if (seenEntries.has(day.dayOfWeek)) {
        context.addIssue({
          code: "custom",
          path: ["days", index, "dayOfWeek"],
          message: `Duplicate schedule entry for ${day.dayOfWeek} — only one entry per weekday is allowed (use multiple intervals within it for split shifts)`,
        });
      }
      seenEntries.add(day.dayOfWeek);

      if (day.intervals.length > 0) {
        seenWorking.add(day.dayOfWeek);
      }
    }

    const seenOff = new Set<string>();

    for (const [index, dayOfWeek] of value.offDays.entries()) {
      if (seenOff.has(dayOfWeek)) {
        context.addIssue({
          code: "custom",
          path: ["offDays", index],
          message: `Duplicate Weekend/Off entry for ${dayOfWeek}`,
        });
      }
      seenOff.add(dayOfWeek);

      // A weekday cannot be WORKING and OFF at the same time — a working shift always takes
      // precedence conceptually, but this is rejected outright rather than silently resolved,
      // so a caller never gets a different result than what it explicitly asked for.
      if (seenWorking.has(dayOfWeek)) {
        context.addIssue({
          code: "custom",
          path: ["offDays", index],
          message: `${dayOfWeek} cannot be both a working day and Weekend/Off`,
        });
      }
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
export type StaffInvitationParams = z.infer<typeof staffInvitationParamsSchema>;
export type CreateStaffBody = z.infer<typeof createStaffBodySchema>;
export type UpdateStaffBody = z.infer<typeof updateStaffBodySchema>;
export type PutStaffScheduleBody = z.infer<typeof putStaffScheduleBodySchema>;
export type CreateStaffTimeOffBody = z.infer<typeof createStaffTimeOffBodySchema>;
