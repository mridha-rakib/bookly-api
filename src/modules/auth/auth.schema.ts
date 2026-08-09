import { z } from "zod";

import {
  businessVisitTypeAliases,
  businessVisitTypes,
  normalizeBusinessVisitType,
} from "../business/business.types.js";
import { genders } from "../user/user.types.js";

const emailSchema = z.email();
const sessionIdSchema = z.string().min(1);
const otpCodeSchema = z.string().regex(/^\d{4}$/, "OTP must be 4 digits");
const passwordSchema = z.string().min(6);
const countryCodeSchema = z.string().regex(/^\+\d{1,4}$/);
const nationalNumberSchema = z.string().regex(/^\d{4,20}$/);
const visitTypeInputSchema = z
  .enum([...businessVisitTypes, ...businessVisitTypeAliases])
  .transform(normalizeBusinessVisitType);

export const entryBodySchema = z.object({ email: emailSchema }).strict();

export const professionalEntryBodySchema = entryBodySchema
  .extend({
    visitType: visitTypeInputSchema.optional(),
  })
  .strict();

export const loginBodySchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1),
  })
  .strict();

export const sessionBodySchema = z
  .object({
    sessionId: sessionIdSchema,
  })
  .strict();

export const verifyEmailOtpBodySchema = sessionBodySchema.extend({
  code: otpCodeSchema,
});

export const profileBodySchema = sessionBodySchema
  .extend({
    firstName: z.string().trim().min(1),
    lastName: z.string().trim().min(1),
    gender: z.enum(genders),
    countryCode: countryCodeSchema,
    nationalNumber: nationalNumberSchema.optional(),
    phone: nationalNumberSchema.optional(),
    password: passwordSchema,
    agreeTerms: z.boolean().optional(),
    termsVersion: z.string().trim().min(1).optional(),
  })
  .strict();

export const verifyPhoneOtpBodySchema = sessionBodySchema.extend({
  code: otpCodeSchema,
});

export const visitTypeBodySchema = sessionBodySchema
  .extend({
    visitType: visitTypeInputSchema,
  })
  .strict();

export const businessDetailsBodySchema = sessionBodySchema
  .extend({
    businessName: z.string().trim().min(1),
    ownerName: z.string().trim().min(1),
    city: z.enum(["Larnaca", "Limassol", "Nicosia", "Paphos"]),
    countryCode: countryCodeSchema,
    nationalNumber: nationalNumberSchema.optional(),
    mobileNumber: nationalNumberSchema.optional(),
    area: z.string().trim().min(1),
    streetName: z.string().trim().min(1),
    streetNumber: z.string().trim().min(1),
    floorUnit: z.string().trim().optional(),
    aptRoom: z.string().trim().optional(),
    briefDesc: z.string().trim().min(1),
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
    if (!value.nationalNumber && !value.mobileNumber) {
      context.addIssue({
        code: "custom",
        path: ["mobileNumber"],
        message: "Business phone number is required",
      });
    }
  });

export const categorySelectionBodySchema = sessionBodySchema
  .extend({
    selectedCategory: z.string().trim().min(1),
    selectedSubcategories: z.array(z.string().trim().min(1)).min(1).max(5),
  })
  .strict();

export const progressQuerySchema = z.object({
  sessionId: sessionIdSchema,
});

export const authResponseSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.string().datetime(),
  user: z.object({
    id: z.string(),
    email: z.string(),
    role: z.string(),
    status: z.string(),
  }),
});

export type EntryBody = z.infer<typeof entryBodySchema>;
export type ProfessionalEntryBody = z.infer<typeof professionalEntryBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type SessionBody = z.infer<typeof sessionBodySchema>;
export type VerifyEmailOtpBody = z.infer<typeof verifyEmailOtpBodySchema>;
export type ProfileBody = z.infer<typeof profileBodySchema>;
export type VerifyPhoneOtpBody = z.infer<typeof verifyPhoneOtpBodySchema>;
export type VisitTypeBody = z.infer<typeof visitTypeBodySchema>;
export type BusinessDetailsBody = z.infer<typeof businessDetailsBodySchema>;
export type CategorySelectionBody = z.infer<typeof categorySelectionBodySchema>;
