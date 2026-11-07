import { z } from "zod";
import {
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_SUBJECT_MAX_LENGTH,
  supportTicketStatuses,
} from "./support.types.js";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const supportTicketIdParamsSchema = z.object({ ticketId: objectIdSchema }).strict();

// Never accepts requesterUserId/requesterRole/businessId — those are always server-derived from
// the authenticated actor (confirmed rule). bookingId is optional and re-verified server-side
// before ever being stored (see support.service.ts's verifyBookingLinkage).
export const createSupportTicketBodySchema = z
  .object({
    subject: z.string().trim().min(1).max(SUPPORT_SUBJECT_MAX_LENGTH),
    message: z.string().trim().min(1).max(SUPPORT_MESSAGE_MAX_LENGTH),
    bookingId: objectIdSchema.optional(),
  })
  .strict();

export const supportMessageBodySchema = z
  .object({ message: z.string().trim().min(1).max(SUPPORT_MESSAGE_MAX_LENGTH) })
  .strict();

const paginationQuerySchema = z.object({
  page: z.string().regex(/^\d+$/, "Invalid page").optional(),
  limit: z.string().regex(/^\d+$/, "Invalid limit").optional(),
});

export const listSupportTicketsQuerySchema = paginationQuerySchema.strict().transform((value) => ({
  page: value.page ? Math.max(1, Number(value.page)) : 1,
  limit: value.limit ? Math.min(50, Math.max(1, Number(value.limit))) : 20,
}));

/** P1.8 — opaque older-history cursor: `<createdAt epoch ms>_<message ObjectId>`, the exact
 * `(createdAt, _id)` sort key of the oldest message the caller already holds. */
const SUPPORT_MESSAGE_CURSOR_PATTERN = /^(\d{1,16})_([a-f\d]{24})$/i;

export type SupportMessageCursor = { createdAt: Date; id: string };

export const encodeSupportMessageCursor = (message: { createdAt: Date; _id: unknown }): string =>
  `${message.createdAt.getTime()}_${String(message._id)}`;

export const decodeSupportMessageCursor = (value: string): SupportMessageCursor | null => {
  const match = SUPPORT_MESSAGE_CURSOR_PATTERN.exec(value);
  if (!match) return null;
  const createdAt = new Date(Number(match[1]));
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: (match[2] as string).toLowerCase() };
};

export type ListSupportMessagesQuery =
  | { mode: "page"; page: number; limit: number }
  | { mode: "history"; limit: number; before?: SupportMessageCursor | undefined };

/** Two read shapes over the same collection/index:
 * - legacy `page`/`limit` (oldest-first offset pages) — kept unchanged for compatibility;
 * - P1.8 `history=latest` (optionally with `before=<cursor>`) — newest-first keyset pages, so a
 *   ticket opens on its latest messages and older history is fetched in bounded, stable pages
 *   that new replies never shift. `before` alone also selects history mode. */
export const listSupportMessagesQuerySchema = paginationQuerySchema
  .extend({
    history: z.literal("latest").optional(),
    before: z
      .string()
      .regex(SUPPORT_MESSAGE_CURSOR_PATTERN, "Invalid cursor")
      .refine((value) => decodeSupportMessageCursor(value) !== null, "Invalid cursor")
      .optional(),
  })
  .strict()
  .refine((value) => !(value.page && (value.history || value.before)), {
    message: "page cannot be combined with history cursors",
    path: ["page"],
  })
  .transform((value): ListSupportMessagesQuery => {
    const limit = value.limit ? Math.min(100, Math.max(1, Number(value.limit))) : 50;
    if (value.history || value.before) {
      return {
        mode: "history",
        limit,
        before: value.before ? (decodeSupportMessageCursor(value.before) ?? undefined) : undefined,
      };
    }
    return { mode: "page", page: value.page ? Math.max(1, Number(value.page)) : 1, limit };
  });

export const listAdminSupportTicketsQuerySchema = paginationQuerySchema
  .extend({
    status: z.enum(supportTicketStatuses).optional(),
    q: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .transform((value) => ({
    status: value.status,
    q: value.q,
    page: value.page ? Math.max(1, Number(value.page)) : 1,
    limit: value.limit ? Math.min(100, Math.max(1, Number(value.limit))) : 20,
  }));

// Reopen is a separate, dedicated endpoint for the RESOLVED/CLOSED -> OPEN edges specifically —
// this body carries every OTHER regular transition an Admin drives directly, including
// PENDING -> OPEN (see support.types.ts's SUPPORT_STATUS_TRANSITIONS graph: OPEN is a valid
// regular target from PENDING, just never from RESOLVED/CLOSED). The service's own transition
// table remains the authoritative gate — accepting "OPEN" here does not open a path from
// RESOLVED/CLOSED, since SUPPORT_STATUS_TRANSITIONS never allows that combination.
export const changeSupportTicketStatusBodySchema = z
  .object({ status: z.enum(["OPEN", "PENDING", "RESOLVED", "CLOSED"]) })
  .strict();

export type SupportTicketIdParams = z.infer<typeof supportTicketIdParamsSchema>;
export type CreateSupportTicketBody = z.infer<typeof createSupportTicketBodySchema>;
export type SupportMessageBody = z.infer<typeof supportMessageBodySchema>;
export type ListSupportTicketsQuery = z.infer<typeof listSupportTicketsQuerySchema>;
export type ListAdminSupportTicketsQuery = z.infer<typeof listAdminSupportTicketsQuerySchema>;
export type ChangeSupportTicketStatusBody = z.infer<typeof changeSupportTicketStatusBodySchema>;
