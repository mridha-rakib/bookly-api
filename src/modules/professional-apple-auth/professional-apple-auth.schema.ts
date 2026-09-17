import { z } from "zod";

/**
 * `/auth/professional/oauth/apple/start` — no query params required. Visit type is now a
 * post-phone-verification onboarding step, collected well after this OAuth round trip, so it no
 * longer needs to travel through the signed state (mirrors the Google/Facebook professional flows).
 */
export const professionalAppleStartQuerySchema = z.object({});

/**
 * `/auth/professional/oauth/apple/callback` — a `POST` (`response_mode=form_post`); fields in the
 * urlencoded body. Not `.strict()`, every field optional.
 */
export const professionalAppleCallbackBodySchema = z.object({
  code: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  user: z.string().optional(),
  error: z.string().optional(),
});

export type ProfessionalAppleStartQuery = z.infer<typeof professionalAppleStartQuerySchema>;
export type ProfessionalAppleCallbackBody = z.infer<typeof professionalAppleCallbackBodySchema>;
