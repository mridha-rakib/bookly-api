import mongoose, { type Types } from "mongoose";
import type { FaqAudience, FaqStatus } from "./content.types.js";
import { type FaqDocument, FaqModel } from "./faq.model.js";

export type CreateFaqInput = {
  question: string;
  answer: string;
  audience: FaqAudience;
  status: FaqStatus;
  order: number;
  createdByUserId: Types.ObjectId;
};

export type UpdateFaqInput = Partial<Pick<FaqDocument, "question" | "answer" | "status">>;

export class FaqRepository {
  public async create(input: CreateFaqInput): Promise<FaqDocument> {
    return new FaqModel(input).save();
  }

  public async findById(faqId: Types.ObjectId | string): Promise<FaqDocument | null> {
    return FaqModel.findById(faqId).exec();
  }

  /** Ordered ascending by the persisted `order`, `createdAt` as a stable tie-breaker. Optional
   * `status` filter is applied server-side (never in the caller). */
  public async listByAudience(
    audience: FaqAudience,
    filter: { status?: FaqStatus | undefined } = {},
  ): Promise<FaqDocument[]> {
    const query: Record<string, unknown> = { audience };
    if (filter.status) query["status"] = filter.status;
    return FaqModel.find(query).sort({ order: 1, createdAt: 1 }).exec();
  }

  /** Highest `order` currently used within an audience, or `null` when the audience is empty. */
  public async maxOrderForAudience(audience: FaqAudience): Promise<number | null> {
    const top = await FaqModel.findOne({ audience }).sort({ order: -1 }).select("order").exec();
    return top ? top.order : null;
  }

  public async update(
    faqId: Types.ObjectId | string,
    update: UpdateFaqInput,
  ): Promise<FaqDocument | null> {
    return FaqModel.findByIdAndUpdate(
      faqId,
      { $set: update },
      { returnDocument: "after", runValidators: true },
    ).exec();
  }

  public async delete(faqId: Types.ObjectId | string): Promise<void> {
    await FaqModel.deleteOne({ _id: faqId }).exec();
  }

  /**
   * Rewrites the whole `order` sequence for one audience to 0..n-1 in a single transaction, so a
   * partial failure can never leave the audience with duplicate or gapped ordering. `orderedIds`
   * is trusted to already be validated by the service (every id belongs to `audience`, exactly
   * once, and covers the audience completely); the `{ _id, audience }` filter on each write is a
   * second guard so a mismatched id simply matches nothing rather than corrupting another row.
   */
  public async reorder(audience: FaqAudience, orderedIds: string[]): Promise<void> {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await FaqModel.bulkWrite(
          orderedIds.map((id, index) => ({
            updateOne: {
              filter: { _id: id, audience },
              update: { $set: { order: index } },
            },
          })),
          { session, ordered: true },
        );
      });
    } finally {
      await session.endSession();
    }
  }
}
