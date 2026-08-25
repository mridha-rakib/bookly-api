import type { Types } from "mongoose";
import { SupportError } from "./support.errors.js";
import type { SupportTicketRequesterRole, SupportTicketStatus } from "./support.types.js";
import { generateSupportTicketReference } from "./support.utils.js";
import {
  type SupportTicketDocument,
  SupportTicketModel,
  type SupportTicketStatusHistoryEntry,
} from "./support-ticket.model.js";

export type CreateSupportTicketInput = {
  requesterUserId: Types.ObjectId;
  requesterRole: SupportTicketRequesterRole;
  businessId?: Types.ObjectId | undefined;
  bookingId?: Types.ObjectId | undefined;
  subject: string;
  historyEntry: SupportTicketStatusHistoryEntry;
};

export type SupportTicketPagination = { page: number; limit: number };

export type SupportAdminListFilter = {
  status?: SupportTicketStatus | undefined;
  q?: string | undefined;
};

const MAX_REFERENCE_ATTEMPTS = 5;

export class SupportTicketRepository {
  /** Collision-safe: generates a fresh reference and retries on a genuine Mongo E11000 against
   * the unique `reference` index (see support.utils.ts) — the same "generator doesn't guarantee
   * uniqueness, the write path retries" contract Booking's own reference generator documents. */
  public async create(input: CreateSupportTicketInput): Promise<SupportTicketDocument> {
    for (let attempt = 0; attempt < MAX_REFERENCE_ATTEMPTS; attempt += 1) {
      try {
        return await new SupportTicketModel({
          reference: generateSupportTicketReference(),
          requesterUserId: input.requesterUserId,
          requesterRole: input.requesterRole,
          businessId: input.businessId,
          bookingId: input.bookingId,
          subject: input.subject,
          status: "OPEN",
          statusHistory: [input.historyEntry],
        }).save();
      } catch (error) {
        if (!this.isDuplicateKeyError(error)) {
          throw error;
        }
      }
    }
    throw new SupportError("SUPPORT_REFERENCE_GENERATION_FAILED", 500);
  }

  public async findById(ticketId: Types.ObjectId | string): Promise<SupportTicketDocument | null> {
    return SupportTicketModel.findById(ticketId).exec();
  }

  /** Anti-enumeration: a Ticket belonging to a different requester is indistinguishable from an
   * unknown ticketId — same combined-filter convention as `BookingRepository.findByIdForCustomer`.
   * Used uniformly for all four requester roles (Q2: "My Tickets" is always requesterUserId-scoped,
   * never a shared per-Business inbox). */
  public async findByIdForRequester(
    ticketId: Types.ObjectId | string,
    requesterUserId: Types.ObjectId | string,
  ): Promise<SupportTicketDocument | null> {
    return SupportTicketModel.findOne({ _id: ticketId, requesterUserId }).exec();
  }

  public async listByRequester(
    requesterUserId: Types.ObjectId | string,
    pagination: SupportTicketPagination,
  ): Promise<{ tickets: SupportTicketDocument[]; total: number }> {
    const filter = { requesterUserId };
    const skip = (pagination.page - 1) * pagination.limit;
    const [tickets, total] = await Promise.all([
      SupportTicketModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pagination.limit)
        .exec(),
      SupportTicketModel.countDocuments(filter).exec(),
    ]);
    return { tickets, total };
  }

  /** Super Admin's global inbox. `q` is bounded to `reference` (exact-ish prefix match) and
   * `subject` (substring) — both stored directly on this collection, so both stay index-supported/
   * bounded without a cross-collection join (confirmed rule: no full-text search infrastructure,
   * only what's justified by the existing UI). Requester-name search is NOT implemented here — it
   * would require joining User/UserProfile per query with no index to back it; see the batch report
   * for this documented limitation rather than a fabricated behavior. */
  public async listForAdmin(
    filter: SupportAdminListFilter,
    pagination: SupportTicketPagination,
  ): Promise<{ tickets: SupportTicketDocument[]; total: number }> {
    const query: Record<string, unknown> = {};
    if (filter.status) query["status"] = filter.status;
    if (filter.q) {
      const escaped = filter.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(escaped, "i");
      query["$or"] = [{ reference: pattern }, { subject: pattern }];
    }

    const skip = (pagination.page - 1) * pagination.limit;
    const [tickets, total] = await Promise.all([
      SupportTicketModel.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pagination.limit)
        .exec(),
      SupportTicketModel.countDocuments(query).exec(),
    ]);
    return { tickets, total };
  }

  /** CAS transition — filtered on the ticket's CURRENT status matching one of `fromStatuses`, so
   * a concurrent second writer (two rapid status clicks, a stale retry) either loses cleanly
   * (returns null) or lands on a genuinely still-valid state. Used for both regular status changes
   * (a single-element `fromStatuses`) and Reopen (`["RESOLVED", "CLOSED"]`) — same primitive,
   * same guarantee, matching Review's `transitionStatus` / Business's `casUpdateStatus`. */
  public async transitionStatus(
    ticketId: Types.ObjectId | string,
    fromStatuses: SupportTicketStatus[],
    toStatus: SupportTicketStatus,
    historyEntry: SupportTicketStatusHistoryEntry,
  ): Promise<SupportTicketDocument | null> {
    return SupportTicketModel.findOneAndUpdate(
      { _id: ticketId, status: { $in: fromStatuses } },
      { $set: { status: toStatus }, $push: { statusHistory: historyEntry } },
      { returnDocument: "after" },
    ).exec();
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: number }).code === 11000
    );
  }
}
