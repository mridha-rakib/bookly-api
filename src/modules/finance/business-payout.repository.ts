import mongoose, { type ClientSession, type Types } from "mongoose";

import { type BusinessPayoutDocument, BusinessPayoutModel } from "./business-payout.model.js";

export type CreateBusinessPayoutInput = Omit<
  BusinessPayoutDocument,
  "_id" | "createdAt" | "updatedAt"
>;

export class BusinessPayoutRepository {
  /** Batch 8 — the real write path: BusinessPayoutService.executePayout inserts a payout INSIDE
   * the same Mongo transaction that claims its settled ledger rows (session required, not
   * optional — see that service's own comment on why the insert and the claim must be atomic
   * together). */
  public async create(
    input: CreateBusinessPayoutInput,
    session: ClientSession,
  ): Promise<BusinessPayoutDocument> {
    const [document] = await BusinessPayoutModel.create([input], { session });
    if (!document) {
      throw new Error("BusinessPayout insert returned no document");
    }
    return document;
  }

  public async listByBusinessId(input: {
    businessId: Types.ObjectId | string;
    page: number;
    limit: number;
  }): Promise<{ items: BusinessPayoutDocument[]; total: number }> {
    const filter = { businessId: input.businessId };
    const skip = (input.page - 1) * input.limit;
    const [items, total] = await Promise.all([
      BusinessPayoutModel.find(filter)
        .sort({ periodStart: -1 })
        .skip(skip)
        .limit(input.limit)
        .exec(),
      BusinessPayoutModel.countDocuments(filter).exec(),
    ]);
    return { items, total };
  }

  /** Batch 8 (Super Admin Finance) — the platform-wide payout history, newest first. */
  public async listAll(input: {
    page: number;
    limit: number;
  }): Promise<{ items: BusinessPayoutDocument[]; total: number }> {
    const skip = (input.page - 1) * input.limit;
    const [items, total] = await Promise.all([
      BusinessPayoutModel.find({}).sort({ createdAt: -1 }).skip(skip).limit(input.limit).exec(),
      BusinessPayoutModel.countDocuments({}).exec(),
    ]);
    return { items, total };
  }

  /** Finance Gap 01 — one Business's total recorded as paid (Super Admin attestations), with the
   * latest record time. Single reduced `$group` over the `{businessId, periodStart}` index. */
  public async sumPaidForBusiness(
    businessId: Types.ObjectId | string,
  ): Promise<{ totalCents: number; count: number; lastPaidAt: Date | undefined }> {
    const result = await BusinessPayoutModel.aggregate<{
      totalCents: number;
      count: number;
      lastPaidAt: Date | null;
    }>([
      { $match: { businessId: new mongoose.Types.ObjectId(String(businessId)), status: "PAID" } },
      {
        $group: {
          _id: null,
          totalCents: { $sum: "$netPayoutCents" },
          count: { $sum: 1 },
          lastPaidAt: { $max: "$paidAt" },
        },
      },
    ]).exec();
    return {
      totalCents: result[0]?.totalCents ?? 0,
      count: result[0]?.count ?? 0,
      lastPaidAt: result[0]?.lastPaidAt ?? undefined,
    };
  }

  /** Batch 8 (Super Admin Finance Stats — "Sent to businesses") — a single reduced sum, never a
   * raw dump; backed by the `{status, createdAt}` index. */
  public async sumPaidTotal(): Promise<{ totalCents: number; count: number }> {
    const result = await BusinessPayoutModel.aggregate<{ totalCents: number; count: number }>([
      { $match: { status: "PAID" } },
      { $group: { _id: null, totalCents: { $sum: "$netPayoutCents" }, count: { $sum: 1 } } },
    ]).exec();
    return { totalCents: result[0]?.totalCents ?? 0, count: result[0]?.count ?? 0 };
  }
}
