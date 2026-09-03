import { z } from "zod";

/**
 * Google appends extra query params (`scope`, `authuser`, `hd`, `prompt`) alongside
 * `code`/`state`, so this is intentionally NOT `.strict()` — mirrors
 * linked-account.schema.ts's googleLinkCallbackQuerySchema. Every field is optional: a
 * user-denied consent comes back with `error` and no `code`, and a stale/hand-crafted link may
 * omit `state` — the controller turns each of those into a coarse `status=error` redirect rather
 * than a raw 400 for what is always a top-level browser navigation.
 */
export const customerGoogleCallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
});

export type CustomerGoogleCallbackQuery = z.infer<typeof customerGoogleCallbackQuerySchema>;
