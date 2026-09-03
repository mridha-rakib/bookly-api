import { z } from "zod";

/**
 * Google's redirect appends extra query params (`scope`, `authuser`, `hd`, `prompt`) alongside
 * `code`/`state`, so this schema is intentionally NOT `.strict()` — mirrors
 * integration.schema.ts's googleCalendarCallbackQuerySchema. `code` is optional because a
 * user-denied consent comes back with `error` and no `code`.
 */
export const googleLinkCallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1),
  error: z.string().optional(),
});

/**
 * Unlink re-verifies the current password (same precedent as changeMyPassword / the
 * contact-change flows). `.strict()` rejects any other field.
 */
export const unlinkGoogleAccountBodySchema = z
  .object({
    currentPassword: z.string().min(1),
  })
  .strict();

export type GoogleLinkCallbackQuery = z.infer<typeof googleLinkCallbackQuerySchema>;
export type UnlinkGoogleAccountBody = z.infer<typeof unlinkGoogleAccountBodySchema>;
