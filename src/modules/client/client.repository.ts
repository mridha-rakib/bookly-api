import { type ClientSession, Types } from "mongoose";

import { type BusinessClientDocument, BusinessClientModel } from "./client.model.js";
import type { ClientLinkState, ClientTag } from "./client.types.js";
import { escapeRegExp } from "./client.utils.js";

export type CreateClientInput = Omit<
  BusinessClientDocument,
  "_id" | "createdAt" | "updatedAt" | "archivedAt"
>;

export type UpdateClientBusinessFields = Partial<
  Pick<
    BusinessClientDocument,
    | "firstName"
    | "lastName"
    | "normalizedEmail"
    | "phone"
    | "dateOfBirth"
    | "gender"
    | "address"
    | "notes"
    | "tag"
  >
>;

export type ClientListFilter = {
  archivedOnly: boolean;
  tag?: ClientTag | undefined;
  q?: string | undefined;
  page: number;
  limit: number;
};

export type ClientListResult = {
  clients: BusinessClientDocument[];
  total: number;
};

export type ClientStats = {
  total: number;
  newThisMonth: number;
};

export type LinkStateUpdate = {
  linkState: ClientLinkState;
  linkedUserId?: Types.ObjectId | undefined;
};

/**
 * No transactions anywhere in this repository: every write here is a single BusinessClient
 * document (creation/update/archive/restore/link-state), so MongoDB's per-document atomicity
 * plus the unique indexes on client.model.ts are the whole concurrency story — unlike Staff
 * creation (User + UserProfile + StaffMembership), a Client is never created alongside a
 * companion document.
 */
export class ClientRepository {
  public async create(
    input: CreateClientInput,
    session?: ClientSession,
  ): Promise<BusinessClientDocument> {
    return new BusinessClientModel(input).save(session ? { session } : undefined);
  }

  public async findById(
    businessId: Types.ObjectId | string,
    clientId: Types.ObjectId | string,
  ): Promise<BusinessClientDocument | null> {
    return BusinessClientModel.findOne({ _id: clientId, businessId }).exec();
  }

  /** A Customer's own Client row within one Business (Batch 3 self-booking) — relies on the
   * existing `{businessId, linkedUserId}` unique partial index (client.model.ts), so at most
   * one row can ever match. */
  public async findByBusinessIdAndLinkedUserId(
    businessId: Types.ObjectId | string,
    linkedUserId: Types.ObjectId | string,
  ): Promise<BusinessClientDocument | null> {
    return BusinessClientModel.findOne({ businessId, linkedUserId }).exec();
  }

  /**
   * Batch 4 — the ONLY writer of activation state. Atomically gated on `activatedAt` not
   * already being set (`$exists: false`), so a concurrent double-activation attempt (e.g. two
   * near-simultaneous finalize retries) can only ever win once — the loser's update matches
   * zero documents and returns null, which the caller (BookingCreationService) treats as
   * "already activated, nothing to do," never as an error. Never called from anywhere except
   * the moment an activation charge has genuinely succeeded.
   */
  public async markActivated(
    clientId: Types.ObjectId | string,
    bookingId: Types.ObjectId | string,
    session?: ClientSession,
  ): Promise<BusinessClientDocument | null> {
    return BusinessClientModel.findOneAndUpdate(
      { _id: clientId, activatedAt: { $exists: false } },
      { $set: { activatedAt: new Date(), activatedByBookingId: bookingId } },
      { returnDocument: "after", runValidators: true, ...(session ? { session } : {}) },
    ).exec();
  }

  public async listByBusinessId(
    businessId: Types.ObjectId | string,
    filter: ClientListFilter,
  ): Promise<ClientListResult> {
    const query: Record<string, unknown> = {
      businessId,
      archivedAt: filter.archivedOnly ? { $exists: true } : { $exists: false },
    };

    if (filter.tag) {
      query["tag"] = filter.tag;
    }

    if (filter.q) {
      const regex = new RegExp(escapeRegExp(filter.q.trim()), "i");
      query["$or"] = [
        { firstName: regex },
        { lastName: regex },
        { normalizedEmail: regex },
        { "phone.nationalNumber": regex },
        { "phone.e164": regex },
      ];
    }

    const skip = (filter.page - 1) * filter.limit;

    const [clients, total] = await Promise.all([
      BusinessClientModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(filter.limit).exec(),
      BusinessClientModel.countDocuments(query).exec(),
    ]);

    return { clients, total };
  }

  /** Total (non-archived) Clients and how many were created within the current calendar month. */
  public async getStats(businessId: Types.ObjectId | string): Promise<ClientStats> {
    const businessObjectId =
      typeof businessId === "string" ? new Types.ObjectId(businessId) : businessId;
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [total, newThisMonth] = await Promise.all([
      BusinessClientModel.countDocuments({
        businessId: businessObjectId,
        archivedAt: { $exists: false },
      }).exec(),
      BusinessClientModel.countDocuments({
        businessId: businessObjectId,
        archivedAt: { $exists: false },
        createdAt: { $gte: startOfMonth },
      }).exec(),
    ]);

    return { total, newThisMonth };
  }

  /** Scoped to non-archived Clients only — an archived Client must be restored before editing. */
  public async updateBusinessFields(
    businessId: Types.ObjectId | string,
    clientId: Types.ObjectId | string,
    fields: UpdateClientBusinessFields,
  ): Promise<BusinessClientDocument | null> {
    const setFields = this.stripUndefined(fields);

    if (Object.keys(setFields).length === 0) {
      return this.findById(businessId, clientId);
    }

    return BusinessClientModel.findOneAndUpdate(
      { _id: clientId, businessId, archivedAt: { $exists: false } },
      { $set: setFields },
      { returnDocument: "after", runValidators: true },
    ).exec();
  }

  public async archiveById(
    businessId: Types.ObjectId | string,
    clientId: Types.ObjectId | string,
  ): Promise<BusinessClientDocument | null> {
    return BusinessClientModel.findOneAndUpdate(
      { _id: clientId, businessId, archivedAt: { $exists: false } },
      { $set: { archivedAt: new Date() } },
      { returnDocument: "after" },
    ).exec();
  }

  /** Restores the Business relationship only — never touches linkState/linkedUserId. */
  public async restoreById(
    businessId: Types.ObjectId | string,
    clientId: Types.ObjectId | string,
  ): Promise<BusinessClientDocument | null> {
    return BusinessClientModel.findOneAndUpdate(
      { _id: clientId, businessId, archivedAt: { $exists: true } },
      { $unset: { archivedAt: "" } },
      { returnDocument: "after" },
    ).exec();
  }

  // --- Identity linking -----------------------------------------------------------------

  public async setLinkState(
    clientId: Types.ObjectId | string,
    update: LinkStateUpdate,
  ): Promise<BusinessClientDocument | null> {
    const unset: Record<string, unknown> = {};
    const set: Record<string, unknown> = { linkState: update.linkState };

    if (update.linkedUserId) {
      set["linkedUserId"] = update.linkedUserId;
    } else {
      unset["linkedUserId"] = "";
    }

    return BusinessClientModel.findOneAndUpdate(
      { _id: clientId },
      { $set: set, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) },
      { returnDocument: "after", runValidators: true },
    ).exec();
  }

  /**
   * Cross-business lookups used only by post customer-registration identity matching — never
   * scoped to a single Business, and deliberately does not filter by archivedAt (an archived
   * Client may still link; see client-identity.service.ts).
   */
  public async findUnlinkedByEmail(normalizedEmail: string): Promise<BusinessClientDocument[]> {
    return BusinessClientModel.find({ normalizedEmail, linkState: "UNLINKED" }).exec();
  }

  public async findUnlinkedByPhoneE164(phoneE164: string): Promise<BusinessClientDocument[]> {
    return BusinessClientModel.find({ "phone.e164": phoneE164, linkState: "UNLINKED" }).exec();
  }

  private stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
    const result: Partial<T> = {};
    for (const [key, val] of Object.entries(value)) {
      if (val !== undefined) {
        (result as Record<string, unknown>)[key] = val;
      }
    }
    return result;
  }
}
