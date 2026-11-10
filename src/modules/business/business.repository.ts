import type { ClientSession, Types } from "mongoose";
import {
  type PlatformReportingScope,
  reportingScopeMatch,
} from "../../common/reporting/platform-reporting-scope.js";
import { zeroFilledMonths } from "../../common/time/analytics-buckets.js";
import { BookingError } from "../booking/booking.errors.js";
import { BookingModel } from "../booking/booking.model.js";
import { BookingSlotReservationModel } from "../booking-slot-reservation/booking-slot-reservation.model.js";
import { BookingSlotReservationClaimModel } from "../booking-slot-reservation/booking-slot-reservation-claim.model.js";
import {
  assertBusinessPackageMode,
  withPackageEligibility,
} from "../package-progress/package-eligibility.js";
import { resolveBusinessCategoryKey } from "../platform-settings/business-category.js";
import { type BusinessDocument, BusinessModel } from "./business.model.js";
import type { BusinessStatus, BusinessVisitType } from "./business.types.js";

export type CreateBusinessInput = {
  ownerUserId: Types.ObjectId;
  name: string;
  ownerName: string;
  email: string;
  phone: {
    countryCode: string;
    nationalNumber: string;
    e164: string;
  };
  visitType: BusinessVisitType;
  /** Omitted by every current caller — the schema default (Europe/Nicosia) applies. Typed here
   * so a future onboarding step can supply it explicitly without a repository signature change. */
  timezone?: string;
  address: {
    city: string;
    area: string;
    streetName: string;
    streetNumber: string;
    floorUnit?: string | undefined;
    aptRoom?: string | undefined;
  };
  location?: {
    lat: number;
    lng: number;
    searchQuery?: string | undefined;
  };
  briefDescription: string;
  category: string;
  subcategories: string[];
  /** Canonical subcategory keys (see platform-settings/business-taxonomy.ts) — omitted by any
   * caller working from a legacy free-text draft that has none to offer. */
  subcategoryKeys?: string[] | undefined;
};

export class BusinessRepository {
  public async create(
    input: CreateBusinessInput,
    session?: ClientSession,
  ): Promise<BusinessDocument> {
    const categoryKey = resolveBusinessCategoryKey(input.category);
    return new BusinessModel({
      ...input,
      ...(categoryKey ? { categoryKey } : {}),
      status: "PENDING",
    }).save(session ? { session } : undefined);
  }

  public async findByOwnerUserId(
    ownerUserId: Types.ObjectId | string,
  ): Promise<BusinessDocument | null> {
    return BusinessModel.findOne({ ownerUserId }).exec();
  }

  public async findById(
    businessId: Types.ObjectId | string,
    session?: ClientSession,
  ): Promise<BusinessDocument | null> {
    return BusinessModel.findById(businessId)
      .session(session ?? null)
      .exec();
  }

  public async findManyByIds(
    businessIds: Array<Types.ObjectId | string>,
  ): Promise<BusinessDocument[]> {
    if (businessIds.length === 0) {
      return [];
    }

    return BusinessModel.find({ _id: { $in: businessIds } }).exec();
  }

  /** Batch 12 — Super Admin Recent Activity: newest-first Business creations, bounded. */
  public async findRecentlyCreated(limit: number): Promise<BusinessDocument[]> {
    return BusinessModel.find({}, { name: 1, createdAt: 1 })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
  }

  /** Batch 12 — Super Admin Recent Activity: the most-recently-changed Businesses (bounded by
   * `updatedAt`, which a statusHistory `$push` always bumps) — the feed reads each one's own
   * LATEST statusHistory entry, never the whole array, so this stays cheap regardless of how long
   * a given Business's audit trail has grown. */
  public async findRecentlyChanged(limit: number): Promise<BusinessDocument[]> {
    return BusinessModel.find(
      { "statusHistory.0": { $exists: true } },
      { name: 1, statusHistory: 1 },
    )
      .sort({ updatedAt: -1 })
      .limit(limit)
      .exec();
  }

  public async updateOwnedById(
    ownerUserId: Types.ObjectId | string,
    businessId: Types.ObjectId | string,
    update: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<BusinessDocument | null> {
    // Preserve the previous masked not-found result without disclosing dependency state.
    const owned = await BusinessModel.exists({ _id: businessId, ownerUserId }).session(
      session ?? null,
    );
    if (!owned) return null;
    return withPackageEligibility(businessId, session, async (transaction) => {
      const current = await BusinessModel.findOne({ _id: businessId, ownerUserId }).session(
        transaction,
      );
      if (!current) return null;
      if (update["timezone"] !== undefined && update["timezone"] !== current.timezone) {
        // Any durable history freezes the partition. Empty/released history is not unused.
        const claims = await BookingSlotReservationClaimModel.exists({ businessId })
          .session(transaction)
          .maxTimeMS(2000);
        const days = await BookingSlotReservationModel.exists({ businessId })
          .session(transaction)
          .maxTimeMS(2000);
        const bookings = await BookingModel.exists({ businessId })
          .session(transaction)
          .maxTimeMS(2000);
        if (claims || days || bookings) throw new BookingError("BOOKING_SCHEDULING_CHANGED", 409);
      }
      await assertBusinessPackageMode(businessId, update["visitType"], transaction);
      return BusinessModel.findOneAndUpdate(
        { _id: businessId, ownerUserId },
        { $set: update },
        { returnDocument: "after", runValidators: true, session: transaction },
      ).exec();
    });
  }

  /**
   * Batch 11 — the single write primitive every Business lifecycle transition (approve/
   * reject/suspend) composes from, mirroring BookingRepository.casUpdate exactly: a CAS
   * `findOneAndUpdate` gated on the Business's CURRENT status matching one of
   * `expectedStatuses`, so a concurrent second writer (e.g. two rapid Approve clicks) either
   * loses cleanly (returns null) or lands on a genuinely still-valid state — never a lost
   * update, never a corrupted lifecycle. Always appends one `statusHistory` entry.
   */
  public async casUpdateStatus(
    businessId: Types.ObjectId | string,
    expectedStatuses: BusinessStatus[],
    toStatus: BusinessStatus,
    historyEntry: {
      fromStatus: BusinessStatus;
      actorUserId: Types.ObjectId;
      reason?: string | undefined;
      changedAt: Date;
    },
    session?: ClientSession,
  ): Promise<BusinessDocument | null> {
    return BusinessModel.findOneAndUpdate(
      { _id: businessId, status: { $in: expectedStatuses } },
      {
        $set: { status: toStatus },
        $push: { statusHistory: { ...historyEntry, toStatus } },
      },
      { returnDocument: "after", runValidators: true, ...(session ? { session } : {}) },
    ).exec();
  }

  /** Super Admin-controlled Founding Partner flag — a plain attribute set (both directions),
   * not a lifecycle transition, so no CAS/statusHistory. Returns null when the id doesn't exist
   * (caller maps to 404). */
  public async setFoundingPartner(
    businessId: Types.ObjectId | string,
    isFoundingPartner: boolean,
  ): Promise<BusinessDocument | null> {
    return BusinessModel.findByIdAndUpdate(
      businessId,
      { $set: { isFoundingPartner } },
      { returnDocument: "after", runValidators: true },
    ).exec();
  }

  /** Batch 11 — Super Admin Business list: bounded, server-side paginated, filtered by the
   * `{status:1, createdAt:-1}` index. `q` (name/email/ownerName) is a best-effort
   * case-insensitive substring match — acceptable at this product's current Business volume;
   * never applied without the status/pagination bounds already narrowing the scan. */
  public async listForSuperAdmin(
    filter: {
      status?: BusinessStatus | undefined;
      visitType?: BusinessVisitType | undefined;
      city?: string | undefined;
      category?: string | undefined;
      q?: string | undefined;
    },
    pagination: { page: number; limit: number },
  ): Promise<{ businesses: BusinessDocument[]; total: number }> {
    const query: Record<string, unknown> = {};
    if (filter.status) query["status"] = filter.status;
    if (filter.visitType) query["visitType"] = filter.visitType;
    if (filter.city) query["address.city"] = filter.city;
    if (filter.category) query["category"] = filter.category;
    if (filter.q) {
      const escaped = filter.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(escaped, "i");
      query["$or"] = [{ name: pattern }, { email: pattern }, { ownerName: pattern }];
    }

    const skip = (pagination.page - 1) * pagination.limit;
    const [businesses, total] = await Promise.all([
      BusinessModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(pagination.limit).exec(),
      BusinessModel.countDocuments(query).exec(),
    ]);

    return { businesses, total };
  }

  /** Batch 11 — Businesses-tab counts (All/Approved/Pending/Warning/Suspended), one reduced
   * `$group` over the `{status:1}` index rather than N separate `countDocuments` calls. */
  public async countByStatus(
    scope?: PlatformReportingScope,
  ): Promise<Record<BusinessStatus, number>> {
    const rows = await BusinessModel.aggregate<{ _id: BusinessStatus; count: number }>([
      {
        $match: reportingScopeMatch(scope ? { businessIds: scope.businessIds } : undefined, {
          businessField: "_id",
        }),
      },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]).exec();

    const counts: Record<BusinessStatus, number> = {
      PENDING: 0,
      APPROVED: 0,
      WARNING: 0,
      SUSPENDED: 0,
    };
    for (const row of rows) {
      counts[row._id] = row.count;
    }
    return counts;
  }

  /** Batch 12 — Business Analytics "businesses created over time", monthly-bucketed on the
   * unfiltered `{createdAt:-1}` index. */
  public async countCreatedByMonth(
    from: Date,
    to: Date,
    timezone?: string,
    scope?: PlatformReportingScope,
  ): Promise<Array<{ year: number; month: number; count: number }>> {
    const rows = await BusinessModel.aggregate<{
      _id: { year: number; month: number };
      count: number;
    }>([
      {
        $match: {
          createdAt: { $gte: from, $lt: to },
          ...reportingScopeMatch(scope, { businessField: "_id" }),
        },
      },
      {
        $group: {
          _id: timezone
            ? {
                year: { $year: { date: "$createdAt", timezone } },
                month: { $month: { date: "$createdAt", timezone } },
              }
            : { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
    ]).exec();

    const countByKey = new Map(rows.map((row) => [`${row._id.year}-${row._id.month}`, row.count]));
    return zeroFilledMonths(from, to, timezone).map(({ year, month }) => ({
      year,
      month,
      count: countByKey.get(`${year}-${month}`) ?? 0,
    }));
  }

  /** P2.2.4 — the Super Admin City options: every distinct registered city (trimmed, exact
   * value — distinct spellings are never merged), alphabetical. Names only. */
  public async listRegisteredCities(): Promise<string[]> {
    const rows = await BusinessModel.aggregate<{ _id: string }>([
      { $project: { city: { $trim: { input: { $ifNull: ["$address.city", ""] } } } } },
      { $match: { city: { $ne: "" } } },
      { $group: { _id: "$city" } },
      { $sort: { _id: 1 } },
    ]).exec();
    return rows.map((row) => row._id);
  }

  /** P2.2.4 — ids of every Business (any status: past activity still belongs to its city)
   * registered in exactly this trimmed city. */
  public async findIdsByRegisteredCity(city: string): Promise<Types.ObjectId[]> {
    const rows = await BusinessModel.find(
      { $expr: { $eq: [{ $trim: { input: { $ifNull: ["$address.city", ""] } } }, city] } },
      { _id: 1 },
    )
      .lean<Array<{ _id: Types.ObjectId }>>()
      .exec();
    return rows.map((row) => row._id);
  }

  /** Current-state coverage, with the same trimmed city authority as the selector.
   * Empty/missing cities remain unassigned. Legacy visit-type aliases retain their meaning. */
  public async aggregateCityCoverage(): Promise<
    Array<{ city: string; premisesCount: number; mobileCount: number; approvedCount: number }>
  > {
    const rows = await BusinessModel.aggregate<{
      _id: string;
      premisesCount: number;
      mobileCount: number;
      approvedCount: number;
    }>([
      {
        $group: {
          _id: { $trim: { input: { $ifNull: ["$address.city", ""] } } },
          premisesCount: {
            $sum: { $cond: [{ $in: ["$visitType", ["AT_BUSINESS_LOCATION", "location"]] }, 1, 0] },
          },
          mobileCount: {
            $sum: { $cond: [{ $in: ["$visitType", ["TRAVEL_TO_CUSTOMER", "travel"]] }, 1, 0] },
          },
          approvedCount: {
            $sum: { $cond: [{ $in: ["$status", ["APPROVED", "WARNING"]] }, 1, 0] },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]).exec();

    return rows.map((row) => ({
      city: row._id,
      premisesCount: row.premisesCount,
      mobileCount: row.mobileCount,
      approvedCount: row.approvedCount,
    }));
  }
}
