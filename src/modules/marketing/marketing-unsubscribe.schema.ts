import { z } from "zod";

/**
 * Marketing Email Stage M2 — public unsubscribe request.
 *
 * The token may arrive EITHER in the JSON body (`{ "token": "..." }`, the web-app confirmation
 * page) OR as a `?token=` query param with a form-encoded `List-Unsubscribe=One-Click` body (the
 * RFC 8058 one-click POST from a mail provider). Both parts are therefore lenient here and the
 * controller requires exactly one usable token; a missing/blank token is the same generic
 * "invalid link" failure as a bad one (no separate 400 shape to probe).
 */
export const marketingUnsubscribeBodySchema = z
  .object({
    // Deliberately NOT `.min(1)` — a blank/missing token is funnelled to the SAME generic
    // "invalid link" failure in the controller as a malformed one, so there is only ever one
    // failure shape to observe. `.max` is just an abuse bound.
    token: z.string().max(4096).optional(),
    // RFC 8058 one-click POSTs send this form field; accept and ignore it.
    "List-Unsubscribe": z.string().max(256).optional(),
  })
  .passthrough();

export const marketingUnsubscribeQuerySchema = z.object({
  token: z.string().max(4096).optional(),
});

export type MarketingUnsubscribeBody = z.infer<typeof marketingUnsubscribeBodySchema>;
export type MarketingUnsubscribeQuery = z.infer<typeof marketingUnsubscribeQuerySchema>;
