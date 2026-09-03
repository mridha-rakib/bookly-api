import { z } from "zod";

import { countryCodeSchema, nationalNumberSchema } from "../auth/auth.schema.js";

/** `GET /auth/staff/invitation?token=` — the invitee's browser opening the invite link. */
export const staffInvitationTokenQuerySchema = z.object({
  token: z.string().min(1),
});

/** `POST /auth/staff/invitation/accept/password`. `role` is DELIBERATELY absent — it comes only
 * from the server-side invitation row, never the request. */
export const acceptStaffInvitationPasswordBodySchema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(6),
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    countryCode: countryCodeSchema.optional(),
    nationalNumber: nationalNumberSchema.optional(),
    agreeTerms: z.literal(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasCode = value.countryCode !== undefined;
    const hasNumber = value.nationalNumber !== undefined;
    if (hasCode !== hasNumber) {
      ctx.addIssue({
        code: "custom",
        path: ["nationalNumber"],
        message: "Provide both a country code and a phone number, or neither",
      });
    }
  });

/** `GET /auth/staff/invitation/oauth/google/start?token=`. */
export const staffInvitationGoogleStartQuerySchema = z.object({
  token: z.string().min(1),
});

/** `GET /auth/staff/invitation/oauth/google/callback` — Google appends extra params, so NOT
 * `.strict()`; every field is optional (a denied consent omits `code`). */
export const staffInvitationGoogleCallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
});

export type StaffInvitationTokenQuery = z.infer<typeof staffInvitationTokenQuerySchema>;
export type AcceptStaffInvitationPasswordBody = z.infer<
  typeof acceptStaffInvitationPasswordBodySchema
>;
export type StaffInvitationGoogleStartQuery = z.infer<typeof staffInvitationGoogleStartQuerySchema>;
export type StaffInvitationGoogleCallbackQuery = z.infer<
  typeof staffInvitationGoogleCallbackQuerySchema
>;
