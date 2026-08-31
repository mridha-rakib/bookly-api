import { z } from "zod";

import { businessCategoryKeys } from "./business-category.js";
import {
  MIN_MAX_SERVICES_PER_BOOKING,
  STRUCTURAL_MAX_SERVICES_PER_BOOKING,
} from "./platform-settings.constants.js";

const noShowCategoryWindowSchema = z
  .object({
    categoryKey: z.enum(businessCategoryKeys),
    opensAfterMinutes: z.number().int().min(0),
    closesAfterMinutes: z.number().int().min(0),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.opensAfterMinutes >= value.closesAfterMinutes) {
      context.addIssue({
        code: "custom",
        path: ["closesAfterMinutes"],
        message: "opensAfterMinutes must be strictly less than closesAfterMinutes",
      });
    }
  });

/**
 * PATCH body. Both fields optional, but at least one required. When `noShowCategoryWindows` is
 * present it is a REPLACE-ALL of the full 8-category set (mirrors the cancellation-policy
 * "always all tiers together" convention) — exactly one entry per canonical key, no
 * duplicates, no unknown keys.
 */
export const updatePlatformSettingsBodySchema = z
  .object({
    maxServicesPerBooking: z
      .number()
      .int()
      .min(MIN_MAX_SERVICES_PER_BOOKING)
      .max(STRUCTURAL_MAX_SERVICES_PER_BOOKING)
      .optional(),
    noShowCategoryWindows: z
      .array(noShowCategoryWindowSchema)
      .length(businessCategoryKeys.length)
      .optional()
      .superRefine((windows, context) => {
        if (!windows) {
          return;
        }
        const seen = new Set<string>();
        for (const [index, window] of windows.entries()) {
          if (seen.has(window.categoryKey)) {
            context.addIssue({
              code: "custom",
              path: [index, "categoryKey"],
              message: `Duplicate window for ${window.categoryKey}`,
            });
          }
          seen.add(window.categoryKey);
        }
        const missing = businessCategoryKeys.filter((key) => !seen.has(key));
        if (missing.length > 0) {
          context.addIssue({
            code: "custom",
            path: [],
            message: `Missing windows for: ${missing.join(", ")}`,
          });
        }
      }),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.maxServicesPerBooking === undefined && value.noShowCategoryWindows === undefined) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "Provide at least one field to update",
      });
    }
  });

export type UpdatePlatformSettingsBody = z.infer<typeof updatePlatformSettingsBodySchema>;
