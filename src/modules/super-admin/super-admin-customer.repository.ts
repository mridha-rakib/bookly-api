import { Types } from "mongoose";
import { env } from "../../config/env.js";
import { BookingModel } from "../booking/booking.model.js";
import { BusinessModel } from "../business/business.model.js";
import { BusinessClientModel } from "../client/client.model.js";
import { createFinancialRelationshipService } from "../client/financial-relationship.factory.js";
import { CustomerAvatarService } from "../customer-avatar/customer-avatar.service.js";
import { CustomerPaymentProfileModel } from "../payment/customer-payment-profile.model.js";
import { createDeferredStorageServiceFromEnv } from "../storage/storage.service.js";
import { CustomerProfileModel } from "../user/user.model.js";
import { UserRepository } from "../user/user.repository.js";

export class SuperAdminCustomerRepository {
  private readonly relationships = createFinancialRelationshipService();
  private readonly avatars = new CustomerAvatarService(
    new UserRepository(),
    createDeferredStorageServiceFromEnv(),
    { maxUploadBytes: env.CUSTOMER_AVATAR_MAX_UPLOAD_BYTES },
  );

  public async summaries(userIds: Types.ObjectId[]) {
    if (!userIds.length)
      return new Map<
        string,
        {
          businessCount: number;
          hasSavedCard: boolean;
          savedCard: { brand: string; last4: string } | null;
          avatarUrl?: string;
          address?: string;
        }
      >();
    const [counts, cards, profiles] = await Promise.all([
      BusinessClientModel.aggregate<{ _id: Types.ObjectId; count: number }>([
        { $match: { linkedUserId: { $in: userIds }, linkState: "LINKED" } },
        { $group: { _id: { userId: "$linkedUserId", businessId: "$businessId" } } },
        { $group: { _id: "$_id.userId", count: { $sum: 1 } } },
      ]).exec(),
      CustomerPaymentProfileModel.find(
        { userId: { $in: userIds } },
        { userId: 1, defaultPaymentMethodId: 1, cardBrand: 1, cardLast4: 1 },
      )
        .lean()
        .exec(),
      CustomerProfileModel.find({ userId: { $in: userIds } }, { userId: 1, avatar: 1, address: 1 })
        .lean()
        .exec(),
    ]);
    const countMap = new Map(counts.map((row) => [String(row._id), row.count]));
    const cardMap = new Map(cards.map((row) => [String(row.userId), row]));
    const profileMap = new Map(profiles.map((row) => [String(row.userId), row]));
    return new Map(
      await Promise.all(
        userIds.map(async (id) => {
          const card = cardMap.get(String(id)),
            profile = profileMap.get(String(id));
          const avatarUrl = await this.avatars.resolveAvatarUrl(profile);
          return [
            String(id),
            {
              businessCount: countMap.get(String(id)) ?? 0,
              hasSavedCard: Boolean(card?.defaultPaymentMethodId),
              savedCard:
                card?.defaultPaymentMethodId && card.cardLast4
                  ? { brand: card.cardBrand ?? "Card", last4: card.cardLast4 }
                  : null,
              ...(avatarUrl ? { avatarUrl } : {}),
              ...(profile?.address ? { address: profile.address } : {}),
            },
          ] as const;
        }),
      ),
    );
  }

  public async statistics(userId: string) {
    const rows = await BookingModel.aggregate<{ _id: string; count: number }>([
      { $match: { "customer.customerUserId": new Types.ObjectId(userId) } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]).exec();
    const counts = new Map(rows.map((row) => [row._id, row.count]));
    return {
      total: rows.reduce((sum, row) => sum + row.count, 0),
      completed: counts.get("COMPLETED") ?? 0,
      noShows: ["NO_SHOW_CHARGED", "NO_SHOW_WAIVED", "NO_SHOW_CANCELLED"].reduce(
        (sum, status) => sum + (counts.get(status) ?? 0),
        0,
      ),
      upcoming: (counts.get("UPCOMING") ?? 0) + (counts.get("PENDING") ?? 0),
    };
  }

  public async businessNames(ids: string[]) {
    const rows = await BusinessModel.find(
      { _id: { $in: [...new Set(ids)].map((id) => new Types.ObjectId(id)) } },
      { name: 1 },
    )
      .lean()
      .exec();
    return new Map(rows.map((row) => [String(row._id), row.name]));
  }

  public async listRelationships(userId: string, page: number, limit: number) {
    const match = { linkedUserId: new Types.ObjectId(userId), linkState: "LINKED" as const };
    const [rows, total] = await Promise.all([
      BusinessClientModel.find(match, {
        businessId: 1,
        financialRelationship: 1,
        activatedAt: 1,
        archivedAt: 1,
        notes: 1,
      })
        .sort({ businessId: 1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      BusinessClientModel.countDocuments(match).exec(),
    ]);
    const [names, lastBookings] = await Promise.all([
      this.businessNames(rows.map((row) => String(row.businessId))),
      BookingModel.aggregate<{ _id: Types.ObjectId; startAt: Date; timezone: string }>([
        {
          $match: {
            "customer.customerUserId": new Types.ObjectId(userId),
            "customer.businessClientId": { $in: rows.map((row) => row._id) },
          },
        },
        { $sort: { "schedule.startAt": -1, _id: -1 } },
        {
          $group: {
            _id: "$customer.businessClientId",
            startAt: { $first: "$schedule.startAt" },
            timezone: { $first: "$schedule.timezone" },
          },
        },
      ]).exec(),
    ]);
    const last = new Map(lastBookings.map((row) => [String(row._id), row]));
    return {
      relationships: rows.map((row) => {
        const latest = last.get(String(row._id));
        return {
          id: String(row._id),
          businessId: String(row.businessId),
          businessName: names.get(String(row.businessId)) ?? "Unavailable business",
          classification: this.relationships.peekClassification(row),
          financialState: row.financialRelationship?.state ?? null,
          archived: Boolean(row.archivedAt),
          lastBooking: latest
            ? {
                startAt: latest.startAt.toISOString(),
                timezone: latest.timezone,
              }
            : null,
          notes: row.notes ?? null,
        };
      }),
      pagination: { page, limit, total },
    };
  }
}
