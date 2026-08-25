import type { Types } from "mongoose";
import type { UserRole } from "../user/user.types.js";
import { type SupportMessageDocument, SupportMessageModel } from "./support-message.model.js";

export type CreateSupportMessageInput = {
  ticketId: Types.ObjectId;
  senderUserId: Types.ObjectId;
  senderRole: UserRole;
  message: string;
};

export type SupportMessagePagination = { page: number; limit: number };

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
}
