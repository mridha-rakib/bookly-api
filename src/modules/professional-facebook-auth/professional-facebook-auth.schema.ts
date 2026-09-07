import { z } from "zod";

import { visitTypeInputSchema } from "../auth/auth.schema.js";

/**
 * `/professional/oauth/facebook/start` — `visitType` is REQUIRED (mirrors the Google professional
 * flow): the existing Business Owner registration depends on it and there is no later step that
 * collects it. Accepts the canonical values and the `location`/`travel` aliases.
 */
export const professionalFacebookStartQuerySchema = z.object({
  visitType: visitTypeInputSchema,
});

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
