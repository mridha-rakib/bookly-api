import { z } from "zod";

import {
  businessCities,
  businessVisitTypeAliases,
  businessVisitTypes,
  normalizeBusinessVisitType,
} from "../business/business.types.js";
import { genders, userLanguages } from "../user/user.types.js";

const emailSchema = z.email();
const sessionIdSchema = z.string().min(1);
const otpCodeSchema = z.string().regex(/^\d{4}$/, "OTP must be 4 digits");
const passwordSchema = z.string().min(6);
export const countryCodeSchema = z.string().regex(/^\+\d{1,4}$/);
export const nationalNumberSchema = z.string().regex(/^\d{4,20}$/);
export const visitTypeInputSchema = z
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
    city: z.enum(businessCities),
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

// Batch 17 — Customer Profile self-edit; Phase 1 — also the Super Admin Settings → Admin Account
// name/language edit surface (same PATCH /auth/me route, now gated CUSTOMER + SUPER_ADMIN).
// Deliberately excludes email/phone (email stays read-only for SUPER_ADMIN — no verified
// admin-email-change flow exists yet; Customer email uses the separate OTP endpoints) and
// role/status/internal IDs (never mass-assignable). `address`/`dateOfBirth` are CUSTOMER-only
// sink fields the Super Admin UI never sends. `.strict()` rejects any other field outright.
export const updateMyProfileBodySchema = z
  .object({
    firstName: z.string().trim().min(1).optional(),
    lastName: z.string().trim().min(1).optional(),
    gender: z.enum(genders).optional(),
    defaultLanguage: z.enum(userLanguages).optional(),
    address: z.string().trim().min(1).max(500).optional(),
    dateOfBirth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be in YYYY-MM-DD format")
      .optional(),
    // Optional customer notification channels — 24h appointment-reminder email/SMS and the
    // marketing-email opt-in (Stage M1). Partial nested update: send only the channel(s) being
    // changed. `.strict()` blocks any other nested key (mass-assignment guard); the inner refine
    // rejects an empty object so a no-op request is a 400. `marketingEmail` is accepted and
    // persisted here, but no marketing email is sent anywhere yet (M1 = preference only).
    notifications: z
      .object({
        appointmentReminderEmail: z.boolean().optional(),
        appointmentReminderSms: z.boolean().optional(),
        marketingEmail: z.boolean().optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, {
        message: "notifications must include at least one channel",
      })
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export const changeMyPasswordBodySchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: passwordSchema,
  })
  .strict();

// Batch 18 — Customer email/phone self-service change. Requesting a change re-verifies the
// Customer's current password first (no established precedent existed for this — confirmed via
// AskUserQuestion) before an OTP is ever sent to the NEW contact; the existing verified contact
// stays authoritative until that OTP is confirmed via the separate verify endpoint below.
export const requestEmailChangeBodySchema = z
  .object({
    currentPassword: z.string().min(1),
    newEmail: emailSchema,
  })
  .strict();

export const verifyEmailChangeBodySchema = z
  .object({
    code: otpCodeSchema,
  })
  .strict();

export const requestPhoneChangeBodySchema = z
  .object({
    currentPassword: z.string().min(1),
    countryCode: countryCodeSchema,
    nationalNumber: nationalNumberSchema,
  })
  .strict();

export const verifyPhoneChangeBodySchema = z
  .object({
    code: otpCodeSchema,
  })
  .strict();

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
export type UpdateMyProfileBody = z.infer<typeof updateMyProfileBodySchema>;
export type ChangeMyPasswordBody = z.infer<typeof changeMyPasswordBodySchema>;
export type RequestEmailChangeBody = z.infer<typeof requestEmailChangeBodySchema>;
export type VerifyEmailChangeBody = z.infer<typeof verifyEmailChangeBodySchema>;
export type RequestPhoneChangeBody = z.infer<typeof requestPhoneChangeBodySchema>;
export type VerifyPhoneChangeBody = z.infer<typeof verifyPhoneChangeBodySchema>;
