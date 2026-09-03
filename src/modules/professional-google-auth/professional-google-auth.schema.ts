import { z } from "zod";

import { visitTypeInputSchema } from "../auth/auth.schema.js";

/**
 * `/professional/oauth/google/start` — `visitType` is REQUIRED: the existing Business Owner
 * registration depends on it, and there is no later step that collects it. Accepts the canonical
 * values and the `location`/`travel` aliases (transformed to canonical by `visitTypeInputSchema`).
 */
export const professionalGoogleStartQuerySchema = z.object({
  visitType: visitTypeInputSchema,
});

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
