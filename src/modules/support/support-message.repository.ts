import { Types } from "mongoose";
import type { UserRole } from "../user/user.types.js";
import { type SupportMessageDocument, SupportMessageModel } from "./support-message.model.js";

export type CreateSupportMessageInput = {
  ticketId: Types.ObjectId;
  senderUserId: Types.ObjectId;
  senderRole: UserRole;
  message: string;
};

export type SupportMessagePagination = { page: number; limit: number };

export type SupportMessageHistoryPage = {
  limit: number;
  /** Exclusive upper bound: only messages strictly older than this `(createdAt, _id)` key. */
  before?: { createdAt: Date; id: string } | undefined;
};

export class SupportMessageRepository {
  public async create(input: CreateSupportMessageInput): Promise<SupportMessageDocument> {
    return new SupportMessageModel(input).save();
  }

  /** Deterministic order (createdAt then _id — see support-message.model.ts's own comment),
   * oldest-first, server-paginated so a long conversation is never fetched in one unbounded
   * request. */
  public async listByTicketId(
    ticketId: Types.ObjectId | string,
    pagination: SupportMessagePagination,
  ): Promise<{ messages: SupportMessageDocument[]; total: number }> {
    const filter = { ticketId };
    const skip = (pagination.page - 1) * pagination.limit;
    const [messages, total] = await Promise.all([
      SupportMessageModel.find(filter)
        .sort({ createdAt: 1, _id: 1 })
        .skip(skip)
        .limit(pagination.limit)
        .exec(),
      SupportMessageModel.countDocuments(filter).exec(),
    ]);
    return { messages, total };
  }

  /** P1.8 — newest-first keyset page over the existing `{ ticketId, createdAt, _id }` index
   * (walked in reverse; no new index). `_id` breaks createdAt ties, so identical timestamps never
   * duplicate or drop a message across page boundaries, and replies created after the cursor was
   * issued can never shift an older page. Returned oldest-first for chronological display; one
   * extra row is read only to learn whether older history exists. */
  public async listHistoryByTicketId(
    ticketId: Types.ObjectId,
    page: SupportMessageHistoryPage,
  ): Promise<{ messages: SupportMessageDocument[]; total: number; hasOlder: boolean }> {
    const baseFilter = { ticketId };
    const pageFilter = page.before
      ? {
          ticketId,
          $or: [
            { createdAt: { $lt: page.before.createdAt } },
            { createdAt: page.before.createdAt, _id: { $lt: new Types.ObjectId(page.before.id) } },
          ],
        }
      : baseFilter;
    const [rows, total] = await Promise.all([
      SupportMessageModel.find(pageFilter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(page.limit + 1)
        .exec(),
      SupportMessageModel.countDocuments(baseFilter).exec(),
    ]);
    const hasOlder = rows.length > page.limit;
    const messages = rows.slice(0, page.limit).reverse();
    return { messages, total, hasOlder };
  }
}
