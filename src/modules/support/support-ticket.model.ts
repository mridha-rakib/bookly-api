import { model, Schema, type Types } from "mongoose";
import type { UserRole } from "../user/user.types.js";
import {
  SUPPORT_SUBJECT_MAX_LENGTH,
  type SupportTicketHistoryAction,
  type SupportTicketRequesterRole,
  type SupportTicketStatus,
  supportTicketHistoryActions,
  supportTicketRequesterRoles,
  supportTicketStatuses,
} from "./support.types.js";

/**
 * Batch 15B — SupportTicket + SupportMessage as separate collections (confirmed rule: "Do not
 * embed an unbounded conversation array inside SupportTicket"). This is the Ticket header only —
 * see support-message.model.ts for the conversation.
 *
 * `businessId` is present only for BUSINESS_OWNER/SUPERVISOR/STAFF requesters — always
 * server-derived from the actor's own real ownership/membership at creation time, never accepted
 * from the client (see support.service.ts's `resolveBusinessContext`). `bookingId` is optional and
 * informational-only — verified server-side before ever being stored (see `verifyBookingLinkage`);
 * Support never mutates the referenced Booking.
 *
 * `statusHistory` is the same append-only, never-erased audit-array pattern this codebase already
 * uses for Review.moderationHistory / Business.statusHistory.
 */

export type SupportTicketStatusHistoryEntry = {
  action: SupportTicketHistoryAction;
  actorUserId: Types.ObjectId;
  actorRole: UserRole;
  previousStatus: SupportTicketStatus | null;
  resultingStatus: SupportTicketStatus;
  createdAt: Date;
};

export type SupportTicketDocument = {
  _id: Types.ObjectId;
  reference: string;
  requesterUserId: Types.ObjectId;
  requesterRole: SupportTicketRequesterRole;
  businessId?: Types.ObjectId | undefined;
  bookingId?: Types.ObjectId | undefined;
  subject: string;
  status: SupportTicketStatus;
  statusHistory: SupportTicketStatusHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
};

const supportTicketStatusHistoryEntrySchema = new Schema<SupportTicketStatusHistoryEntry>(
  {
    action: { type: String, enum: supportTicketHistoryActions, required: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    actorRole: { type: String, required: true },
    previousStatus: { type: String, enum: supportTicketStatuses, default: null },
    resultingStatus: { type: String, enum: supportTicketStatuses, required: true },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

const supportTicketSchema = new Schema<SupportTicketDocument>(
  {
    reference: { type: String, required: true, trim: true, uppercase: true },
    requesterUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    requesterRole: { type: String, enum: supportTicketRequesterRoles, required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business" },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking" },
    subject: { type: String, required: true, trim: true, maxlength: SUPPORT_SUBJECT_MAX_LENGTH },
    status: { type: String, enum: supportTicketStatuses, required: true, default: "OPEN" },
    statusHistory: { type: [supportTicketStatusHistoryEntrySchema], required: true, default: [] },
  },
  { timestamps: true },
);

// Human-facing identifier, must never collide (same backstop as Booking.reference).
supportTicketSchema.index({ reference: 1 }, { unique: true });
// "My Tickets" — a requester's own list, newest first (all four roles share this same shape).
supportTicketSchema.index({ requesterUserId: 1, createdAt: -1 });
// Super Admin's global (optionally status-filtered) moderation/inbox list.
supportTicketSchema.index({ status: 1, createdAt: -1 });

export const SupportTicketModel = model<SupportTicketDocument>(
  "SupportTicket",
  supportTicketSchema,
);
