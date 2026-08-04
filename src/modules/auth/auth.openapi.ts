import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import {
  businessDetailsBodySchema,
  categorySelectionBodySchema,
  entryBodySchema,
  loginBodySchema,
  professionalEntryBodySchema,
  profileBodySchema,
  progressQuerySchema,
  sessionBodySchema,
  verifyEmailOtpBodySchema,
  verifyPhoneOtpBodySchema,
  visitTypeBodySchema,
} from "./auth.schema.js";

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
  profile: z.unknown().nullable(),
  business: z.unknown().nullable(),
});

type AuthPath = {
  method: "get" | "post";
  path: string;
  summary: string;
  description?: string;
  body?: z.ZodType;
  query?: z.ZodType;
  response: z.ZodType;
  status?: number;
};

const authPaths: AuthPath[] = [
  {
    method: "post",
    path: "/auth/customer/entry",
    summary: "Resolve customer portal entry",
    body: entryBodySchema,
    response: entryResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/entry",
    summary: "Resolve professional portal entry",
    body: professionalEntryBodySchema,
    response: entryResponseSchema,
  },
  {
    method: "post",
    path: "/auth/customer/login",
    summary: "Customer email/password login",
    body: loginBodySchema,
    response: authResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/login",
    summary: "Professional email/password login",
    body: loginBodySchema,
    response: authResponseSchema,
  },
  {
    method: "post",
    path: "/auth/super-admin/login",
    summary: "Super Admin email/password login",
    body: loginBodySchema,
    response: authResponseSchema,
  },
  {
    method: "post",
    path: "/auth/customer/register/send-email-otp",
    summary: "Send customer email OTP",
    body: sessionBodySchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/customer/register/resend-email-otp",
    summary: "Resend customer email OTP",
    body: sessionBodySchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/customer/register/verify-email-otp",
    summary: "Verify customer email OTP",
    body: verifyEmailOtpBodySchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/customer/register/profile",
    summary: "Submit customer profile and password",
    body: profileBodySchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/customer/register/send-phone-otp",
    summary: "Send customer phone OTP",
    body: sessionBodySchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/customer/register/resend-phone-otp",
    summary: "Resend customer phone OTP",
    body: sessionBodySchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/customer/register/verify-phone-otp-complete",
    summary: "Verify customer phone OTP and complete account",
    body: verifyPhoneOtpBodySchema,
    response: authResponseSchema,
    status: 201,
  },
  {
    method: "get",
    path: "/auth/customer/register/progress",
    summary: "Get customer registration progress",
    query: progressQuerySchema,
    response: progressResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/visit-type",
    summary: "Save Business Owner visit type",
    body: visitTypeBodySchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/send-email-otp",
    summary: "Send professional email OTP",
    body: sessionBodySchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/resend-email-otp",
    summary: "Resend professional email OTP",
    body: sessionBodySchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/verify-email-otp",
    summary: "Verify professional email OTP",
    body: verifyEmailOtpBodySchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/profile",
    summary: "Submit Business Owner personal profile and password",
    body: profileBodySchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/send-phone-otp",
    summary: "Send professional phone OTP",
    body: sessionBodySchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/resend-phone-otp",
    summary: "Resend professional phone OTP",
    body: sessionBodySchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/verify-phone-otp",
    summary: "Verify professional phone OTP",
    body: verifyPhoneOtpBodySchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/business-details",
    summary: "Save Business Owner business details",
    body: businessDetailsBodySchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/categories",
    summary: "Save Business Owner category selections",
    body: categorySelectionBodySchema,
    response: sessionStepResponseSchema,
  },
  {
    method: "post",
    path: "/auth/professional/register/complete",
    summary: "Complete Business Owner account and pending business",
    body: sessionBodySchema,
    response: authResponseSchema,
    status: 201,
  },
  {
    method: "get",
    path: "/auth/professional/register/progress",
    summary: "Get professional registration progress",
    query: progressQuerySchema,
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
    response: z.undefined(),
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
    const request = {
      ...(authPath.body
        ? {
            body: {
              content: {
                "application/json": {
                  schema: authPath.body,
                },
              },
            },
          }
        : {}),
      ...(authPath.query ? { query: authPath.query } : {}),
    };

    registry.registerPath({
      method: authPath.method,
      path: `/api/${apiVersion}${authPath.path}`,
      summary: authPath.summary,
      description:
        authPath.description ??
        "Uses the standard Bookly success/error envelope. Portal mismatch returns a stable PORTAL_MISMATCH error.",
      request: request as never,
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
        503: { description: "Resend or Twilio Verify provider is not configured." },
      },
    });
  }
};
