import { z } from "zod";

import { businessVisitTypes } from "../business/business.types.js";
import { genders } from "../user/user.types.js";

const emailSchema = z.email().transform((value) => value.trim().toLowerCase());
const sessionIdSchema = z.string().min(1);
const otpCodeSchema = z.string().regex(/^\d{4}$/, "OTP must be 4 digits");
const passwordSchema = z.string().min(6);
const countryCodeSchema = z.string().regex(/^\+\d{1,4}$/);
const nationalNumberSchema = z.string().regex(/^\d{4,20}$/);

export const entryBodySchema = z.object({
  email: emailSchema,
});

export const professionalEntryBodySchema = entryBodySchema.extend({
  visitType: z.enum(businessVisitTypes).optional(),
});

export const loginBodySchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});

export const sessionBodySchema = z.object({
  sessionId: sessionIdSchema,
});

export const verifyEmailOtpBodySchema = sessionBodySchema.extend({
  code: otpCodeSchema,
});

export const profileBodySchema = sessionBodySchema.extend({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  gender: z.enum(genders),
  countryCode: countryCodeSchema,
  nationalNumber: nationalNumberSchema.optional(),
  phone: nationalNumberSchema.optional(),
  password: passwordSchema,
  agreeTerms: z.boolean().optional(),
  termsVersion: z.string().trim().min(1).optional(),
  address: z.string().trim().optional(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const verifyPhoneOtpBodySchema = sessionBodySchema.extend({
  code: otpCodeSchema,
});

export const visitTypeBodySchema = sessionBodySchema.extend({
  visitType: z.enum(businessVisitTypes),
});

export const businessDetailsBodySchema = sessionBodySchema.extend({
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
});

export const categorySelectionBodySchema = sessionBodySchema.extend({
  selectedCategory: z.string().trim().min(1),
  selectedSubcategories: z.array(z.string().trim().min(1)).min(1).max(5),
});

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
