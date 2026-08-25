import { model, Schema, type Types } from "mongoose";
import type { UserRole } from "../user/user.types.js";
import { SUPPORT_MESSAGE_MAX_LENGTH } from "./support.types.js";

/**
 * Batch 15B — one row per conversation message, referencing its Ticket by `ticketId` (never
 * embedded — see support-ticket.model.ts's own comment). `senderRole` is any of the four
 * requester roles OR "SUPER_ADMIN" — a message's own author is always exactly the Ticket's
 * requester or a Super Admin (no shared-inbox/multi-agent model in this batch), so a public/
 * requester-facing DTO can safely infer "from Support" vs "from you" purely from
 * `senderRole === "SUPER_ADMIN"`, without ever needing to expose `senderUserId` to the requester
 * (see support.dto.ts).
 *
 * No `updatedAt` — messages are never edited (no edit feature is confirmed), so a mutation
 * timestamp would be meaningless; `timestamps: { createdAt: true, updatedAt: false }` keeps only
 * what's real.
 */
export type SupportMessageDocument = {
  _id: Types.ObjectId;
  ticketId: Types.ObjectId;
  senderUserId: Types.ObjectId;
  senderRole: UserRole;
  message: string;
  createdAt: Date;
};

const supportMessageSchema = new Schema<SupportMessageDocument>(
  {
    ticketId: { type: Schema.Types.ObjectId, ref: "SupportTicket", required: true },
    senderUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    senderRole: { type: String, required: true },
    message: { type: String, required: true, trim: true, maxlength: SUPPORT_MESSAGE_MAX_LENGTH },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Conversation read, oldest-first, paginated — the one query shape this collection ever serves.
// `_id` as a trailing tie-breaker gives a deterministic order even for two messages created within
// the same millisecond (ObjectId is monotonically increasing, so this never reorders real writes).
supportMessageSchema.index({ ticketId: 1, createdAt: 1, _id: 1 });

export const SupportMessageModel = model<SupportMessageDocument>(
  "SupportMessage",
  supportMessageSchema,
);
