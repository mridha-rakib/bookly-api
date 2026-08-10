import { z } from "zod";

import {
  countryCodeSchema,
  nationalNumberSchema,
  visitTypeInputSchema,
} from "../auth/auth.schema.js";
import { businessCities } from "./business.types.js";

export const businessIdParamsSchema = z
  .object({
    businessId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid business id"),
  })
  .strict();

export const verificationIdParamsSchema = z
  .object({
    verificationId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid verification id"),
  })
  .strict();

export const requestLinkVerificationBodySchema = z.object({ email: z.email() }).strict();

export const verifyLinkVerificationBodySchema = z
  .object({ code: z.string().regex(/^\d{4}$/, "OTP must be 4 digits") })
  .strict();

export const updateBusinessBodySchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    ownerName: z.string().trim().min(1).optional(),
    countryCode: countryCodeSchema.optional(),
    nationalNumber: nationalNumberSchema.optional(),
    visitType: visitTypeInputSchema.optional(),
    city: z.enum(businessCities).optional(),
    area: z.string().trim().min(1).optional(),
    streetName: z.string().trim().min(1).optional(),
    streetNumber: z.string().trim().min(1).optional(),
    floorUnit: z.string().trim().optional(),
    aptRoom: z.string().trim().optional(),
    briefDescription: z.string().trim().min(1).optional(),
    category: z.string().trim().min(1).optional(),
    subcategories: z.array(z.string().trim().min(1)).min(1).max(5).optional(),
    coordinates: z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
      })
      .optional(),
    searchQuery: z.string().trim().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value).length === 0) {
      context.addIssue({ code: "custom", message: "At least one field must be provided" });
    }

    if (Boolean(value.countryCode) !== Boolean(value.nationalNumber)) {
      context.addIssue({
        code: "custom",
        path: ["nationalNumber"],
        message: "countryCode and nationalNumber must be provided together",
      });
    }
  });

export type BusinessIdParams = z.infer<typeof businessIdParamsSchema>;
export type VerificationIdParams = z.infer<typeof verificationIdParamsSchema>;
export type RequestLinkVerificationBody = z.infer<typeof requestLinkVerificationBodySchema>;
export type VerifyLinkVerificationBody = z.infer<typeof verifyLinkVerificationBodySchema>;
export type UpdateBusinessBody = z.infer<typeof updateBusinessBodySchema>;
