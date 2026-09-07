import { z } from "zod";

/**
 * `/auth/customer/oauth/apple/callback` is a `POST` (`response_mode=form_post`) — Apple sends the
 * fields in the urlencoded BODY, parsed by the global `express.urlencoded`. `id_token` is present
 * because we request `response_type=code id_token`; `user` is a JSON string only on the first
 * authorization. Not `.strict()`, every field optional — the controller turns anything missing
 * into a coarse `status=error` redirect for what is always a top-level browser navigation.
 */
export const customerAppleCallbackBodySchema = z.object({
  code: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  user: z.string().optional(),
  error: z.string().optional(),
});

export type CustomerAppleCallbackBody = z.infer<typeof customerAppleCallbackBodySchema>;
