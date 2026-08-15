import { z } from "zod";
import type { businessIdParamsSchema } from "../business/business.schema.js";
import { businessCities } from "../business/business.types.js";

export const travelCitySettingSchema = z
  .object({
    city: z.enum(businessCities),
    active: z.boolean(),
    feeCents: z.number().int().min(0),
  })
  .strict();

export const updateBusinessTravelSettingsBodySchema = z
  .object({
    cities: z
      .array(travelCitySettingSchema)
      .max(businessCities.length)
      .superRefine((cities, context) => {
        const seen = new Set<string>();

        for (const [index, setting] of cities.entries()) {
          if (seen.has(setting.city)) {
            context.addIssue({
              code: "custom",
              path: [index, "city"],
              message: "Duplicate city entries are not allowed",
            });
          }

          seen.add(setting.city);
        }
      }),
  })
  .strict();

export type BusinessTravelSettingsParams = z.infer<typeof businessIdParamsSchema>;
export type UpdateBusinessTravelSettingsBody = z.infer<
  typeof updateBusinessTravelSettingsBodySchema
>;
