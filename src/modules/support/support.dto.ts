import type { SupportMessageDocument } from "./support-message.model.js";
import type { SupportTicketDocument } from "./support-ticket.model.js";

/** The requester's own Ticket row/detail — no raw status-history actor ids (confirmed rule: "If
 * requester UI does not require raw status-history actor IDs, do not expose them" — only the
 * lifecycle shape itself is useful to a requester, never who on the Support side changed it). */
export type SupportTicketRequesterDto = {
  id: string;
  reference: string;
  subject: string;
  status: SupportTicketDocument["status"];
  businessId?: string | undefined;
  bookingId?: string | undefined;
  createdAt: string;
  updatedAt: string;
  statusHistory: Array<{
    previousStatus: SupportTicketDocument["status"] | null;
    resultingStatus: SupportTicketDocument["status"];
    createdAt: string;
  }>;
};

export const toRequesterTicketDto = (ticket: SupportTicketDocument): SupportTicketRequesterDto => ({
  id: String(ticket._id),
  reference: ticket.reference,
  subject: ticket.subject,
  status: ticket.status,
  businessId: ticket.businessId ? String(ticket.businessId) : undefined,
  bookingId: ticket.bookingId ? String(ticket.bookingId) : undefined,
  createdAt: ticket.createdAt.toISOString(),
  updatedAt: ticket.updatedAt.toISOString(),
  statusHistory: ticket.statusHistory.map((entry) => ({
    previousStatus: entry.previousStatus,
    resultingStatus: entry.resultingStatus,
    createdAt: entry.createdAt.toISOString(),
  })),
});

/** Shared by both the requester side and the Super Admin side — a message never carries
 * `senderUserId` in either DTO (not needed by either audience: the requester only needs to know
 * "from Support" vs "from me," which `senderRole === "SUPER_ADMIN"` already answers, and Super
 * Admin already knows the Ticket's own requesterUserId from the Ticket DTO itself). */
export type SupportMessageDto = {
  id: string;
  ticketId: string;
  senderRole: SupportMessageDocument["senderRole"];
  message: string;
  createdAt: string;
};

export const toSupportMessageDto = (message: SupportMessageDocument): SupportMessageDto => ({
  id: String(message._id),
  ticketId: String(message.ticketId),
  senderRole: message.senderRole,
  message: message.message,
  createdAt: message.createdAt.toISOString(),
});

/** Message-list envelope shared by requester and Super Admin reads. Legacy page reads keep their
 * exact `{ page, limit, total }` shape; P1.8 history reads report `{ limit, total }` plus the
 * opaque `olderCursor` for the next older page (null when the oldest message is loaded). */
export type SupportMessageListDto = {
  messages: SupportMessageDto[];
  pagination: { page?: number; limit: number; total: number };
  history?: { hasOlder: boolean; olderCursor: string | null };
};

export const toSupportMessageListDto = (
  result: {
    messages: SupportMessageDocument[];
    total: number;
    history?: { hasOlder: boolean; olderCursor: string | null } | undefined;
  },
  query: { mode: "page"; page: number; limit: number } | { mode: "history"; limit: number },
): SupportMessageListDto => ({
  messages: result.messages.map(toSupportMessageDto),
  ...(query.mode === "page"
    ? { pagination: { page: query.page, limit: query.limit, total: result.total } }
    : {
        pagination: { limit: query.limit, total: result.total },
        history: result.history ?? { hasOlder: false, olderCursor: null },
      }),
});

/** Super Admin's global inbox row — enriched with batched Business/requester lookups (see
 * super-admin-support.service.ts), never a raw User/Business document. */
export type SuperAdminSupportTicketRowDto = {
  id: string;
  reference: string;
  subject: string;
  status: SupportTicketDocument["status"];
  requesterUserId: string;
  requesterRole: SupportTicketDocument["requesterRole"];
  requesterDisplayName: string;
  requesterEmail: string;
  businessId?: string | undefined;
  businessName?: string | undefined;
  createdAt: string;
  updatedAt: string;
};

/** Ticket detail — the row fields plus the full status history (actor ROLE only, never a raw
 * actorUserId — same minimal-exposure reasoning as the requester DTO) and, when linked, minimal
 * Booking context (confirmed rule 21: reference/Business/status only, never payment data, never a
 * second Booking-detail screen). */
export type SuperAdminSupportTicketDetailDto = SuperAdminSupportTicketRowDto & {
  bookingId?: string | undefined;
  bookingReference?: string | undefined;
  bookingStatus?: string | undefined;
  statusHistory: Array<{
    action: SupportTicketDocument["statusHistory"][number]["action"];
    actorRole: SupportTicketDocument["statusHistory"][number]["actorRole"];
    previousStatus: SupportTicketDocument["status"] | null;
    resultingStatus: SupportTicketDocument["status"];
    createdAt: string;
  }>;
};
