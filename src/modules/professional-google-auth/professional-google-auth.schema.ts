import { z } from "zod";

/**
 * `/professional/oauth/google/start` — no query params required. Visit type is now a
 * post-phone-verification onboarding step (`/auth/professional/register/visit-type`), collected
 * well after this OAuth round trip, so it no longer needs to travel through the signed state.
 */
export const professionalGoogleStartQuerySchema = z.object({});

/**
 * `/professional/oauth/google/callback` — Google appends extra params (`scope`, `authuser`, …),
 * so this is NOT `.strict()`. Every field is optional: a denied consent returns `error` and no
 * `code`; a stale link may omit `state`. The controller turns any of those into a coarse
 * `status=error` redirect rather than a raw 400 for what is always a top-level navigation.
 */
export const professionalGoogleCallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
});

export type ProfessionalGoogleStartQuery = z.infer<typeof professionalGoogleStartQuerySchema>;
export type ProfessionalGoogleCallbackQuery = z.infer<typeof professionalGoogleCallbackQuerySchema>;
