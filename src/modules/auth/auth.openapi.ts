import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import { businessVisitTypeAliases, businessVisitTypes } from "../business/business.types.js";

const emailSchema = z.string().email();
const sessionIdSchema = z.string().min(1);
const otpCodeSchema = z.string().regex(/^\d{4}$/);
const countryCodeSchema = z.string().regex(/^\+\d{1,4}$/);
const nationalNumberSchema = z.string().regex(/^\d{4,20}$/);
const visitTypeOpenApiSchema = z.enum([...businessVisitTypes, ...businessVisitTypeAliases]);

const entryOpenApiSchema = z.object({ email: emailSchema }).strict();
const professionalEntryOpenApiSchema = entryOpenApiSchema
  .extend({ visitType: visitTypeOpenApiSchema.optional() })
  .strict();
const loginOpenApiSchema = z.object({ email: emailSchema, password: z.string().min(1) }).strict();
const sessionOpenApiSchema = z.object({ sessionId: sessionIdSchema }).strict();
const verifyOtpOpenApiSchema = sessionOpenApiSchema.extend({ code: otpCodeSchema }).strict();
const profileOpenApiSchema = sessionOpenApiSchema
  .extend({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    gender: z.enum(["male", "female", "other"]),
    countryCode: countryCodeSchema,
    nationalNumber: nationalNumberSchema.optional(),
    phone: nationalNumberSchema.optional(),
    password: z.string().min(6),
    agreeTerms: z.boolean().optional(),
    termsVersion: z.string().min(1).optional(),
  })
  .strict();
const visitTypeOpenApiBodySchema = sessionOpenApiSchema
  .extend({ visitType: visitTypeOpenApiSchema })
  .strict();
const businessDetailsOpenApiSchema = sessionOpenApiSchema
  .extend({
    businessName: z.string().min(1),
    ownerName: z.string().min(1),
    city: z.enum(["Larnaca", "Limassol", "Nicosia", "Paphos"]),
    countryCode: countryCodeSchema,
    nationalNumber: nationalNumberSchema.optional(),
    mobileNumber: nationalNumberSchema.optional(),
    area: z.string().min(1),
    streetName: z.string().min(1),
    streetNumber: z.string().min(1),
    floorUnit: z.string().optional(),
    aptRoom: z.string().optional(),
    briefDesc: z.string().min(1),
    coordinates: z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
      })
      .optional(),
    searchQuery: z.string().optional(),
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
const categorySelectionOpenApiSchema = sessionOpenApiSchema
  .extend({
    selectedCategory: z.string().min(1),
    selectedSubcategories: z.array(z.string().min(1)).min(1).max(5),
  })
  .strict();
const progressQueryOpenApiSchema = z.object({ sessionId: sessionIdSchema });

const successEnvelope = (dataSchema: z.ZodType) =>
  z.object({
    success: z.literal(true),
    message: z.string(),
    data: dataSchema.optional(),
  });

const entryResponseSchema = z.object({
  nextStep: z.enum(["PASSWORD_LOGIN", "EMAIL_VERIFICATION", "PORTAL_MISMATCH"]),
  sessionId: z.string().optional(),
  currentStep: z.string().optional(),
});

const sessionStepResponseSchema = z.object({
  sessionId: z.string(),
  nextStep: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
});

const authResponseSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.string().datetime(),
  user: z.object({
    id: z.string(),
    email: z.string(),
    role: z.string(),
    status: z.string(),
  }),
  business: z
    .object({
      id: z.string(),
      status: z.string(),
    })
    .optional(),
});

const progressResponseSchema = z.object({
  sessionId: z.string(),
  portal: z.string(),
  intendedRole: z.string(),
  currentStep: z.string(),
  emailVerified: z.boolean(),
  phoneVerified: z.boolean(),
  expiresAt: z.string().datetime(),
});

const meResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    role: z.string(),
    status: z.string(),
    emailVerifiedAt: z.string().datetime().optional(),
    phoneVerifiedAt: z.string().datetime().optional(),
  }),
  profile: z
    .object({
      firstName: z.string(),
      lastName: z.string(),
      fullName: z.string(),
      gender: z.enum(["male", "female", "other"]),
      phone: z
        .object({
          countryCode: z.string(),
          nationalNumber: z.string(),
          e164: z.string(),
        })
        .optional(),
    })
    .nullable(),
  business: z
    .object({
      id: z.string(),
      name: z.string(),
      status: z.string(),
      visitType: z.enum(businessVisitTypes),
    })
    .nullable(),
});

type AuthPath = {
  method: "get" | "post";
  path: string;
  summary: string;
  description?: string;
  body?: z.ZodObject;
  query?: z.ZodObject;
  response: z.ZodType;
  status?: number;
};

const authPaths: AuthPath[] = [
  {
    method: "post",
    path: "/auth/customer/entry",
    summary: "Resolve customer portal entry",
    body: entryOpenApiSchema,
    response: entryResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/entry",
    summary: "Resolve professional portal entry",
    body: professionalEntryOpenApiSchema,
    response: entryResponseSchema,
  },
  {
    method: "post",
    path: "/auth/customer/login",
    summary: "Customer email/password login",
    body: loginOpenApiSchema,
    response: authResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/login",
    summary: "Professional email/password login",
    body: loginOpenApiSchema,
    response: authResponseSchema,
  },
  {
    method: "post",
    path: "/auth/super-admin/login",
    summary: "Super Admin email/password login",
    body: loginOpenApiSchema,
    response: authResponseSchema,
  },
  {
    method: "post",
    path: "/auth/customer/register/send-email-otp",
    summary: "Send customer email OTP",
    body: sessionOpenApiSchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/customer/register/resend-email-otp",
    summary: "Resend customer email OTP",
    body: sessionOpenApiSchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/customer/register/verify-email-otp",
    summary: "Verify customer email OTP",
    body: verifyOtpOpenApiSchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/customer/register/profile",
    summary: "Submit customer profile and password",
    body: profileOpenApiSchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/customer/register/send-phone-otp",
    summary: "Send customer phone OTP",
    body: sessionOpenApiSchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/customer/register/resend-phone-otp",
    summary: "Resend customer phone OTP",
    body: sessionOpenApiSchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/customer/register/verify-phone-otp-complete",
    summary: "Verify customer phone OTP and complete account",
    body: verifyOtpOpenApiSchema,
    response: authResponseSchema,
    status: 201,
  },
  {
    method: "get",
    path: "/auth/customer/register/progress",
    summary: "Get customer registration progress",
    query: progressQueryOpenApiSchema,
    response: progressResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/visit-type",
    summary: "Save Business Owner visit type",
    body: visitTypeOpenApiBodySchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/send-email-otp",
    summary: "Send professional email OTP",
    body: sessionOpenApiSchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/resend-email-otp",
    summary: "Resend professional email OTP",
    body: sessionOpenApiSchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/verify-email-otp",
    summary: "Verify professional email OTP",
    body: verifyOtpOpenApiSchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/profile",
    summary: "Submit Business Owner personal profile and password",
    body: profileOpenApiSchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/send-phone-otp",
    summary: "Send professional phone OTP",
    body: sessionOpenApiSchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/resend-phone-otp",
    summary: "Resend professional phone OTP",
    body: sessionOpenApiSchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/verify-phone-otp",
    summary: "Verify professional phone OTP",
    body: verifyOtpOpenApiSchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/business-details",
    summary: "Save Business Owner business details",
    body: businessDetailsOpenApiSchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/categories",
    summary: "Save Business Owner category selections",
    body: categorySelectionOpenApiSchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/complete",
    summary: "Complete Business Owner account and pending business",
    body: sessionOpenApiSchema,
    response: authResponseSchema,
    status: 201,
  },
  {
    method: "get",
    path: "/auth/professional/register/progress",
    summary: "Get professional registration progress",
    query: progressQueryOpenApiSchema,
    response: progressResponseSchema,
  },
  {
    method: "post",
    path: "/auth/refresh",
    summary: "Rotate refresh cookie and issue a new access token",
    description: "Reads the HttpOnly refresh cookie and returns only the access token in JSON.",
    response: authResponseSchema,
  },
  {
    method: "post",
    path: "/auth/logout",
    summary: "Revoke current refresh session and clear refresh cookie",
    response: z.object({}).strict(),
  },
  {
    method: "get",
    path: "/auth/me",
    summary: "Get the current authenticated user",
    response: meResponseSchema,
  },
];

export const registerAuthOpenApi = (registry: OpenAPIRegistry, apiVersion: string): void => {
  for (const authPath of authPaths) {
    const request = authPath.body
      ? {
          body: {
            content: {
              "application/json": {
                schema: authPath.body,
              },
            },
          },
          ...(authPath.query ? { query: authPath.query } : {}),
        }
      : authPath.query
        ? { query: authPath.query }
        : undefined;

    registry.registerPath({
      method: authPath.method,
      path: `/api/${apiVersion}${authPath.path}`,
      summary: authPath.summary,
      description:
        authPath.description ??
        "Uses the standard Bookly success/error envelope. Portal mismatch returns a stable PORTAL_MISMATCH error.",
      ...(request ? { request } : {}),
      responses: {
        [authPath.status ?? 200]: {
          description: authPath.summary,
          content: {
            "application/json": {
              schema: successEnvelope(authPath.response),
            },
          },
        },
        400: { description: "Validation or registration step error." },
        401: { description: "Invalid credentials, expired session, or missing access token." },
        409: { description: "Portal mismatch, duplicate email, or invalid step progression." },
        429: { description: "Rate limit or OTP policy limit exceeded." },
        503: { description: "Email or Twilio Verify provider is not configured." },
      },
    });
  }
};
