import { z } from "zod";

import { visitTypeInputSchema } from "../auth/auth.schema.js";

/**
 * `/auth/professional/oauth/apple/start` — `visitType` is REQUIRED (mirrors the Google/Facebook
 * professional flows): the existing Business Owner registration depends on it. Signed into the
 * state; NEVER read from the callback body.
 */
export const professionalAppleStartQuerySchema = z.object({
  visitType: visitTypeInputSchema,
});

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
