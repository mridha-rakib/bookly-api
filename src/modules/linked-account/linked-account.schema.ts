import { z } from "zod";

/**
 * An OAuth provider's redirect appends extra query params (Google: `scope`, `authuser`, `hd`,
 * `prompt`; Facebook: `granted_scopes` etc.) alongside `code`/`state`, so this schema is
 * intentionally NOT `.strict()` — mirrors integration.schema.ts's
 * googleCalendarCallbackQuerySchema. `code` is optional because a user-denied consent comes back
 * with `error` and no `code`. The shape is identical for every provider, so both link callbacks
 * validate against it.
 */
export const linkCallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1),
  error: z.string().optional(),
});

/** @deprecated alias kept for existing imports — use {@link linkCallbackQuerySchema}. */
export const googleLinkCallbackQuerySchema = linkCallbackQuerySchema;
export const facebookLinkCallbackQuerySchema = linkCallbackQuerySchema;

/**
 * Apple's link callback is a cross-site `POST` (`response_mode=form_post`) — the fields arrive in
 * the urlencoded body, not the query. `id_token` is present because we request `response_type=code
 * id_token`; `user` is a JSON string sent only on the first authorization. Not `.strict()` and
 * every field optional — the controller turns anything missing into a `result=error` redirect.
 */
export const appleLinkCallbackBodySchema = z.object({
  code: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  user: z.string().optional(),
  error: z.string().optional(),
});

/**
 * Unlink re-verifies the current password (same precedent as changeMyPassword / the
 * contact-change flows). `.strict()` rejects any other field. Provider-agnostic — the route says
 * which provider is being unlinked.
 */
export const unlinkLinkedAccountBodySchema = z
  .object({
    currentPassword: z.string().min(1),
  })
  .strict();

/** @deprecated alias kept for existing imports — use {@link unlinkLinkedAccountBodySchema}. */
export const unlinkGoogleAccountBodySchema = unlinkLinkedAccountBodySchema;

export type LinkCallbackQuery = z.infer<typeof linkCallbackQuerySchema>;
export type GoogleLinkCallbackQuery = LinkCallbackQuery;
export type FacebookLinkCallbackQuery = LinkCallbackQuery;
export type AppleLinkCallbackBody = z.infer<typeof appleLinkCallbackBodySchema>;
export type UnlinkLinkedAccountBody = z.infer<typeof unlinkLinkedAccountBodySchema>;
export type UnlinkGoogleAccountBody = UnlinkLinkedAccountBody;
