/**
 * Batch 15B — Support & Issues. Confirmed rules (see the Batch 15B implementation spec, itself
 * anchored to the Batch 15A investigation): CUSTOMER/BUSINESS_OWNER/SUPERVISOR/STAFF may each
 * create and manage their OWN Support Tickets (no shared per-Business inbox — "My Tickets" is
 * always scoped by requesterUserId, uniformly across all four roles, matching Review's own
 * single-owner-scoping convention). SUPER_ADMIN manages every Ticket through one global inbox.
 * Exactly four statuses, no Priority/Category/Assignee/Attachments/Internal Notes (confirmed
 * out-of-scope list, section 2 of the spec).
 */

export const supportTicketStatuses = ["OPEN", "PENDING", "RESOLVED", "CLOSED"] as const;
export type SupportTicketStatus = (typeof supportTicketStatuses)[number];

/** The four authenticated roles confirmed eligible to use Support (Q2). SUPER_ADMIN is never a
 * requester — it is the sole responder. */
export const supportTicketRequesterRoles = [
  "CUSTOMER",
  "BUSINESS_OWNER",
  "SUPERVISOR",
  "STAFF",
] as const;
export type SupportTicketRequesterRole = (typeof supportTicketRequesterRoles)[number];

/** Status-history action kinds — append-only, mirrors Review.moderationHistory /
 * Business.statusHistory's established "action + actor + previous/resulting + timestamp" shape. */
export const supportTicketHistoryActions = ["CREATED", "STATUS_CHANGED", "REOPENED"] as const;
export type SupportTicketHistoryAction = (typeof supportTicketHistoryActions)[number];

/**
 * The controlled transition graph (Q5). The confirmed rule mandates "a controlled transition
 * model" and "explicit Reopen behavior" but does not pin the exact edges — Batch 15A's own
 * investigation report proposed this specific shape as its Q5 recommendation, and the Batch 15B
 * spec's Q5 section explicitly frames itself as adopting "the statuses established by the
 * existing design/investigation," so this is that adopted shape, made explicit here rather than
 * left implicit:
 *
 *   OPEN      -> PENDING, RESOLVED        (regular admin-driven status change)
 *   PENDING   -> OPEN, RESOLVED           (regular admin-driven status change)
 *   RESOLVED  -> CLOSED                   (regular admin-driven status change, "Close")
 *   CLOSED    -> (no regular transition)
 *
 *   RESOLVED  -> OPEN                     (Reopen only — a separate, explicit action)
 *   CLOSED    -> OPEN                     (Reopen only — a separate, explicit action)
 *
 * A reply is only accepted while status is OPEN or PENDING (see support.service.ts
 * `requireReplyable`) — RESOLVED/CLOSED both require an explicit Reopen first. Nothing ever
 * auto-reopens a ticket as a side effect of a reply (confirmed rule: "Do not silently auto-reopen
 * unless established by the confirmed lifecycle").
 */
export const SUPPORT_STATUS_TRANSITIONS: Record<SupportTicketStatus, SupportTicketStatus[]> = {
  OPEN: ["PENDING", "RESOLVED"],
  PENDING: ["OPEN", "RESOLVED"],
  RESOLVED: ["CLOSED"],
  CLOSED: [],
};

/** Statuses a Ticket may be Reopened FROM — the only path back to OPEN once RESOLVED/CLOSED. */
export const SUPPORT_REOPENABLE_FROM: SupportTicketStatus[] = ["RESOLVED", "CLOSED"];

/** Bounded, explicit choice — no exact number is evidenced in the existing mock UI (the reply
 * textarea has no maxLength), but "bounded message validation" is a confirmed requirement. 5000
 * chars comfortably fits a real support conversation message without being unbounded. */
export const SUPPORT_MESSAGE_MAX_LENGTH = 5000;

/** Ticket subject — same "bounded, no evidenced exact number" reasoning as the message length. */
export const SUPPORT_SUBJECT_MAX_LENGTH = 200;
