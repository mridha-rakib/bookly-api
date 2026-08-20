import { z } from "zod";

import { businessIdParamsSchema } from "../business/business.schema.js";
import { daysOfWeek } from "../staff/staff-schedule.types.js";
import { isValidCanonicalTime } from "../staff/staff-schedule.utils.js";

export { businessIdParamsSchema as businessHoursParamsSchema };

const canonicalTimeSchema = z
  .string()
  .refine(isValidCanonicalTime, "Time must be a valid 24-hour HH:mm value");

const openingHoursSlotSchema = z
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

const openingHoursDaySchema = z
  .object({
    dayOfWeek: z.enum(daysOfWeek),
    isOpen: z.boolean(),
    // A handful of slots per day is plenty (e.g. morning/afternoon/evening splits) — bounded
    // to keep the payload sane, matching the spirit of Service.manualSchedule's per-day cap.
    slots: z.array(openingHoursSlotSchema).max(8),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.isOpen && value.slots.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["slots"],
        message: "At least one time slot is required for an open day",
      });
    }

    if (!value.isOpen && value.slots.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["slots"],
        message: "A closed day must not have time slots",
      });
    }

    const sorted = [...value.slots].sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (previous && current && current.startTime < previous.endTime) {
        context.addIssue({
          code: "custom",
          path: ["slots"],
          message: "Time slots for the same day must not overlap",
        });
        break;
      }
    }
  });

export const putBusinessHoursBodySchema = z
  .object({
    // At most one entry per day (enforced further by the service, which also dedupes) — 7 is
    // the maximum meaningful length since there are 7 days in a week. A day omitted here is
    // implicitly closed, same as an explicit { isOpen: false, slots: [] } entry.
    days: z.array(openingHoursDaySchema).max(7),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();

    for (const [index, day] of value.days.entries()) {
      if (seen.has(day.dayOfWeek)) {
        context.addIssue({
          code: "custom",
          path: ["days", index, "dayOfWeek"],
          message: `Duplicate opening-hours entry for ${day.dayOfWeek} — only one entry per day is allowed`,
        });
      }
      seen.add(day.dayOfWeek);
    }
  });

export type BusinessHoursParams = z.infer<typeof businessIdParamsSchema>;
export type PutBusinessHoursBody = z.infer<typeof putBusinessHoursBodySchema>;
