import { z } from "zod";

/**
 * `/professional/oauth/facebook/start` — no query params required. Visit type is now a
 * post-phone-verification onboarding step, collected well after this OAuth round trip, so it no
 * longer needs to travel through the signed state (mirrors the Google professional flow).
 */
export const professionalFacebookStartQuerySchema = z.object({});

/**
 * `/professional/oauth/facebook/callback` — Facebook appends extra params, so this is NOT
 * `.strict()`. Every field is optional: a denied consent returns `error` and no `code`; a stale
 * link may omit `state`. The controller turns any of those into a coarse `status=error` redirect.
 */
export const professionalFacebookCallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
  error_reason: z.string().optional(),
  error_description: z.string().optional(),
});

export type ProfessionalFacebookStartQuery = z.infer<typeof professionalFacebookStartQuerySchema>;
export type ProfessionalFacebookCallbackQuery = z.infer<
  typeof professionalFacebookCallbackQuerySchema
>;
