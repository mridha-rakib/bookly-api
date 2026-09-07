import { z } from "zod";

/**
 * Facebook appends `granted_scopes` / `denied_scopes` etc. alongside `code`/`state`, so this is
 * intentionally NOT `.strict()` — mirrors customerGoogleCallbackQuerySchema. Every field is
 * optional: a user-denied consent comes back with `error` and no `code`, and a stale/hand-crafted
 * link may omit `state` — the controller turns each of those into a coarse `status=error`
 * redirect rather than a raw 400 for what is always a top-level browser navigation.
 */
export const customerFacebookCallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
  error_reason: z.string().optional(),
  error_description: z.string().optional(),
});

export type CustomerFacebookCallbackQuery = z.infer<typeof customerFacebookCallbackQuerySchema>;
