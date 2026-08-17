import { z } from "zod";

import { businessCities } from "../business/business.types.js";
import { daysOfWeek } from "../staff/staff-schedule.types.js";
import { isValidCanonicalTime } from "../staff/staff-schedule.utils.js";
import { editableServiceStatuses, servicePricingModes } from "./service.types.js";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const serviceBusinessParamsSchema = z.object({ businessId: objectIdSchema }).strict();

export const serviceIdParamsSchema = z
  .object({ businessId: objectIdSchema, serviceId: objectIdSchema })
  .strict();

export const serviceCategoryIdParamsSchema = z
  .object({ businessId: objectIdSchema, categoryId: objectIdSchema })
  .strict();

export const listServicesQuerySchema = z
  .object({
    status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]).optional(),
    archived: z.enum(["true", "false"]).optional(),
  })
  .strict()
  .transform((value) => ({
    status: value.status,
    archived: value.archived === "true",
  }));

export const listServiceCategoriesQuerySchema = z
  .object({ includeInactive: z.enum(["true", "false"]).optional() })
  .strict()
  .transform((value) => ({ includeInactive: value.includeInactive === "true" }));

// --- Service Category ---------------------------------------------------------------------

export const createServiceCategoryBodySchema = z
  .object({ name: z.string().trim().min(1).max(60) })
  .strict();

export const updateServiceCategoryBodySchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value).length === 0) {
      context.addIssue({ code: "custom", message: "At least one field must be provided" });
    }
  });

// --- Service pricing blocks --------------------------------------------------------------

const centsSchema = z.number().int().min(0);
const discountPercentSchema = z.number().min(0).max(100);
const positiveIntSchema = z.number().int().min(1);
const nonNegIntSchema = z.number().int().min(0);

const fixedPricingSchema = z
  .object({
    priceCents: centsSchema,
    durationMin: positiveIntSchema,
    bookingIntervalMin: positiveIntSchema.optional(),
    bufferAfterMin: nonNegIntSchema.optional(),
    processingTimeMin: nonNegIntSchema.optional(),
    discountPercent: discountPercentSchema.optional(),
  })
  .strict();

const hourlyPricingSchema = z
  .object({
    ratePerHourCents: centsSchema,
    minHours: positiveIntSchema,
    maxHours: positiveIntSchema,
    bufferAfterMin: nonNegIntSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.maxHours < value.minHours) {
      context.addIssue({
        code: "custom",
        path: ["maxHours"],
        message: "Max hours must be greater than or equal to min hours",
      });
    }
  });

const perPersonPricingSchema = z
  .object({
    ratePerPersonCents: centsSchema,
    minPersons: positiveIntSchema,
    maxPersons: positiveIntSchema,
    durationMin: positiveIntSchema,
    bookingIntervalMin: positiveIntSchema.optional(),
    bufferAfterMin: nonNegIntSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.maxPersons < value.minPersons) {
      context.addIssue({
        code: "custom",
        path: ["maxPersons"],
        message: "Max persons must be greater than or equal to min persons",
      });
    }
  });

const packagePricingSchema = z
  .object({
    durationMin: positiveIntSchema,
    bookingIntervalMin: positiveIntSchema.optional(),
    bufferAfterMin: nonNegIntSchema.optional(),
    processingTimeMin: nonNegIntSchema.optional(),
    sessionsInPackage: positiveIntSchema,
    bundlePriceCents: centsSchema,
    discountPercent: discountPercentSchema.optional(),
  })
  .strict();

// --- Manual schedule -----------------------------------------------------------------------

const canonicalTimeSchema = z
  .string()
  .refine(isValidCanonicalTime, "Time must be a valid 24-hour HH:mm value");

const manualScheduleDaySchema = z
  .object({
    dayOfWeek: z.enum(daysOfWeek),
    isOpen: z.boolean(),
    times: z.array(canonicalTimeSchema).max(24),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.times).size !== value.times.length) {
      context.addIssue({
        code: "custom",
        path: ["times"],
        message: "Duplicate time entries are not allowed",
      });
    }
  });

const manualScheduleSchema = z
  .array(manualScheduleDaySchema)
  .max(7)
  .superRefine((days, context) => {
    const seen = new Set<string>();
    for (const [index, day] of days.entries()) {
      if (seen.has(day.dayOfWeek)) {
        context.addIssue({
          code: "custom",
          path: [index, "dayOfWeek"],
          message: `Duplicate schedule entry for ${day.dayOfWeek}`,
        });
      }
      seen.add(day.dayOfWeek);
    }
  });

// --- Service (create/update share one full-object shape; PATCH replaces the whole
// pricing/schedule configuration rather than merging partial fields — see
// service.repository.ts replaceById) ----------------------------------------------------
//
// Validation is status-aware: DRAFT tolerates incomplete data (only `name` + `status` are
// unconditionally required — a Business Owner may save a Service before picking a category,
// pricing mode, schedule, staff, or travel cities), while ACTIVE/INACTIVE must satisfy every
// field the catalogue relies on, enforced below by the superRefine block. This is why
// serviceCategoryId/subcategory/sessionExpiryAlert are `.optional()` at the object level —
// their presence is required conditionally, not structurally.

const baseServiceBodySchema = z.object({
  status: z.enum(editableServiceStatuses),
  isFeatured: z.boolean(),
  isPackageDeal: z.boolean(),

  serviceCategoryId: objectIdSchema.optional(),
  subcategory: z.string().trim().min(1).optional(),

  name: z.string().trim().min(1).max(200),
  packageServicesName: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),

  pricingMode: z.enum(servicePricingModes).optional(),
  fixedPricing: fixedPricingSchema.optional(),
  hourlyPricing: hourlyPricingSchema.optional(),
  perPersonPricing: perPersonPricingSchema.optional(),
  packagePricing: packagePricingSchema.optional(),

  sessionExpiryAlert: z
    .object({
      enabled: z.boolean(),
      minutesBeforeSessionEnds: positiveIntSchema.optional(),
    })
    .strict()
    .optional(),

  scheduleMode: z.enum(["AUTO", "MANUAL"]),
  manualSchedule: manualScheduleSchema.optional(),

  servedCities: z.array(z.enum(businessCities)).max(businessCities.length),

  assignedStaffMembershipIds: z.array(objectIdSchema).max(200),
});

const strictServiceBodySchema = baseServiceBodySchema.strict();

const serviceBodySchema = strictServiceBodySchema.superRefine((body, context) => {
  // DRAFT allows incomplete data — skip every cross-field "required for publish" rule below.
  // Whatever IS provided still had to pass the per-field shape checks above (e.g. a supplied
  // serviceCategoryId must still look like an id, a supplied fixedPricing block must still be
  // shaped correctly) — only *presence* is relaxed for DRAFT, not the shape of present fields.
  if (body.status === "DRAFT") {
    return;
  }

  if (body.serviceCategoryId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["serviceCategoryId"],
      message: "Required unless the Service is saved as a draft",
    });
  }
  if (body.subcategory === undefined) {
    context.addIssue({
      code: "custom",
      path: ["subcategory"],
      message: "Required unless the Service is saved as a draft",
    });
  }
  if (body.sessionExpiryAlert === undefined) {
    context.addIssue({
      code: "custom",
      path: ["sessionExpiryAlert"],
      message: "Required unless the Service is saved as a draft",
    });
  }

  if (body.isPackageDeal) {
    if (body.pricingMode !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["pricingMode"],
        message: "Not applicable when isPackageDeal is true",
      });
    }
    if (body.fixedPricing !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["fixedPricing"],
        message: "Not applicable when isPackageDeal is true",
      });
    }
    if (body.hourlyPricing !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["hourlyPricing"],
        message: "Not applicable when isPackageDeal is true",
      });
    }
    if (body.perPersonPricing !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["perPersonPricing"],
        message: "Not applicable when isPackageDeal is true",
      });
    }
    if (body.packagePricing === undefined) {
      context.addIssue({
        code: "custom",
        path: ["packagePricing"],
        message: "Required when isPackageDeal is true",
      });
    }
    if (!body.packageServicesName) {
      context.addIssue({
        code: "custom",
        path: ["packageServicesName"],
        message: "Required when isPackageDeal is true",
      });
    }
  } else {
    if (body.packagePricing !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["packagePricing"],
        message: "Only applicable when isPackageDeal is true",
      });
    }
    if (body.packageServicesName !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["packageServicesName"],
        message: "Only applicable when isPackageDeal is true",
      });
    }

    if (body.pricingMode === undefined) {
      context.addIssue({
        code: "custom",
        path: ["pricingMode"],
        message: "Required when isPackageDeal is false",
      });
    } else {
      const modeToField = {
        FIXED: "fixedPricing",
        HOURLY: "hourlyPricing",
        PER_PERSON: "perPersonPricing",
      } as const;

      for (const [mode, field] of Object.entries(modeToField) as Array<
        [keyof typeof modeToField, "fixedPricing" | "hourlyPricing" | "perPersonPricing"]
      >) {
        const isSelectedMode = mode === body.pricingMode;
        const value2 = body[field];

        if (isSelectedMode && value2 === undefined) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: `Required when pricingMode is ${mode}`,
          });
        }
        if (!isSelectedMode && value2 !== undefined) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: `Not applicable when pricingMode is ${body.pricingMode}`,
          });
        }
      }
    }
  }

  if (body.sessionExpiryAlert !== undefined) {
    if (
      body.sessionExpiryAlert.enabled &&
      body.sessionExpiryAlert.minutesBeforeSessionEnds === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["sessionExpiryAlert", "minutesBeforeSessionEnds"],
        message: "Required when session expiry alerts are enabled",
      });
    }
    if (
      !body.sessionExpiryAlert.enabled &&
      body.sessionExpiryAlert.minutesBeforeSessionEnds !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["sessionExpiryAlert", "minutesBeforeSessionEnds"],
        message: "Not applicable when session expiry alerts are disabled",
      });
    }
  }

  if (body.scheduleMode === "MANUAL") {
    if (!body.manualSchedule || body.manualSchedule.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["manualSchedule"],
        message: "Required when scheduleMode is MANUAL",
      });
    } else {
      for (const [index, day] of body.manualSchedule.entries()) {
        if (day.isOpen && day.times.length === 0) {
          context.addIssue({
            code: "custom",
            path: ["manualSchedule", index, "times"],
            message: `At least one time is required for an open day (${day.dayOfWeek})`,
          });
        }
      }
    }
  } else if (body.manualSchedule !== undefined && body.manualSchedule.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["manualSchedule"],
      message: "Not applicable when scheduleMode is AUTO",
    });
  }
});

// Create and update share one full-object shape — PATCH is full-replace semantics for the
// pricing/schedule configuration (see service.repository.ts replaceById), not a partial merge.
export const createServiceBodySchema = serviceBodySchema;
export const updateServiceBodySchema = serviceBodySchema;

export const updateServiceStatusBodySchema = z
  .object({ status: z.enum(["ACTIVE", "INACTIVE"]) })
  .strict();

export const restoreServiceBodySchema = z
  .object({ status: z.enum(["ACTIVE", "INACTIVE"]) })
  .strict();

export type ServiceBusinessParams = z.infer<typeof serviceBusinessParamsSchema>;
export type ServiceIdParams = z.infer<typeof serviceIdParamsSchema>;
export type ServiceCategoryIdParams = z.infer<typeof serviceCategoryIdParamsSchema>;
export type ListServicesQuery = z.infer<typeof listServicesQuerySchema>;
export type ListServiceCategoriesQuery = z.infer<typeof listServiceCategoriesQuerySchema>;
export type CreateServiceCategoryBody = z.infer<typeof createServiceCategoryBodySchema>;
export type UpdateServiceCategoryBody = z.infer<typeof updateServiceCategoryBodySchema>;
export type CreateServiceBody = z.infer<typeof baseServiceBodySchema>;
export type UpdateServiceBody = z.infer<typeof baseServiceBodySchema>;
export type UpdateServiceStatusBody = z.infer<typeof updateServiceStatusBodySchema>;
export type RestoreServiceBody = z.infer<typeof restoreServiceBodySchema>;
